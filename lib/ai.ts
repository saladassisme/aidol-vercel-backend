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

function voiceLetterMinReplyLength(targetLanguageCode?: string): number {
  switch ((targetLanguageCode || '').toLowerCase()) {
    case 'ko':
    case 'ja':
      return 240;
    case 'zh-hans':
    case 'zh':
    case 'zh-hant':
    case 'zh-tw':
      return 150;
    case 'en':
      return 300;
    default:
      return 220;
  }
}

async function expandVoiceLetterIfTooShort(
  reply: ChatReplyPayload,
  ctx: { baseURL: string; apiKey: string; model: string },
  nativeLanguageCode?: string,
  targetLanguageCode?: string
): Promise<ChatReplyPayload> {
  const minLength = voiceLetterMinReplyLength(targetLanguageCode);
  if (reply.reply.trim().length >= minLength) {
    const completed = await ensureReplyCompleteness(reply, ctx, nativeLanguageCode, targetLanguageCode, 'voice_letter');
    return finalizeReplyPayload(completed, targetLanguageCode, nativeLanguageCode, 'voice_letter');
  }

  const targetLanguage = languageName(targetLanguageCode, 'the target language');
  const nativeLanguage = languageName(nativeLanguageCode, "the user's native language");
  const expanded = await tryChatCompletion({
    ...ctx,
    maxTokens: 2200,
    messages: [
      {
        role: 'system',
        content: `Expand the draft into a longer voice letter monologue in ${targetLanguage}. When spoken aloud it should take about 45-75 seconds. Use at least 10 sentences and at least ${minLength} characters in "reply". Keep the same mood and character. Return JSON only: {"reply":"","translation_zh":"${nativeLanguage} translation","romanization":"","vocabulary_notes":[]}.`
      },
      {
        role: 'user',
        content: JSON.stringify({
          reply: reply.reply,
          translation_zh: reply.translation_zh
        })
      }
    ],
    preferJsonMode: true,
    temperature: 0.7
  });

  if (!expanded) {
    return finalizeReplyPayload(reply, targetLanguageCode, nativeLanguageCode, 'voice_letter');
  }

  const parsed = parseStructuredReply(expanded, targetLanguageCode, nativeLanguageCode);
  if (!parsed) {
    const completed = await ensureReplyCompleteness(reply, ctx, nativeLanguageCode, targetLanguageCode, 'voice_letter');
    return finalizeReplyPayload(completed, targetLanguageCode, nativeLanguageCode, 'voice_letter');
  }

  const completed = await ensureReplyCompleteness(parsed, ctx, nativeLanguageCode, targetLanguageCode, 'voice_letter');
  return finalizeReplyPayload(completed, targetLanguageCode, nativeLanguageCode, 'voice_letter');
}

