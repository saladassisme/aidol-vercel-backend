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
    preferJsonMode: false,
    temperature: 0.75
  });

  const ctx = { baseURL, apiKey, model };

  const parsed = parseStructuredReply(rawContent);
  if (parsed) return ensureReplyCompleteness(parsed, ctx);

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
    preferJsonMode: false,
    temperature: 0.2
  });

  const repairedParsed = parseStructuredReply(repaired);
  if (repairedParsed) return ensureReplyCompleteness(repairedParsed, ctx);

  throw new Error('AI provider returned non-JSON content.');
}

async function ensureReplyCompleteness(
  reply: ChatReplyPayload,
  ctx: { baseURL: string; apiKey: string; model: string }
): Promise<ChatReplyPayload> {
  const result: ChatReplyPayload = {
    ...reply,
    vocabulary_notes: [...reply.vocabulary_notes]
  };

  if (!containsChinese(result.translation_zh)) {
    const zh = await tryChatCompletion({
      ...ctx,
      messages: [
        {
          role: 'system',
          content:
            'Translate the Korean chat message into natural Simplified Chinese. Return only the Chinese translation. No Korean, no JSON, no labels, no quotation marks.'
        },
        { role: 'user', content: result.reply }
      ],
      preferJsonMode: false,
      temperature: 0.2
    });
    if (zh) result.translation_zh = extractChineseOnly(zh) || zh.trim();
  }

  const validNotes = sanitizeVocabularyNotes(result.vocabulary_notes, result.reply);
  if (validNotes.length < 2 && containsHangul(result.reply)) {
    const repaired = await repairVocabularyNotes(result.reply, ctx);
    if (repaired.length) result.vocabulary_notes = repaired;
  } else {
    result.vocabulary_notes = validNotes;
  }

  if (!result.romanization.trim() && containsHangul(result.reply)) {
    const rom = await tryChatCompletion({
      ...ctx,
      messages: [
        {
          role: 'system',
          content:
            'Write the Korean pronunciation in Latin letters (romanization) only. No Korean characters, no Chinese, no labels.'
        },
        { role: 'user', content: result.reply }
      ],
      preferJsonMode: false,
      temperature: 0.2
    });
    if (rom) {
      const cleaned = sanitizeRomanization(rom);
      if (cleaned && !looksLikeModelReasoning(cleaned)) {
        result.romanization = cleaned;
      }
    }
  }

  if (looksLikeModelReasoning(result.romanization)) {
    result.romanization = '';
  }

  return result;
}

function extractChineseOnly(text: string) {
  const lines = text
    .split(/\r?\n/)
    .map((line) => stripKnownPrefix(line.trim()))
    .filter((line) => containsChinese(line));
  return lines.join('\n').trim();
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

type ChatCompletionParams = {
  baseURL: string;
  apiKey: string;
  model: string;
  messages: ChatMessage[];
  preferJsonMode?: boolean;
  temperature: number;
};

/** Best-effort call: returns null instead of throwing when the provider returns empty content. */
async function tryChatCompletion(params: ChatCompletionParams): Promise<string | null> {
  try {
    return await requestChatCompletion(params);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('empty content')) return null;
    throw error;
  }
}

async function requestChatCompletion(params: ChatCompletionParams) {
  const content = await fetchChatCompletionContent(params);
  if (content) return content;
  throw new Error('AI provider returned empty content.');
}

