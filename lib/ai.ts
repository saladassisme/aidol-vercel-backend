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
  mode?: 'chat' | 'voice_letter';
  messages: ChatMessage[];
  nativeLanguageCode?: string;
  targetLanguageCode?: string;
  languageLevelCode?: string;
}) {
  const baseURL = requiredEnv('AI_API_BASE_URL').replace(/\/$/, '');
  const apiKey = requiredEnv('AI_API_KEY');
  const model = optionalEnv('AI_TEXT_MODEL', 'gpt-4o-mini');

  const system = buildSystemPrompt(
    params.persona,
    params.nickname,
    params.mode ?? 'chat',
    params.nativeLanguageCode,
    params.targetLanguageCode,
    params.languageLevelCode
  );
  const rawContent = await requestChatCompletion({
    baseURL,
    apiKey,
    model,
    messages: [{ role: 'system', content: system }, ...params.messages.slice(-12)],
    preferJsonMode: true,
    temperature: 0.75
  });

  const ctx = { baseURL, apiKey, model };

  const parsed = parseStructuredReply(rawContent, params.targetLanguageCode, params.nativeLanguageCode);
  if (parsed) {
    return ensureReplyCompleteness(parsed, ctx, params.nativeLanguageCode, params.targetLanguageCode);
  }

  const repaired = await requestChatCompletion({
    baseURL,
    apiKey,
    model,
    messages: [
      {
        role: 'system',
        content: buildDraftRepairPrompt(params.nativeLanguageCode, params.targetLanguageCode)
      },
      { role: 'user', content: rawContent }
    ],
    preferJsonMode: false,
    temperature: 0.2
  });

  const repairedParsed = parseStructuredReply(repaired, params.targetLanguageCode, params.nativeLanguageCode);
  if (repairedParsed) {
    return ensureReplyCompleteness(repairedParsed, ctx, params.nativeLanguageCode, params.targetLanguageCode);
  }

  throw new Error('AI provider returned non-JSON content.');
}