export async function generateChatReply(params: {
  persona: string;
  nickname: string;
  isRealPerson?: boolean;
  realName?: string;
  groupName?: string;
  mode?: 'chat' | 'voice_letter' | 'teacher' | 'theater_stage_beat' | 'theater';
  messages: ChatMessage[];
  nativeLanguageCode?: string;
  targetLanguageCode?: string;
  languageLevelCode?: string;
  studyVocabularyEntries?: Array<{
    term: string;
    explanation: string;
    romanization?: string;
  }>;
}) {
  const baseURL = requiredEnv('AI_API_BASE_URL').replace(/\/$/, '');
  const apiKey = requiredEnv('AI_API_KEY');
  const defaultTextModel = 'deepseek-v4-flash';
  const chatModel = optionalEnv('AI_TEXT_MODEL_CHAT', optionalEnv('AI_TEXT_MODEL', defaultTextModel));
  const theaterModel = optionalEnv('AI_TEXT_MODEL_THEATER', optionalEnv('AI_TEXT_MODEL_CHAT', optionalEnv('AI_TEXT_MODEL', defaultTextModel)));
  const theaterStageBeatModel = optionalEnv('AI_TEXT_MODEL_THEATER_STAGE_BEAT', theaterModel);
  const voiceLetterModel = optionalEnv('AI_TEXT_MODEL_VOICE_LETTER', optionalEnv('AI_TEXT_MODEL_STRONG', defaultTextModel));
  const mode = params.mode ?? 'chat';
  const model = mode === 'voice_letter'
    ? voiceLetterModel
    : mode === 'theater' || mode === 'theater_stage_beat'
      ? theaterStageBeatModel
      : chatModel;

  const system = buildSystemPrompt(
    params.persona,
    params.nickname,
    params.isRealPerson ?? false,
    params.realName ?? '',
    params.groupName ?? '',
    params.mode ?? 'chat',
    params.nativeLanguageCode,
    params.targetLanguageCode,
    params.languageLevelCode,
    params.studyVocabularyEntries ?? []
  );
  const requestMessages = mode === 'voice_letter'
    ? filterVoiceLetterMessages(params.messages).slice(-8)
    : mode === 'theater' || mode === 'theater_stage_beat'
      ? params.messages.slice(-4)
      : params.messages.slice(-6);
  if (requestMessages.length === 0 && mode === 'teacher') {
    requestMessages.push({ role: 'user', content: 'Start a new multiple-choice quiz for the current learning context.' });
  }
  if (requestMessages.length === 0 && mode === 'voice_letter') {
    requestMessages.push({
      role: 'user',
      content: "[Start today's voice letter: a full ~one-minute warm spoken monologue. Prioritize persona and real-person identity first; use chat history only as a weak hint and ignore test or quiz noise. Not a short greeting.]"
    });
  }
  const maxTokens = mode === 'voice_letter'
    ? 1500
    : mode === 'theater_stage_beat'
      ? 96
      : mode === 'theater'
        ? 320
        : mode === 'teacher'
          ? 600
          : 620;
  const rawContent = await requestChatCompletion({
    baseURL,
    apiKey,
    model,
    messages: [{ role: 'system', content: system }, ...requestMessages],
    preferJsonMode: mode !== 'teacher' && mode !== 'theater_stage_beat',
    temperature: 0.75,
    maxTokens
  });

  const ctx = { baseURL, apiKey, model };

  if (mode === 'teacher') {
    const teacherReply = parseTeacherReply(rawContent);
    const reply = sanitizeTeacherReplyText(teacherReply?.reply ?? normalizeTeacherReply(rawContent));
    if (!reply.trim()) {
      throw new Error('AI provider returned non-JSON content.');
    }
    return {
      reply: reply.trim(),
      translation_zh: '',
      romanization: '',
      vocabulary_notes: []
    };
  }

  if (mode === 'theater_stage_beat') {
    const beat = sanitizeTheaterStageBeatText(rawContent, params.nativeLanguageCode);
    return {
      reply: beat,
      translation_zh: '',
      romanization: '',
      vocabulary_notes: []
    };
  }

  const parsed = parseStructuredReply(rawContent, params.targetLanguageCode, params.nativeLanguageCode);
  if (parsed) {
    const completed = await ensureReplyCompleteness(
      parsed,
      ctx,
      params.nativeLanguageCode,
      params.targetLanguageCode,
      params.mode ?? 'chat'
    );
    if ((params.mode ?? 'chat') === 'voice_letter') {
      return expandVoiceLetterIfTooShort(completed, ctx, params.nativeLanguageCode, params.targetLanguageCode);
    }
    return completed;
  }

  const repaired = await requestChatCompletion({
    baseURL,
    apiKey,
    model,
    messages: [
        {
          role: 'system',
          content: buildDraftRepairPrompt(params.nativeLanguageCode, params.targetLanguageCode, params.mode ?? 'chat')
        },
      { role: 'user', content: rawContent }
    ],
    preferJsonMode: false,
    temperature: 0.2,
    maxTokens
  });

  const repairedParsed = parseStructuredReply(repaired, params.targetLanguageCode, params.nativeLanguageCode);
  if (repairedParsed) {
    const completed = await ensureReplyCompleteness(
      repairedParsed,
      ctx,
      params.nativeLanguageCode,
      params.targetLanguageCode,
      params.mode ?? 'chat'
    );
    if ((params.mode ?? 'chat') === 'voice_letter') {
      return expandVoiceLetterIfTooShort(completed, ctx, params.nativeLanguageCode, params.targetLanguageCode);
    }
    return completed;
  }

  throw new Error('AI provider returned non-JSON content.');
}