async function fetchChatCompletionContent(params: ChatCompletionParams): Promise<string | null> {
  const attempt = async (useJsonMode: boolean) => {
    const body: Record<string, unknown> = {
      model: params.model,
      temperature: params.temperature,
      max_tokens: 900,
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

  const attempts: boolean[] = params.preferJsonMode ? [true, false] : [false, true];

  let lastEmptyDetail = 'unknown';
  for (const useJsonMode of attempts) {
    let { response, text } = await attempt(useJsonMode);

    if (!response.ok && useJsonMode && shouldRetryWithoutJsonMode(response.status, text)) {
      continue;
    }
    if (!response.ok) throw new Error(`AI provider failed: HTTP ${response.status} ${text}`);

    let envelope: unknown;
    try {
      envelope = JSON.parse(text);
    } catch {
      throw new Error(`AI provider returned invalid envelope: ${text.slice(0, 200)}`);
    }

    const content = extractAssistantContent(envelope);
    if (content) return content;

    lastEmptyDetail = describeEmptyCompletion(envelope);
  }

  console.warn(`AI empty content (${lastEmptyDetail})`);
  return null;
}

function extractAssistantContent(envelope: unknown): string {
  if (!envelope || typeof envelope !== 'object') return '';

  const root = envelope as Record<string, unknown>;

  if (typeof root.output_text === 'string' && root.output_text.trim()) {
    return root.output_text.trim();
  }

  if (root.output && typeof root.output === 'object') {
    const fromOutput = extractAssistantContent(root.output);
    if (fromOutput) return fromOutput;
  }

  if (root.data && typeof root.data === 'object') {
    const fromData = extractAssistantContent(root.data);
    if (fromData) return fromData;
  }

  const choices = root.choices;
  if (!Array.isArray(choices) || !choices[0] || typeof choices[0] !== 'object') return '';

  const choice = choices[0] as Record<string, unknown>;
  const message =
    choice.message && typeof choice.message === 'object'
      ? (choice.message as Record<string, unknown>)
      : null;

  if (message) {
    const fromContent = extractContentValue(message.content);
    if (fromContent) return fromContent;

    const fromToolCalls = extractToolCallArguments(message.tool_calls);
    if (fromToolCalls) return fromToolCalls;

    const fallback = pickString(message, ['text', 'output_text']);
    if (fallback && !looksLikeModelReasoning(fallback)) return fallback;
  }

  const choiceText = pickString(choice, ['text', 'content']);
  return choiceText ?? '';
}

function extractContentValue(content: unknown): string {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';

  const parts: string[] = [];
  for (const part of content) {
    if (typeof part === 'string') {
      parts.push(part);
      continue;
    }
    if (!part || typeof part !== 'object') continue;
    const item = part as Record<string, unknown>;
    if (typeof item.text === 'string') parts.push(item.text);
    else if (typeof item.content === 'string') parts.push(item.content);
  }
  return parts.join('\n').trim();
}

function extractToolCallArguments(toolCalls: unknown): string {
  if (!Array.isArray(toolCalls)) return '';

  for (const call of toolCalls) {
    if (!call || typeof call !== 'object') continue;
    const fn = (call as Record<string, unknown>).function;
    if (!fn || typeof fn !== 'object') continue;
    const args = (fn as Record<string, unknown>).arguments;
    if (typeof args === 'string' && args.trim()) return args.trim();
  }
  return '';
}

function describeEmptyCompletion(envelope: unknown): string {
  if (!envelope || typeof envelope !== 'object') return 'no envelope';
  const root = envelope as Record<string, unknown>;
  const choices = root.choices;
  if (!Array.isArray(choices) || !choices[0] || typeof choices[0] !== 'object') {
    return 'no choices';
  }
  const choice = choices[0] as Record<string, unknown>;
  const finish = typeof choice.finish_reason === 'string' ? choice.finish_reason : 'n/a';
  const message =
    choice.message && typeof choice.message === 'object'
      ? (choice.message as Record<string, unknown>)
      : null;
  const role = message && typeof message.role === 'string' ? message.role : 'n/a';
  const refusal =
    message && typeof message.refusal === 'string' ? message.refusal.slice(0, 80) : '';
  return `finish_reason=${finish}, role=${role}${refusal ? `, refusal=${refusal}` : ''}`;
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
  const nestedReply = value.reply;
  if (nestedReply && typeof nestedReply === 'object') {
    return normalizeReplyObject(nestedReply as Record<string, unknown>);
  }
  if (typeof nestedReply === 'string') {
    const trimmed = nestedReply.trim();
    if (trimmed.startsWith('{')) {
      try {
        const inner = JSON.parse(extractFirstJSONObject(trimmed) ?? trimmed) as Record<string, unknown>;
        const fromInner = normalizeReplyObject(inner);
        if (fromInner) return fromInner;
      } catch {
        // fall through and treat as plain Korean reply text
      }
    }
  }

  const reply = pickString(value, ['reply', 'original', 'original_ko', 'korean', 'text', 'message']);
  if (!reply) return null;

  const translation_zh =
    pickString(value, ['translation_zh', 'translation', 'chinese', 'zh', 'zh_cn', 'chinese_translation']) ?? '';
  const romanization =
    pickString(value, ['romanization', 'romaja', 'romanized', 'pronunciation', 'latin']) ?? '';

  const rawNotes = value.vocabulary_notes ?? value.vocab_notes ?? value.notes ?? value.word_notes;
  const vocabulary_notes = sanitizeVocabularyNotes(rawNotes, reply);

  let cleanedRomanization = sanitizeRomanization(romanization);
  if (looksLikeModelReasoning(cleanedRomanization)) cleanedRomanization = '';

  return {
    reply: sanitizeKoreanReply(reply),
    translation_zh: translation_zh.trim(),
    romanization: cleanedRomanization,
    vocabulary_notes
  };
}

async function repairVocabularyNotes(
  reply: string,
  ctx: { baseURL: string; apiKey: string; model: string }
): Promise<ChatReplyPayload['vocabulary_notes']> {
  const vocabRaw = await tryChatCompletion({
    ...ctx,
    messages: [
      {
        role: 'system',
        content:
          'Pick exactly 3 to 5 SHORT Korean learning items from the user message. Each term must be a single word, particle, ending, or short phrase (max 10 Hangul characters) copied verbatim from the message. Do NOT use the full sentence as a term. Return JSON only: {"vocabulary_notes":[{"term":"","romanization":"","explanation_zh":""}]}. explanation_zh must be Simplified Chinese.'
      },
      { role: 'user', content: reply }
    ],
    preferJsonMode: true,
    temperature: 0.2
  });
  if (!vocabRaw) return [];

  const parsedOnly = parseVocabularyNotesOnly(vocabRaw, reply);
  if (parsedOnly.length >= 2) return parsedOnly;

  const parsedFull = parseStructuredReply(vocabRaw);
  return sanitizeVocabularyNotes(parsedFull?.vocabulary_notes ?? [], reply);
}

function parseVocabularyNotesOnly(raw: string, fullReply: string) {
  const cleaned = stripMarkdownCodeFence(raw);
  const jsonCandidate = extractFirstJSONObject(cleaned) ?? cleaned;
  try {
    const decoded = JSON.parse(jsonCandidate) as Record<string, unknown>;
    const rawNotes = decoded.vocabulary_notes ?? decoded.vocab_notes ?? decoded.notes ?? decoded.word_notes;
    return sanitizeVocabularyNotes(rawNotes, fullReply);
  } catch {
    return [];
  }
}

function isValidVocabularyTerm(term: string, fullReply: string) {
  const trimmedTerm = term.trim();
  const trimmedReply = fullReply.trim();
  if (!containsHangul(trimmedTerm)) return false;
  if (!trimmedTerm || !trimmedReply) return false;
  if (trimmedTerm === trimmedReply) return false;
  if (trimmedTerm.length > 14) return false;
  if (trimmedTerm.length >= Math.max(12, Math.floor(trimmedReply.length * 0.5))) return false;
  if (!trimmedReply.includes(trimmedTerm)) return false;
  return true;
}

function isGenericVocabularyExplanation(explanation: string) {
  const lower = explanation.toLowerCase();
  return (
    explanation.includes('这是一句自然的韩语') ||
    explanation.includes('可以整体理解') ||
    explanation.includes('私聊表达')
  );
}

function sanitizeVocabularyNotes(
  raw: unknown,
  fullReply: string
): ChatReplyPayload['vocabulary_notes'] {
  if (!Array.isArray(raw)) return [];

  const notes: ChatReplyPayload['vocabulary_notes'] = [];
  const seen = new Set<string>();

  for (const item of raw) {
    if (typeof item === 'string') {
      const parsed = parseNoteLine(item);
      if (
        parsed &&
        !seen.has(parsed.term) &&
        isValidVocabularyTerm(parsed.term, fullReply) &&
        !isGenericVocabularyExplanation(parsed.explanation_zh)
      ) {
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
    if (!isValidVocabularyTerm(term, fullReply)) continue;
    if (isGenericVocabularyExplanation(explanation_zh)) continue;
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

function looksLikeModelReasoning(text: string) {
  const trimmed = text.trim();
  if (!trimmed) return false;

  const lower = trimmed.toLowerCase();
  const markers = [
    'we must',
    'the instruction',
    'instruction says',
    'the user',
    'probably omit',
    'need to include',
    'write only',
    'json only',
    'json schema',
    'return json',
    'korean pronunciation',
    'no korean characters',
    'no chinese',
    'no labels',
    'must be',
    'should be'
  ];
  const hits = markers.filter((marker) => lower.includes(marker)).length;
  if (hits >= 2) return true;
  if (trimmed.length > 220 && hits >= 1) return true;
  return false;
}

function sanitizeRomanization(text: string) {
  if (looksLikeModelReasoning(text)) return '';

  return text
    .split(/\r?\n/)
    .map((line) => stripKnownPrefix(line.trim()))
    .filter(
      (line) =>
        line &&
        containsLatin(line) &&
        !containsChinese(line) &&
        !containsHangul(line) &&
        !looksLikeModelReasoning(line)
    )
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
