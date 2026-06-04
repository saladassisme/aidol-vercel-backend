import { requiredEnv, optionalEnv } from './env';

export type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string };

export async function generateChatReply(params: {
  persona: string;
  nickname: string;
  messages: ChatMessage[];
}) {
  const baseURL = requiredEnv('AI_API_BASE_URL').replace(/\/$/, '');
  const apiKey = requiredEnv('AI_API_KEY');
  const model = optionalEnv('AI_TEXT_MODEL', 'gpt-4o-mini');

  const system = `You are an AI private-chat character. Reply mainly in Korean.\n\nPersona:\n${params.persona}\n\nReturn JSON only with this schema:\n{\n  "reply": "Korean message",\n  "translation_zh": "Simplified Chinese translation",\n  "romanization": "Korean romanization",\n  "vocabulary_notes": [\n    {"term":"Korean word or phrase","romanization":"Latin romanization","explanation_zh":"Chinese explanation"}\n  ]\n}\nDo not include markdown.`;

  const response = await fetch(`${baseURL}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model,
      temperature: 0.75,
      messages: [
        { role: 'system', content: system },
        ...params.messages.slice(-12)
      ]
    })
  });

  const text = await response.text();
  if (!response.ok) throw new Error(`AI provider failed: HTTP ${response.status} ${text}`);
  const json = JSON.parse(text);
  const content = json.choices?.[0]?.message?.content;
  if (!content) throw new Error('AI provider returned empty content.');

  const cleaned = String(content).replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```$/i, '').trim();
  return JSON.parse(cleaned);
}