function filterVoiceLetterMessages(messages: ChatMessage[]) {
  return messages.filter((message) => !isVoiceLetterNoise(message.content));
}

function isVoiceLetterNoise(content: string) {
  const text = content.trim();
  if (!text) return true;

  const lowered = text.toLowerCase();
  if (text.length <= 2) return true;

  const markers = [
    'test', 'testing', 'debug', 'sample', 'demo', 'placeholder', 'tmp', 'draft',
    'quiz', 'multiple choice', 'correct answer', 'answer key',
    '测试', '試験', '試し', '检验', '測試', '草稿', '占位', '自检', '调试'
  ];
  if (markers.some((marker) => lowered.includes(marker) || text.includes(marker))) {
    return true;
  }

  if (/^[\d\s.,!?~`'"\-_=+*/\\|()[\]{}<>:;]+$/.test(text)) {
    return true;
  }

  return false;
}

async function ensureReplyCompleteness(
  reply: ChatReplyPayload,
  ctx: { baseURL: string; apiKey: string; model: string },
  nativeLanguageCode?: string,
  targetLanguageCode?: string,
  mode: 'chat' | 'voice_letter' | 'teacher' | 'theater_stage_beat' | 'theater' = 'chat'
): Promise<ChatReplyPayload> {
  const normalized = repairMisplacedFields(reply, targetLanguageCode, nativeLanguageCode);
  const result: ChatReplyPayload = {
    ...normalized,
    reply: extractReplyText(normalized.reply, targetLanguageCode),
    translation_zh: extractTextField(normalized.translation_zh, nativeLanguageCode),
    romanization: sanitizeRomanization(normalized.romanization),
    vocabulary_notes: [...normalized.vocabulary_notes]
  };

  if (mode !== 'teacher' && mode !== 'theater_stage_beat' && mode !== 'theater' && !result.translation_zh.trim()) {
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

  if (mode !== 'teacher' && mode !== 'voice_letter' && mode !== 'theater_stage_beat' && mode !== 'theater') {
    const validNotes = sanitizeVocabularyNotes(
      result.vocabulary_notes,
      result.reply,
      targetLanguageCode,
      nativeLanguageCode
    );
    if (validNotes.length < 2 && result.reply.trim()) {
      const repairedNotes = await repairVocabularyNotes(
        result.reply,
        ctx,
        nativeLanguageCode,
        targetLanguageCode
      ).catch(() => []);
      if (repairedNotes.length > 0) {
        result.vocabulary_notes = repairedNotes.length >= validNotes.length ? repairedNotes : validNotes;
      } else {
        const generic = genericVocabularyNotes(result.reply, targetLanguageCode, nativeLanguageCode);
        result.vocabulary_notes = generic.length > 0 ? (generic.length >= validNotes.length ? generic : validNotes) : validNotes;
      }
    } else {
      result.vocabulary_notes = validNotes;
    }
  } else {
    result.vocabulary_notes = [];
  }

  if (mode !== 'teacher' && mode !== 'theater' && mode !== 'voice_letter' && !result.romanization.trim() && shouldRequestRomanization(targetLanguageCode)) {
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

  return finalizeReplyPayload(result, targetLanguageCode, nativeLanguageCode, mode);
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

function buildDraftRepairPrompt(
  nativeLanguageCode?: string,
  targetLanguageCode?: string,
  mode: 'chat' | 'voice_letter' | 'teacher' | 'theater_stage_beat' | 'theater' = 'chat'
) {
  const nativeLanguage = languageName(nativeLanguageCode, "the user's native language");
  const targetLanguage = languageName(targetLanguageCode, 'the target language');
  const teacherNote = mode === 'teacher'
    ? ' For teacher mode, keep translation_zh empty, romanization empty, and vocabulary_notes empty.'
    : mode === 'voice_letter'
    ? ' For voice letter mode, keep the full long monologue in reply, vocabulary_notes as [], and romanization as "".'
    : '';
  return `Convert the assistant draft into JSON only. Schema: {"reply":"${targetLanguage}","translation_zh":"${nativeLanguage}","romanization":"latin transliteration when useful","vocabulary_notes":[{"term":"","romanization":"","explanation_zh":""}]}. The "reply" field must stay in ${targetLanguage}. The "translation_zh" field must be written in ${nativeLanguage}.${teacherNote} No markdown.`;
}

function parseTeacherReply(rawContent: string): ChatReplyPayload | null {
  const cleaned = stripMarkdownCodeFence(rawContent).trim();
  if (!cleaned) return null;

  const jsonCandidate = extractFirstJSONObject(cleaned) ?? cleaned;
  try {
    const decoded = JSON.parse(jsonCandidate) as Record<string, unknown>;
    if (decoded && typeof decoded === 'object') {
      const reply = pickString(decoded, ['reply', 'original', 'text', 'message', 'content']) ?? '';
      if (reply.trim()) {
        return {
          reply: normalizeTeacherReply(reply),
          translation_zh: '',
          romanization: '',
          vocabulary_notes: []
        };
      }
    }
  } catch {
    // fall back to raw text below
  }

  const reply = normalizeTeacherReply(cleaned);
  if (!reply.trim()) return null;
  return {
    reply,
    translation_zh: '',
    romanization: '',
    vocabulary_notes: []
  };
}

function sanitizeTeacherReplyText(text: string) {
  const cleaned = stripMarkdownCodeFence(text);
  const lines = cleaned
    .split(/\r?\n/)
    .map((line) => stripTeacherReplyEnvelope(stripKnownPrefix(line.trim())))
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter((line) => {
      if (!line) return false;
      if (looksLikeModelReasoning(line)) return false;
      if (/^[{}\[\],:"'`]+$/.test(line)) return false;
      return true;
    })
    .map((line) => line.replace(/^\s*[-•*]+\s*/, '').trim())
    .filter((line) => line.length > 0);

  if (!lines.length) {
    return cleaned.trim();
  }

  return lines.join('\n').trim();
}