async function ensureReplyCompleteness(
  reply: ChatReplyPayload,
  ctx: { baseURL: string; apiKey: string; model: string },
  nativeLanguageCode?: string,
  targetLanguageCode?: string
): Promise<ChatReplyPayload> {
  const normalized = repairMisplacedFields(reply, targetLanguageCode, nativeLanguageCode);
  const result: ChatReplyPayload = {
    ...normalized,
    reply: extractReplyText(normalized.reply, targetLanguageCode),
    translation_zh: extractTextField(normalized.translation_zh, nativeLanguageCode),
    romanization: sanitizeRomanization(normalized.romanization),
    vocabulary_notes: [...normalized.vocabulary_notes]
  };

  if (!result.translation_zh.trim()) {
    const nativeLanguage = languageName(nativeLanguageCode, "the user's native language");
    const zh = await tryChatCompletion({
      ...ctx,
      messages: [
        {
          role: 'system',
          content: `Translate the following reply into natural ${nativeLanguage}. Return only the translation. No JSON, no labels, no quotation marks.`
        },
        { role: 'user', content: result.reply }
      ],
      preferJsonMode: false,
      temperature: 0.2
    });
    if (zh) result.translation_zh = extractTextField(zh, nativeLanguageCode) || zh.trim();
  }

  const validNotes = sanitizeVocabularyNotes(
    result.vocabulary_notes,
    result.reply,
    targetLanguageCode,
    nativeLanguageCode
  );
  if (validNotes.length < 2 && result.reply.trim()) {
    const repaired = await repairVocabularyNotes(result.reply, ctx, nativeLanguageCode, targetLanguageCode);
    if (repaired.length) result.vocabulary_notes = repaired;
  } else {
    result.vocabulary_notes = validNotes;
  }

  if (!result.romanization.trim() && shouldRequestRomanization(targetLanguageCode)) {
    const targetLanguage = languageName(targetLanguageCode, 'the target language');
    const rom = await tryChatCompletion({
      ...ctx,
      messages: [
        {
          role: 'system',
          content: `Write the pronunciation of the following ${targetLanguage} reply using Latin letters only. Return only the pronunciation. No JSON, no labels, no explanation. If pronunciation is not useful for this language, return an empty string.`
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

  return finalizeReplyPayload(result, targetLanguageCode, nativeLanguageCode);
}

function extractReplyText(text: string, targetLanguageCode?: string) {
  return extractTextField(text, targetLanguageCode);
}

function extractTextField(text: string, languageCode?: string) {
  const lines = text
    .split(/\r?\n/)
    .map((line) => stripKnownPrefix(line.trim()))
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter((line) => line && !looksLikeModelReasoning(line));

  if (!lines.length) return text.trim();

  const preferred = lines.filter((line) => languageScore(line, languageCode) > 0.12);
  if (preferred.length) return preferred.join('\n').trim();

  return lines.join('\n').trim();
}

function buildDraftRepairPrompt(nativeLanguageCode?: string, targetLanguageCode?: string) {
  const nativeLanguage = languageName(nativeLanguageCode, "the user's native language");
  const targetLanguage = languageName(targetLanguageCode, 'the target language');
  return `Convert the assistant draft into JSON only. Schema: {"reply":"${targetLanguage}","translation_zh":"${nativeLanguage}","romanization":"latin transliteration when useful","vocabulary_notes":[{"term":"","romanization":"","explanation_zh":""}]}. The "reply" field must stay in ${targetLanguage}. The "translation_zh" field must be written in ${nativeLanguage}. No markdown.`;
}

function buildSystemPrompt(
  persona: string,
  nickname: string,
  mode: 'chat' | 'voice_letter',
  nativeLanguageCode?: string,
  targetLanguageCode?: string,
  languageLevelCode?: string
) {
  const nativeLanguage = languageName(nativeLanguageCode, 'Chinese');
  const targetLanguage = languageName(targetLanguageCode, 'Korean');
  const languageLevel = languageLevelName(languageLevelCode, 'Intermediate');

  const voiceLetterInstructions = mode === 'voice_letter'
    ? `

Special mode: voice letter
- Write a warm, intimate, one-minute monologue that feels like a private voice note or a friend's life update.
- Focus on the character's recent life, feelings, little daily TMI, and casual affection toward the user.
- Do not ask the user to reply in every line. Keep it flowing like a spoken message.
- Keep the reply natural, easy to speak, and slightly longer than a normal chat reply.
`
    : '';

  return `You are generating a reply for an idol-style private chat simulation.

Character nickname (display only): ${nickname}

Persona:
${persona}

Language pair:
- Target language (reply in this language): ${targetLanguage}
- Native / familiar language (translation and explanations): ${nativeLanguage}
- User level: ${languageLevel}
${voiceLetterInstructions}

Field separation (critical — do not mix languages across fields):
- "reply" = 原文：仅 ${targetLanguage}，可含表情符号，禁止混入其他语言。
- "translation_zh" = 翻译：使用 ${nativeLanguage} 书写，解释 reply 的意思。
- "romanization" = 发音提示：仅在对目标语言有帮助时输出拉丁转写，禁止写解释。
- "vocabulary_notes" = 单词/短句注解：2–5 条；term 必须是 reply 中出现的词或短短语，禁止整句；explanation_zh 用 ${nativeLanguage} 书写。
- When the user level is ${languageLevel}, choose vocabulary that feels appropriate for that level. For near-native or native users, prefer less obvious and more advanced expressions; avoid listing extremely simple words.

Output rules:
- Return one JSON object only. No markdown.
- Schema:
{
  "reply": "韩文原文",
  "translation_zh": "翻译",
  "romanization": "latin romanization",
  "vocabulary_notes": [
    {"term":"目标语言词","romanization":"latin","explanation_zh":"释义"}
  ]
}`;
}

function languageName(code: string | undefined, fallback: string) {
  switch ((code || '').toLowerCase()) {
    case 'zh-hans':
    case 'zh':
    case 'zh-hant':
    case 'zh-tw':
      return 'Chinese';
    case 'en':
      return 'English';
    case 'ja':
      return 'Japanese';
    case 'ko':
      return 'Korean';
    case 'es':
      return 'Spanish';
    case 'fr':
      return 'French';
    case 'de':
      return 'German';
    case 'it':
      return 'Italian';
    case 'pt':
      return 'Portuguese';
    case 'ru':
      return 'Russian';
    default:
      return fallback;
  }
}

function languageLevelName(code: string | undefined, fallback: string) {
  switch ((code || '').toLowerCase()) {
    case 'beginner':
      return 'Beginner';
    case 'elementary':
      return 'Elementary';
    case 'intermediate':
      return 'Intermediate';
    case 'upperintermediate':
      return 'Upper Intermediate';
    case 'advanced':
      return 'Advanced';
    case 'nearnative':
      return 'Near Native';
    case 'native':
      return 'Native';
    default:
      return fallback;
  }
}

function finalizeReplyPayload(
  payload: ChatReplyPayload,
  targetLanguageCode?: string,
  nativeLanguageCode?: string
): ChatReplyPayload {
  const repaired = repairMisplacedFields(payload, targetLanguageCode, nativeLanguageCode);
  const reply = extractReplyText(repaired.reply, targetLanguageCode);
  const translation_zh = extractTextField(repaired.translation_zh, nativeLanguageCode);
  let romanization = sanitizeRomanization(repaired.romanization);
  if (looksLikeModelReasoning(romanization)) romanization = '';

  const vocabulary_notes = sanitizeVocabularyNotes(
    repaired.vocabulary_notes,
    reply,
    targetLanguageCode,
    nativeLanguageCode
  );

  return {
    reply,
    translation_zh,
    romanization,
    vocabulary_notes
  };
}

/** Fix common model mistakes (fields swapped or JSON stuffed into reply). */
function repairMisplacedFields(
  payload: ChatReplyPayload,
  targetLanguageCode?: string,
  nativeLanguageCode?: string
): ChatReplyPayload {
  const embedded = tryParseEmbeddedReplyJson(payload.reply, targetLanguageCode, nativeLanguageCode);
  if (embedded) {
    return {
      reply: embedded.reply || payload.reply,
      translation_zh: embedded.translation_zh || payload.translation_zh,
      romanization: embedded.romanization || payload.romanization,
      vocabulary_notes:
        embedded.vocabulary_notes.length > 0 ? embedded.vocabulary_notes : payload.vocabulary_notes
    };
  }

  let { reply, translation_zh, romanization, vocabulary_notes } = payload;

  const replyTargetScore = languageScore(reply, targetLanguageCode);
  const replyNativeScore = languageScore(reply, nativeLanguageCode);
  const translationTargetScore = languageScore(translation_zh, targetLanguageCode);
  const translationNativeScore = languageScore(translation_zh, nativeLanguageCode);

  if (
    replyTargetScore < 0.1 &&
    translationTargetScore > replyTargetScore + 0.2 &&
    translationNativeScore < translationTargetScore
  ) {
    [reply, translation_zh] = [translation_zh, reply];
  } else if (
    replyNativeScore > replyTargetScore + 0.2 &&
    translationTargetScore > translationNativeScore + 0.2
  ) {
    [reply, translation_zh] = [translation_zh, reply];
  } else if (!containsExpectedLanguage(reply, targetLanguageCode) && containsExpectedLanguage(translation_zh, targetLanguageCode)) {
    [reply, translation_zh] = [translation_zh, reply];
  }

  const romLatin = latinLetterRatio(romanization);
  const romTarget = languageScore(romanization, targetLanguageCode);
  const transLatin = latinLetterRatio(translation_zh);

  if (romTarget > 0.2 && transLatin > 0.35 && translationNativeScore < 0.2) {
    [translation_zh, romanization] = [romanization, translation_zh];
  } else if (containsExpectedLanguage(romanization, targetLanguageCode) && !containsExpectedLanguage(reply, targetLanguageCode)) {
    reply = extractReplyText(romanization, targetLanguageCode);
    romanization = '';
  } else if (romLatin > 0.45 && translationTargetScore > 0.2 && transLatin < 0.15) {
    [translation_zh, romanization] = [romanization, translation_zh];
  }

  return { reply, translation_zh, romanization, vocabulary_notes };
}

function tryParseEmbeddedReplyJson(text: string, targetLanguageCode?: string, nativeLanguageCode?: string): ChatReplyPayload | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{')) return null;
  const parsed = parseStructuredReply(trimmed, targetLanguageCode, nativeLanguageCode);
  if (!parsed) return null;
  return parsed;
}

function hangulRatio(text: string) {
  const chars = [...text.replace(/\s/g, '')];
  if (!chars.length) return 0;
  const hangul = chars.filter((ch) => /[\uAC00-\uD7AF]/.test(ch)).length;
  return hangul / chars.length;
}

function chineseRatio(text: string) {
  const chars = [...text.replace(/\s/g, '')];
  if (!chars.length) return 0;
  const chinese = chars.filter((ch) => /[\u3400-\u9FFF]/.test(ch)).length;
  return chinese / chars.length;
}

function latinLetterRatio(text: string) {
  const chars = [...text.replace(/\s/g, '')];
  if (!chars.length) return 0;
  const latin = chars.filter((ch) => /[A-Za-z]/.test(ch)).length;
  return latin / chars.length;
}

function languageScript(code?: string) {
  switch ((code || '').toLowerCase()) {
    case 'zh':
    case 'zh-hans':
    case 'zh-hant':
      return 'chinese';
    case 'ja':
      return 'japanese';
    case 'ko':
      return 'hangul';
    case 'ru':
      return 'cyrillic';
    case 'en':
    case 'es':
    case 'fr':
    case 'de':
    case 'it':
    case 'pt':
      return 'latin';
    default:
      return 'latin';
  }
}

function languageScore(text: string, code?: string) {
  const script = languageScript(code);
  switch (script) {
    case 'chinese':
      return chineseRatio(text);
    case 'japanese':
      return japaneseRatio(text);
    case 'hangul':
      return hangulRatio(text);
    case 'cyrillic':
      return cyrillicRatio(text);
    case 'latin':
      return latinLetterRatio(text);
    default:
      return Math.max(chineseRatio(text), hangulRatio(text), japaneseRatio(text), cyrillicRatio(text), latinLetterRatio(text));
  }
}

function containsExpectedLanguage(text: string, code?: string) {
  const script = languageScript(code);
  switch (script) {
    case 'chinese':
      return containsChinese(text);
    case 'japanese':
      return containsJapanese(text);
    case 'hangul':
      return containsHangul(text);
    case 'cyrillic':
      return containsCyrillic(text);
    case 'latin':
      return containsLatin(text);
    default:
      return containsChinese(text) || containsJapanese(text) || containsHangul(text) || containsCyrillic(text) || containsLatin(text);
  }
}

function shouldRequestRomanization(targetLanguageCode?: string) {
  switch (languageScript(targetLanguageCode)) {
    case 'chinese':
    case 'japanese':
    case 'hangul':
    case 'cyrillic':
      return true;
    default:
      return false;
  }
}

function extractKoreanOnly(text: string) {
  return extractReplyText(text, 'ko');
}

function isPrimarilyChinese(line: string) {
  const hangul = (line.match(/[\uAC00-\uD7AF]/g) || []).length;
  const chinese = (line.match(/[\u3400-\u9FFF]/g) || []).length;
  return chinese > 0 && chinese >= hangul;
}

function japaneseRatio(text: string) {
  const chars = [...text.replace(/\s/g, '')];
  if (!chars.length) return 0;
  const kana = chars.filter((ch) => /[\u3040-\u30FF]/.test(ch)).length;
  const cjk = chars.filter((ch) => /[\u4E00-\u9FFF]/.test(ch)).length;
  return Math.min(1, (kana + cjk * 0.5) / chars.length);
}

function cyrillicRatio(text: string) {
  const chars = [...text.replace(/\s/g, '')];
  if (!chars.length) return 0;
  const cyrillic = chars.filter((ch) => /[\u0400-\u04FF]/.test(ch)).length;
  return cyrillic / chars.length;
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

function parseStructuredReply(
  rawContent: string,
  targetLanguageCode?: string,
  nativeLanguageCode?: string
): ChatReplyPayload | null {
  const cleaned = stripMarkdownCodeFence(rawContent);
  const jsonCandidate = extractFirstJSONObject(cleaned) ?? cleaned;

  let decoded: Record<string, unknown> | null = null;
  try {
    decoded = JSON.parse(jsonCandidate) as Record<string, unknown>;
  } catch {
    decoded = null;
  }

  if (decoded) {
    const normalized = normalizeReplyObject(decoded, targetLanguageCode, nativeLanguageCode);
    if (normalized) return normalized;
  }

  return parseLooseThreePartReply(cleaned, targetLanguageCode, nativeLanguageCode);
}

function normalizeReplyObject(
  value: Record<string, unknown>,
  targetLanguageCode?: string,
  nativeLanguageCode?: string
): ChatReplyPayload | null {
  const nestedReply = value.reply;
  if (nestedReply && typeof nestedReply === 'object') {
    return normalizeReplyObject(nestedReply as Record<string, unknown>, targetLanguageCode, nativeLanguageCode);
  }
  if (typeof nestedReply === 'string') {
    const trimmed = nestedReply.trim();
    if (trimmed.startsWith('{')) {
      try {
        const inner = JSON.parse(extractFirstJSONObject(trimmed) ?? trimmed) as Record<string, unknown>;
        const fromInner = normalizeReplyObject(inner, targetLanguageCode, nativeLanguageCode);
        if (fromInner) return fromInner;
      } catch {
        // fall through and treat as plain reply text
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
  const vocabulary_notes = sanitizeVocabularyNotes(rawNotes, reply, targetLanguageCode, nativeLanguageCode);

  let cleanedRomanization = sanitizeRomanization(romanization);
  if (looksLikeModelReasoning(cleanedRomanization)) cleanedRomanization = '';

  return {
    reply: extractReplyText(reply, targetLanguageCode),
    translation_zh: extractTextField(translation_zh, nativeLanguageCode),
    romanization: cleanedRomanization,
    vocabulary_notes
  };
}

async function repairVocabularyNotes(
  reply: string,
  ctx: { baseURL: string; apiKey: string; model: string },
  nativeLanguageCode?: string,
  targetLanguageCode?: string
): Promise<ChatReplyPayload['vocabulary_notes']> {
  const nativeLanguage = languageName(nativeLanguageCode, "the user's native language");
  const targetLanguage = languageName(targetLanguageCode, 'the target language');
  const vocabRaw = await tryChatCompletion({
    ...ctx,
    messages: [
      {
        role: 'system',
        content:
          `Pick exactly 3 to 5 SHORT learning items from the target-language reply. Each term must be a single word, particle, ending, or short phrase copied verbatim from the message. Do NOT use the full sentence as a term. Return JSON only: {"vocabulary_notes":[{"term":"","romanization":"","explanation_zh":""}]}. explanation_zh must be written in ${nativeLanguage}. If a term can be pronounced with a useful Latin transliteration, include romanization; otherwise leave it empty. Target language: ${targetLanguage}.`
      },
      { role: 'user', content: reply }
    ],
    preferJsonMode: true,
    temperature: 0.2
  });
  if (!vocabRaw) return [];

  const parsedOnly = parseVocabularyNotesOnly(vocabRaw, reply, targetLanguageCode, nativeLanguageCode);
  if (parsedOnly.length >= 2) return parsedOnly;

  const parsedFull = parseStructuredReply(vocabRaw, targetLanguageCode, nativeLanguageCode);
  return sanitizeVocabularyNotes(parsedFull?.vocabulary_notes ?? [], reply, targetLanguageCode, nativeLanguageCode);
}

function parseVocabularyNotesOnly(
  raw: string,
  fullReply: string,
  targetLanguageCode?: string,
  nativeLanguageCode?: string
) {
  const cleaned = stripMarkdownCodeFence(raw);
  const jsonCandidate = extractFirstJSONObject(cleaned) ?? cleaned;
  try {
    const decoded = JSON.parse(jsonCandidate) as Record<string, unknown>;
    const rawNotes = decoded.vocabulary_notes ?? decoded.vocab_notes ?? decoded.notes ?? decoded.word_notes;
    return sanitizeVocabularyNotes(rawNotes, fullReply, targetLanguageCode, nativeLanguageCode);
  } catch {
    return [];
  }
}

function isValidVocabularyTerm(term: string, fullReply: string, targetLanguageCode?: string) {
  const trimmedTerm = term.trim();
  const trimmedReply = fullReply.trim();
  if (!trimmedTerm || !trimmedReply) return false;
  if (trimmedTerm === trimmedReply) return false;
  if (trimmedTerm.length > 18) return false;
  if (trimmedTerm.length >= Math.max(12, Math.floor(trimmedReply.length * 0.5))) return false;
  if (!trimmedReply.includes(trimmedTerm)) return false;
  if (targetLanguageCode && languageScript(targetLanguageCode) !== 'latin' && !containsExpectedLanguage(trimmedTerm, targetLanguageCode)) {
    return false;
  }
  return true;
}

function isGenericVocabularyExplanation(explanation: string) {
  const lower = explanation.toLowerCase();
  return (
    explanation.includes('这是一句自然的') ||
    explanation.includes('可以整体理解') ||
    explanation.includes('私聊表达') ||
    lower.includes('natural') ||
    lower.includes('reply') ||
    lower.includes('phrase') ||
    lower.includes('meaning')
  );
}

function sanitizeVocabularyNotes(
  raw: unknown,
  fullReply: string,
  targetLanguageCode?: string,
  nativeLanguageCode?: string
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
        isValidVocabularyTerm(parsed.term, fullReply, targetLanguageCode) &&
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
    const cleanedExplanation = extractTextField(explanation_zh, nativeLanguageCode);
    if (!term || !cleanedExplanation || seen.has(term)) continue;
    if (!isValidVocabularyTerm(term, fullReply, targetLanguageCode)) continue;
    if (isGenericVocabularyExplanation(cleanedExplanation)) continue;
    if (looksLikeModelReasoning(cleanedExplanation)) continue;
    seen.add(term);
    const noteRom = sanitizeRomanization(romanization);
    notes.push({ term: extractReplyText(term, targetLanguageCode) || term, romanization: noteRom, explanation_zh: cleanedExplanation });
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

function parseLooseThreePartReply(
  rawText: string,
  targetLanguageCode?: string,
  nativeLanguageCode?: string
): ChatReplyPayload | null {
  const lines = stripMarkdownCodeFence(rawText)
    .split(/\r?\n/)
    .map((line) => stripKnownPrefix(line.trim()))
    .filter(Boolean);

  if (lines.length === 0) return null;

  const replyLines = lines.filter((line) => containsExpectedLanguage(line, targetLanguageCode));
  const translationLines = lines.filter(
    (line) => containsExpectedLanguage(line, nativeLanguageCode) && !containsExpectedLanguage(line, targetLanguageCode)
  );
  const romanizationLines = lines.filter(
    (line) =>
      containsLatin(line) &&
      !containsChinese(line) &&
      !containsHangul(line) &&
      !containsJapanese(line) &&
      !containsCyrillic(line)
  );

  if (replyLines.length === 0) return null;

  return {
    reply: extractReplyText(replyLines.join('\n'), targetLanguageCode),
    translation_zh: extractTextField(translationLines.join('\n'), nativeLanguageCode),
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
  return extractReplyText(text, 'ko');
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
    'reply:',
    'Reply:',
    'original:',
    'Original:',
    'translation_zh:',
    'translation:',
    'Translation:',
    'meaning:',
    'Meaning:',
    'romanization:',
    'Romanization:',
    'pronunciation:',
    'Pronunciation:',
    '原文:',
    '原文：',
    '中文:',
    '中文：',
    '翻译:',
    '翻译：',
    '解释:',
    '解释：',
    '释义:',
    '释义：',
    '发音:',
    '发音：',
    '로마자:',
    '발음:',
    '원문:',
    '번역:',
    '번역：'
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

function containsCyrillic(text: string) {
  return /[\u0400-\u04FF]/.test(text);
}

function containsLatin(text: string) {
  return /[A-Za-z]/.test(text);
}

function containsJapanese(text: string) {
  return /[\u3040-\u30FF]/.test(text) || /[\u4E00-\u9FFF]/.test(text);
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
