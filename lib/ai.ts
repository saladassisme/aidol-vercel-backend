import { requiredEnv, optionalEnv } from './env';

export type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string };

export type ChatReplyPayload = {
  reply: string;
  translation_zh: string;
  romanization: string;
  vocabulary_notes: Array<{
    term: string;
    romanization?: string;
    explanation_zh: string;
  }>;
};

export async function generateChatReply(params: {
  persona: string;
  nickname: string;
  messages: ChatMessage[];
}) {
  const baseURL = requiredEnv('AI_API_BASE_URL').replace(/\/$/, '');
  const apiKey = requiredEnv('AI_API_KEY');
  const model = optionalEnv('AI_TEXT_MODEL', 'gpt-4o-mini');

  const system = buildSystemPrompt(params.persona, params.nickname);
  const rawContent = await requestChatCompletion({
    baseURL,
    apiKey,
    model,
    messages: [{ role: 'system', content: system }, ...params.messages.slice(-12)],
    preferJsonMode: true,
    temperature: 0.75
  });

  const parsed = parseStructuredReply(rawContent);
  if (parsed) return parsed;

  const repaired = await requestChatCompletion({
    baseURL,
    apiKey,
    model,
    messages: [
      {
        role: 'system',
        content:
          'Convert the assistant draft into JSON only. Schema: {"reply":"Korean","translation_zh":"Chinese","romanization":"Latin Korean romanization","vocabulary_notes":[{"term":"","romanization":"","explanation_zh":""}]}. No markdown.'
      },
      { role: 'user', content: rawContent }
    ],
    preferJsonMode: true,
    temperature: 0.2
  });

  const repairedParsed = parseStructuredReply(repaired);
  if (repairedParsed) return repairedParsed;

  throw new Error('AI provider returned non-JSON content.');
}

function buildSystemPrompt(persona: string, nickname: string) {
  return `You are generating a reply for an idol-style private chat simulation.

Character nickname (display only): ${nickname}

Persona:
${persona}

Output rules:
- Return a single JSON object only.
- Do not wrap JSON in markdown code fences.
- Schema:
{
  "reply": "Korean original message only",
  "translation_zh": "Simplified Chinese translation (must contain Chinese characters)",
  "romanization": "Korean pronunciation in Latin letters only",
  "vocabulary_notes": [
    {"term":"Korean word","romanization":"Latin","explanation_zh":"Chinese explanation"}
  ]
}
- reply must be Korean only.
- translation_zh is required and must not be empty.
- romanization is required.
- Include 2 to 5 vocabulary_notes from the Korean reply.`;
}