function sanitizeTheaterStageBeatText(text: string, nativeLanguageCode?: string) {
  const cleaned = stripMarkdownCodeFence(text)
    .replace(/```/g, '')
    .trim();
  if (!cleaned) return '';

  const upper = cleaned.toUpperCase();
  if (upper === 'SKIP' || upper === 'NONE' || cleaned === '无' || cleaned === '跳过') {
    return '';
  }

  const lines = cleaned
    .split(/\r?\n/)
    .map((line) => stripKnownPrefix(line.trim()))
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter((line) => line && !looksLikeModelReasoning(line));

  const joined = (lines.length ? lines.join(' ') : cleaned).trim();
  const nativeLine = lines.find((line) => containsExpectedLanguage(line, nativeLanguageCode));
  if (!nativeLine) return '';
  return extractTextField(nativeLine, nativeLanguageCode) || nativeLine;
}

function normalizeTeacherReply(text: string) {
  const cleaned = stripMarkdownCodeFence(text);
  const lines = cleaned
    .split(/\r?\n/)
    .map((line) => stripTeacherReplyEnvelope(stripKnownPrefix(line.trim())))
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter((line) => line && !looksLikeModelReasoning(line));

  if (lines.length === 0) return cleaned.trim();
  return lines.join('\n').trim();
}

function stripTeacherReplyEnvelope(text: string) {
  let result = text.trim();
  result = result
    .replace(/^["'`{\[]*\s*reply\s*["'`}\]]*\s*[:=]\s*/i, '')
    .replace(/^["'`{\[]*\s*question\s*["'`}\]]*\s*[:=]\s*/i, '')
    .replace(/^["'`{\[]*\s*content\s*["'`}\]]*\s*[:=]\s*/i, '')
    .replace(/^["'`{\[]*\s*text\s*["'`}\]]*\s*[:=]\s*/i, '')
    .replace(/^["'`{\[]*\s*message\s*["'`}\]]*\s*[:=]\s*/i, '');
  result = result.replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\'/g, "'");
  result = result.replace(/^\s*[-•*]+\s*/, '').trim();
  result = result.replace(/^[{[\]\s]+/, '').replace(/[}\]\s]+$/, '').trim();
  return result;
}

function buildSystemPrompt(
  persona: string,
  nickname: string,
  isRealPerson: boolean,
  realName: string,
  groupName: string,
  mode: 'chat' | 'voice_letter' | 'teacher' | 'theater_stage_beat' | 'theater',
  nativeLanguageCode?: string,
  targetLanguageCode?: string,
  languageLevelCode?: string,
  studyVocabularyEntries: Array<{
    term: string;
    explanation: string;
    romanization?: string;
  }> = []
) {
  const nativeLanguage = languageName(nativeLanguageCode, 'Chinese');
  const targetLanguage = languageName(targetLanguageCode, 'Korean');
  const languageLevel = languageLevelName(languageLevelCode, 'Intermediate');
  const includeStudyVocabularyBlock = mode !== 'voice_letter' && mode !== 'theater' && mode !== 'theater_stage_beat';
  const studyVocabularyBlock = studyVocabularyEntries.length
    ? `\nStudy vocabulary book entries:\n${studyVocabularyEntries.map((entry, index) => {
        const pieces = [
          `#${index + 1}`,
          `term: ${entry.term}`,
          entry.romanization ? `romanization: ${entry.romanization}` : null,
          `meaning: ${entry.explanation}`
        ].filter(Boolean);
        return `- ${pieces.join(' | ')}`;
      }).join('\n')}`
    : '';

  const voiceLetterInstructions = mode === 'voice_letter'
    ? `

Special mode: voice letter
- Write a warm, intimate spoken monologue like a private voice note or a close friend's life update.
- Length is critical: when read aloud at a natural pace, "reply" should take about 45-75 seconds (roughly one minute).
- For Korean/Japanese, aim for at least 10 full sentences and roughly 280-480 characters in "reply".
- For Chinese, aim for at least 10 full sentences and roughly 180-320 characters in "reply".
- For English/European languages, aim for at least 10 full sentences and roughly 320-520 characters in "reply".
- Never output only a short greeting, one-liner, or 1-2 sentences.
- Use persona and real-person context as the primary anchor. Recent chat history is only a weak hint.
- Priority order: real-person context + persona > stable recurring interests > a few meaningful recent chats > learning-language context > everything else.
- If recent chat history contains tests, quizzes, rehearsal text, placeholder content, onboarding noise, or other one-off experiments, ignore them.
- Do not overfit to the latest message. If the newest chat is a test or a throwaway message, pretend it never happened.
- Focus on the user's likely emotional connection to the idol/character, recurring interests, and stable preferences.
- If the user is learning the target language, mention it only lightly and naturally. Do not turn the voice letter into a lesson.
- Share recent life, feelings, little daily TMI, memories, and casual affection toward the user.
- Do not ask the user to reply in every line. Keep it flowing like one continuous spoken message.
- Never continue a quiz, mention A/B/C/D options, or say which answer is correct.
- Start a completely fresh voice note even if recent messages were about studying.
- Set "vocabulary_notes" to [] and "romanization" to "".
`
    : '';

  const teacherInstructions = mode === 'teacher'
    ? `

Special mode: teacher
- Act like a supportive language teacher.
- Build exactly one multiple-choice question in each assistant reply.
- If the latest user message is an answer such as A, B, C, or D, judge it first.
- If the user has not answered yet, do not wait. Start a fresh quiz immediately.
- Correct answer: explicitly say it is correct, then add one short encouraging line in the character's persona.
- Wrong answer: explain briefly and clearly why it is wrong, then show the correct answer.
- For a fresh quiz, make the first line the question, then put the A/B/C/D options on separate lines in the same assistant message.
- For feedback after an answer, keep the reply short, friendly, and in the target language only.
- Prefer target-language questions and target-language options. Keep the whole reply in ${targetLanguage}.
- Use the user's saved vocabulary book entries when possible. If entries are available, ask about their meaning, usage, or a simple grammar point built around them.
- Match the question style to the user's level: beginner/elementary should favor word or short phrase meaning, or very simple daily reply choices; intermediate and above can use simple grammar, usage, or nuance questions.
- Put the question and the A/B/C/D options in one assistant message only. Do not split the options into multiple assistant turns.
- Make the wording feel like the character's persona. Add a short, warm, persona-flavored line when giving feedback.
- Do not add translation, romanization, vocabulary notes, explanations outside the quiz/feedback, JSON, code fences, or labels such as reply:.
- If there is no suitable vocabulary entry, ask a beginner-friendly grammar or usage question matched to the user's level.
`
    : '';

  const theaterInstructions = mode === 'theater'
    ? `

Special mode: theater roleplay
- Stay fully in character for the scene. Keep replies concise, emotional, and easy to continue.
- The "reply" field must contain ONLY spoken dialogue in ${targetLanguage}. No narration, no action descriptions, no stage directions.
- Never wrap actions or scene description in （）, (), or asterisks inside "reply". Those belong in separate stage-beat generation, not in dialogue.
- Output JSON with reply and translation_zh. Leave vocabulary_notes as an empty array.
- Do not add vocabulary notes.
`
    : '';

  const theaterStageBeatInstructions = mode === 'theater_stage_beat'
    ? `

Special mode: theater stage beat
- Write ONE short parenthetical stage-direction line in ${nativeLanguage} only.
- Third-person narration of a small visible moment (expression, gesture, atmosphere).
- If you mention the partner by name, use exactly "${nickname}" — the user's configured display name.
- Never translate, transliterate, or localize the partner name (e.g. do not write 마틴 for Martin).
- Wrap the whole line in parentheses.
- No dialogue, no quotes inside, no translation, no JSON, no labels.
- Keep it under 36 characters when possible.
- If nothing notable should happen, output exactly: SKIP
`
    : '';

  const realPersonInstructions = '';

  return `You are generating a reply for an idol-style fictional language-learning conversation.

Character nickname (display only): ${nickname}

Persona:
${persona}
${realPersonInstructions}

Language pair:
- Target language (reply in this language): ${targetLanguage}
- Native / familiar language (translation and explanations): ${nativeLanguage}
- User level: ${languageLevel}
${voiceLetterInstructions}
${teacherInstructions}
${theaterInstructions}
${theaterStageBeatInstructions}
${includeStudyVocabularyBlock ? studyVocabularyBlock : ''}

Field separation (critical — do not mix languages across fields):
- "reply" = 原文：仅 ${targetLanguage}，可含表情符号，禁止混入其他语言。
- "translation_zh" = 翻译：使用 ${nativeLanguage} 书写，解释 reply 的意思。
- "romanization" = 发音提示：仅在对目标语言有帮助时输出拉丁转写，禁止写解释。
- Normal chat: always include "translation_zh" and 2-3 short "vocabulary_notes".
${mode === 'voice_letter'
    ? '- "vocabulary_notes" = 语音信模式必须输出空数组 []。'
    : '- "vocabulary_notes" = 单词/短句注解：2–3 条；term 必须是 reply 中出现的词或短短语，禁止整句；explanation_zh 必须写成这个词/短语最常见的字典义，不要写成这句话里的语境义。'}
- When the user level is ${languageLevel}, choose vocabulary that feels appropriate for that level. For near-native or native users, prefer less obvious and more advanced expressions; avoid listing extremely simple words.

Output rules:
-${mode === 'teacher'
    ? ` Return plain text only. No markdown, no JSON, no labels.`
    : mode === 'theater_stage_beat'
    ? ` Return plain text only in ${nativeLanguage}. No markdown, no JSON, no labels.`
    : mode === 'voice_letter'
    ? ` Return one JSON object only. No markdown.
Schema:
{
  "reply": "long ${targetLanguage} monologue for ~1 minute of speech",
  "translation_zh": "full ${nativeLanguage} translation of the entire reply",
  "romanization": "",
  "vocabulary_notes": []
}
Do not shorten "reply". Do not add vocabulary notes.`
    : ` Return one JSON object only. No markdown.
Schema:
{
  "reply": "尽量简洁的 ${targetLanguage} 原文",
  "translation_zh": "翻译",
  "romanization": "latin romanization",
  "vocabulary_notes": [
    {"term":"目标语言词","romanization":"latin","explanation_zh":"根据当前回复语境给出的释义"}
  ]
}`}`;
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
  nativeLanguageCode?: string,
  mode: 'chat' | 'voice_letter' | 'teacher' | 'theater_stage_beat' | 'theater' = 'chat'
): ChatReplyPayload {
  const repaired = repairMisplacedFields(payload, targetLanguageCode, nativeLanguageCode);
  const reply = extractReplyText(repaired.reply, targetLanguageCode);
  const translation_zh = mode === 'teacher' ? '' : extractTextField(repaired.translation_zh, nativeLanguageCode);
  let romanization = mode === 'teacher' ? '' : sanitizeRomanization(repaired.romanization);
  if (looksLikeModelReasoning(romanization)) romanization = '';

  const vocabulary_notes = mode === 'teacher'
    ? []
    : sanitizeVocabularyNotes(
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
  maxTokens?: number;
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
      max_tokens: params.maxTokens ?? 900,
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
          `Pick exactly 3 to 5 SHORT learning items from the target-language reply. Each term must be a single word, particle, ending, or short phrase copied verbatim from the message. Do NOT use the full sentence as a term. Return JSON only: {"vocabulary_notes":[{"term":"","romanization":"","explanation_zh":""}]}. explanation_zh must be written in ${nativeLanguage} and should give the most common dictionary meaning of the term or phrase, not the sentence-specific nuance. If a term has multiple senses, prefer the most common standalone meaning. If a term can be pronounced with a useful Latin transliteration, include romanization; otherwise leave it empty. Target language: ${targetLanguage}.`
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

  return notes.slice(0, 3);
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

function genericVocabularyNotes(
  reply: string,
  targetLanguageCode?: string,
  nativeLanguageCode?: string
): ChatReplyPayload['vocabulary_notes'] {
  const candidates = splitVocabularyCandidates(reply);
  const notes: ChatReplyPayload['vocabulary_notes'] = [];
  const seen = new Set<string>();

  for (const candidate of candidates) {
    const term = trimVocabularyTerm(candidate);
    if (
      !term ||
      seen.has(term) ||
      !isValidGenericVocabularyTerm(term, reply, targetLanguageCode)
    ) {
      continue;
    }

    notes.push({
      term,
      romanization: '',
      explanation_zh: genericVocabularyExplanation(nativeLanguageCode, term.includes(' '), targetLanguageCode)
    });
    seen.add(term);
    if (notes.length >= 3) break;
  }

  if (notes.length < 2) {
    const fallbackTerms = splitFallbackTerms(reply, targetLanguageCode);
    for (const term of fallbackTerms) {
      const trimmed = trimVocabularyTerm(term);
      if (
        !trimmed ||
        seen.has(trimmed) ||
        !isValidGenericVocabularyTerm(trimmed, reply, targetLanguageCode)
      ) {
        continue;
      }

      notes.push({
        term: trimmed,
        romanization: '',
        explanation_zh: genericVocabularyExplanation(nativeLanguageCode, trimmed.includes(' '), targetLanguageCode)
      });
      seen.add(trimmed);
      if (notes.length >= 3) break;
    }
  }

  return notes;
}

function splitVocabularyCandidates(reply: string) {
  const normalized = reply
    .replace(/\n/g, '。')
    .replace(/…/g, '。')
    .replace(/！/g, '!')
    .replace(/？/g, '?');

  return normalized
    .split(/[。.!?;；,，、|]/)
    .map((part) => trimVocabularyTerm(part))
    .filter(Boolean);
}

function splitFallbackTerms(reply: string, targetLanguageCode?: string) {
  const candidates = splitVocabularyCandidates(reply);
  if (candidates.length > 0) return candidates;

  const words = reply
    .split(/\s+/)
    .map((part) => trimVocabularyTerm(part))
    .filter(Boolean);

  if (words.length <= 3) return words;

  const language = (targetLanguageCode || '').toLowerCase();
  if (['en', 'es', 'fr', 'de', 'it', 'pt'].includes(language)) {
    return [words.slice(0, 2).join(' '), words.slice(-2).join(' ')];
  }

  return [words.slice(0, 3).join(''), words.slice(-3).join('')];
}

function trimVocabularyTerm(text: string) {
  return text.trim().replace(/^[“”"'()\[\]{}<>《》【】]+/, '').replace(/[“”"'()\[\]{}<>《》【】]+$/, '').replace(/[.,!?！？。；;:，、]+$/, '').trim();
}

function isValidGenericVocabularyTerm(
  term: string,
  fullText: string,
  targetLanguageCode?: string
) {
  const trimmedTerm = term.trim();
  const trimmedText = fullText.trim();
  if (!trimmedTerm || trimmedTerm === trimmedText) return false;
  if (trimmedTerm.length > 18) return false;
  if (!trimmedText.includes(trimmedTerm)) return false;

  const language = (targetLanguageCode || '').toLowerCase();
  if (language === 'zh' || language === 'zh-hans' || language === 'zh-hant' || language === 'zh-tw') {
    return trimmedTerm.length >= 2;
  }
  if (language === 'ko' || language === 'ja' || language === 'ru') {
    return trimmedTerm.length >= 2;
  }

  const wordCount = trimmedTerm.split(/\s+/).filter(Boolean).length;
  return wordCount >= 1 && wordCount <= 5;
}

function genericVocabularyExplanation(
  nativeLanguageCode?: string,
  isPhrase = false,
  targetLanguageCode?: string
) {
  const native = (nativeLanguageCode || '').toLowerCase();
  const isShortPhrase = isPhrase;

  switch (native) {
    case 'en':
      return isShortPhrase
        ? 'A common phrase used in conversation.'
        : 'A common word used in conversation.';
    case 'ja':
      return isShortPhrase
        ? '会話でよく使う表現です。'
        : '会話でよく使う単語です。';
    case 'ko':
      return isShortPhrase
        ? '대화에서 자주 쓰는 표현이에요.'
        : '대화에서 자주 쓰는 단어예요.';
    case 'es':
      return isShortPhrase
        ? 'Expresión común de conversación.'
        : 'Palabra común de conversación.';
    case 'fr':
      return isShortPhrase
        ? 'Expression courante en conversation.'
        : 'Mot courant en conversation.';
    case 'de':
      return isShortPhrase
        ? 'Häufige Redewendung im Gespräch.'
        : 'Häufiges Wort im Gespräch.';
    case 'it':
      return isShortPhrase
        ? 'Espressione comune nella conversazione.'
        : 'Parola comune nella conversazione.';
    case 'pt':
      return isShortPhrase
        ? 'Expressão comum em conversas.'
        : 'Palavra comum em conversas.';
    case 'ru':
      return isShortPhrase
        ? 'Распространённое выражение в разговоре.'
        : 'Распространённое слово в разговоре.';
    default:
      if ((targetLanguageCode || '').toLowerCase() === 'ko') {
        return isShortPhrase
          ? '常见短语义，按字典常用义记。'
          : '常见单词义，按字典常用义记。';
      }
      return isShortPhrase
        ? '常见短语义，按字典常用义记。'
        : '常见单词义，按字典常用义记。';
  }
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