async function requestChatCompletion(params: {
  baseURL: string;
  apiKey: string;
  model: string;
  messages: ChatMessage[];
  preferJsonMode?: boolean;
  temperature: number;
}) {
  const attempt = async (useJsonMode: boolean) => {
    const body: Record<string, unknown> = {
      model: params.model,
      temperature: params.temperature,
      messages: params.messages
    };
    if (useJsonMode) body.response_format = { type: 'json_object' };

    const response = await fetch(`${params.baseURL}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${params.apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });

    const text = await response.text();
    return { response, text };
  };

  let { response, text } = await attempt(Boolean(params.preferJsonMode));
  if (!response.ok && params.preferJsonMode && shouldRetryWithoutJsonMode(response.status, text)) {
    ({ response, text } = await attempt(false));
  }
  if (!response.ok) throw new Error(`AI provider failed: HTTP ${response.status} ${text}`);

  let envelope: { choices?: Array<{ message?: { content?: string } }> };
  try {
    envelope = JSON.parse(text);
  } catch {
    throw new Error(`AI provider returned invalid envelope: ${text.slice(0, 200)}`);
  }

  const content = envelope.choices?.[0]?.message?.content?.trim();
  if (!content) throw new Error('AI provider returned empty content.');
  return content;
}

function shouldRetryWithoutJsonMode(status: number, body: string) {
  if (status !== 400 && status !== 422) return false;
  const lower = body.toLowerCase();
  return lower.includes('response_format') || lower.includes('json_object') || lower.includes('unsupported');
}

function parseStructuredReply(rawContent: string): ChatReplyPayload | null {
  const cleaned = stripMarkdownCodeFence(rawContent);
  const jsonCandidate = extractFirstJSONObject(cleaned) ?? cleaned;

  let decoded: Record<string, unknown> | null = null;
  try {
    decoded = JSON.parse(jsonCandidate) as Record<string, unknown>;
  } catch {
    decoded = null;
  }

  if (decoded) {
    const normalized = normalizeReplyObject(decoded);
    if (normalized) return normalized;
  }

  return parseLooseThreePartReply(cleaned);
}

function normalizeReplyObject(value: Record<string, unknown>): ChatReplyPayload | null {
  const reply = pickString(value, ['reply', 'original', 'original_ko', 'korean', 'text', 'message']);
  if (!reply) return null;

  const translation_zh =
    pickString(value, ['translation_zh', 'translation', 'chinese', 'zh', 'zh_cn', 'chinese_translation']) ?? '';
  const romanization =
    pickString(value, ['romanization', 'romaja', 'romanized', 'pronunciation', 'latin']) ?? '';

  const rawNotes = value.vocabulary_notes ?? value.vocab_notes ?? value.notes ?? value.word_notes;
  const vocabulary_notes = sanitizeVocabularyNotes(rawNotes);

  return {
    reply: sanitizeKoreanReply(reply),
    translation_zh: translation_zh.trim(),
    romanization: sanitizeRomanization(romanization),
    vocabulary_notes
  };
}

function sanitizeVocabularyNotes(raw: unknown) {
  if (!Array.isArray(raw)) return [];

  const notes: ChatReplyPayload['vocabulary_notes'] = [];
  const seen = new Set<string>();

  for (const item of raw) {
    if (typeof item === 'string') {
      const parsed = parseNoteLine(item);
      if (parsed && !seen.has(parsed.term)) {
        seen.add(parsed.term);
        notes.push(parsed);
      }
      continue;
    }
    if (!item || typeof item !== 'object') continue;
    const obj = item as Record<string, unknown>;
    const term = pickString(obj, ['term', 'word', 'phrase', 'korean', 'text']) ?? '';
    const explanation_zh =
      pickString(obj, ['explanation_zh', 'explanation', 'meaning', 'meaning_zh', 'zh', 'note', 'usage']) ?? '';
    const romanization = pickString(obj, ['romanization', 'romaja', 'pronunciation', 'reading', 'latin']) ?? '';
    if (!term || !explanation_zh || seen.has(term)) continue;
    seen.add(term);
    notes.push({ term, romanization, explanation_zh });
  }

  return notes.slice(0, 6);
}

function parseNoteLine(line: string) {
  const separators = ['：', ':', ' - ', ' — '];
  for (const separator of separators) {
    if (!line.includes(separator)) continue;
    const parts = line.split(separator);
    const term = parts[0]?.trim() ?? '';
    const explanation_zh = parts.slice(1).join(separator).trim();
    if (term && explanation_zh) return { term, romanization: '', explanation_zh };
  }
  return null;
}

function parseLooseThreePartReply(rawText: string): ChatReplyPayload | null {
  const lines = stripMarkdownCodeFence(rawText)
    .split(/\r?\n/)
    .map((line) => stripKnownPrefix(line.trim()))
    .filter(Boolean);

  if (lines.length === 0) return null;

  const replyLines = lines.filter((line) => containsHangul(line));
  const translationLines = lines.filter((line) => containsChinese(line) && !containsHangul(line));
  const romanizationLines = lines.filter(
    (line) => containsLatin(line) && !containsChinese(line) && !containsHangul(line)
  );

  if (replyLines.length === 0) return null;

  return {
    reply: sanitizeKoreanReply(replyLines.join('\n')),
    translation_zh: translationLines.join('\n'),
    romanization: sanitizeRomanization(romanizationLines.join('\n')),
    vocabulary_notes: []
  };
}

function pickString(obj: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function sanitizeKoreanReply(text: string) {
  return text
    .split(/\r?\n/)
    .map((line) => stripKnownPrefix(line.trim()))
    .filter((line) => line && (containsHangul(line) || !containsChinese(line)))
    .join('\n')
    .trim();
}

function sanitizeRomanization(text: string) {
  return text
    .split(/\r?\n/)
    .map((line) => stripKnownPrefix(line.trim()))
    .filter((line) => line && containsLatin(line) && !containsChinese(line) && !containsHangul(line))
    .join('\n')
    .trim();
}

function stripKnownPrefix(text: string) {
  const prefixes = [
    'reply:', 'Reply:', 'translation_zh:', 'Translation:',
    'romanization:', 'Romanization:', '原文:', '原文：', '中文:', '中文：', '翻译:', '翻译：'
  ];
  let result = text;
  let changed = true;
  while (changed) {
    changed = false;
    for (const prefix of prefixes) {
      if (result.startsWith(prefix)) {
        result = result.slice(prefix.length).trim();
        changed = true;
        break;
      }
    }
  }
  return result;
}

function containsHangul(text: string) {
  return /[\uAC00-\uD7AF]/.test(text);
}

function containsChinese(text: string) {
  return /[\u3400-\u9FFF]/.test(text);
}

function containsLatin(text: string) {
  return /[A-Za-z]/.test(text);
}

function stripMarkdownCodeFence(text: string) {
  let result = text.trim();
  if (!result.startsWith('```')) return result;
  result = result.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```$/i, '').trim();
  return result;
}

function extractFirstJSONObject(text: string) {
  const trimmed = text.trim();
  const start = trimmed.indexOf('{');
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < trimmed.length; i += 1) {
    const ch = trimmed[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return trimmed.slice(start, i + 1);
    }
  }
  return null;
}
