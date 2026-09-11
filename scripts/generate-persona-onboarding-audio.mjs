import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import postgres from 'postgres';

const CONFIRMATION_FLAG = '--confirm-authorized';
if (!process.argv.includes(CONFIRMATION_FLAG)) {
  throw new Error(`Usage: node --env-file=.env.local scripts/generate-persona-onboarding-audio.mjs ${CONFIRMATION_FLAG} [--output /path]`);
}

function argumentValue(flag, fallback) {
  const index = process.argv.indexOf(flag);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const outputRoot = path.resolve(argumentValue('--output', '/private/tmp/aidol-onboarding-audio'));
const requestedPersonaKeys = argumentValue('--persona-keys', '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);
const databaseURL = process.env.DATABASE_URL || process.env.POSTGRES_URL;
if (!databaseURL) throw new Error('DATABASE_URL is required.');

const targetModel = process.env.DASHSCOPE_TTS_VC_MODEL || 'qwen3-tts-vc-2026-01-22';
const endpointBase = (value) => value.trim().replace(/\/$/, '').replace(/\/api\/v1$/, '');
const allRegions = [
  {
    name: 'mainland',
    voiceColumn: 'voice_id_mainland',
    apiKey: process.env.DASHSCOPE_API_KEY_MAINLAND,
    baseURL: endpointBase(process.env.DASHSCOPE_API_BASE_URL_MAINLAND || 'https://dashscope.aliyuncs.com')
  },
  {
    name: 'overseas',
    voiceColumn: 'voice_id_overseas',
    apiKey: process.env.DASHSCOPE_API_KEY_OVERSEAS,
    baseURL: endpointBase(process.env.DASHSCOPE_API_BASE_URL_OVERSEAS || 'https://dashscope-intl.aliyuncs.com')
  }
];
const requestedRegions = argumentValue('--regions', 'both');
const regions = requestedRegions === 'both'
  ? allRegions
  : allRegions.filter((region) => region.name === requestedRegions);
if (regions.length === 0) throw new Error('--regions must be mainland, overseas, or both.');

for (const region of regions) {
  if (!region.apiKey) throw new Error(`DASHSCOPE_API_KEY_${region.name.toUpperCase()} is required.`);
}

const languages = [
  { code: 'en', type: 'English', intro: "Hello, I'm your Aidol", greeting: 'Hello' },
  { code: 'ja', type: 'Japanese', intro: 'こんにちは、私はあなたのAidolだよ', greeting: 'こんにちは' },
  { code: 'zh-Hant', type: 'Chinese', intro: '你好，我是你的 Aidol', greeting: '你好呀' },
  { code: 'zh-Hans', type: 'Chinese', intro: '你好，我是你的 Aidol', greeting: '你好呀' },
  { code: 'id', type: 'Auto', intro: 'Halo, aku Aidol-mu', greeting: 'Halo' },
  { code: 'ko', type: 'Korean', intro: '안녕하세요, 나는 네 Aidol이야', greeting: '안녕하세요' },
  { code: 'th', type: 'Auto', intro: 'สวัสดี ฉันคือ Aidol ของคุณ', greeting: 'สวัสดี' },
  { code: 'es', type: 'Spanish', intro: '¡Hola! Soy tu Aidol', greeting: 'Hola' },
  { code: 'pt', type: 'Portuguese', intro: 'Olá, eu sou seu Aidol', greeting: 'Olá' },
  { code: 'yue-HK', type: 'Chinese', intro: '你好呀，我係你嘅 Aidol', greeting: '你好呀' },
  { code: 'fr', type: 'French', intro: 'Bonjour, je suis ton Aidol', greeting: 'Bonjour' },
  { code: 'de', type: 'German', intro: 'Hallo, ich bin dein Aidol', greeting: 'Hallo' },
  { code: 'it', type: 'Italian', intro: 'Ciao, sono il tuo Aidol', greeting: 'Ciao' },
  { code: 'ru', type: 'Russian', intro: 'Привет, я твой Aidol', greeting: 'Привет' }
];

const sql = postgres(databaseURL, { ssl: 'require', max: 1, prepare: false });
const personas = await sql`
  select persona_key, voice_id_mainland, voice_id_overseas
  from persona_catalog_configs
  where length(btrim(coalesce(voice_id_mainland, ''))) > 0
    and length(btrim(coalesce(voice_id_overseas, ''))) > 0
  order by display_order, persona_key
`;
await sql.end();

if (personas.length === 0) throw new Error('No personas have both regional Voice IDs.');
const selectedPersonas = requestedPersonaKeys.length > 0
  ? personas.filter((persona) => requestedPersonaKeys.includes(persona.persona_key))
  : personas;
if (requestedPersonaKeys.length > 0 && selectedPersonas.length !== requestedPersonaKeys.length) {
  const available = new Set(selectedPersonas.map((persona) => persona.persona_key));
  throw new Error(`Unknown or incomplete regional Voice IDs for: ${requestedPersonaKeys.filter((key) => !available.has(key)).join(', ')}`);
}

async function synthesize(region, voiceId, text, languageType) {
  const response = await fetch(`${region.baseURL}/api/v1/services/aigc/multimodal-generation/generation`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${region.apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: targetModel,
      input: { text, voice: voiceId, language_type: languageType }
    })
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`synthesis HTTP ${response.status}: ${body.slice(0, 300)}`);
  const json = JSON.parse(body);
  const audioURL = json.output?.audio?.url ?? json.output?.audio_url ?? json.audio_url;
  if (!audioURL) throw new Error('synthesis returned no audio URL');
  const audioResponse = await fetch(String(audioURL).replace(/^http:\/\//, 'https://'));
  if (!audioResponse.ok) throw new Error(`audio download HTTP ${audioResponse.status}`);
  const bytes = Buffer.from(await audioResponse.arrayBuffer());
  if (!bytes.length) throw new Error('audio download returned an empty file');
  return bytes;
}

const tasks = [];
const mappings = {};
for (const persona of selectedPersonas) {
  mappings[persona.persona_key] = { intro: {}, greeting: {} };
  for (const language of languages) {
    const basePath = `personas/${persona.persona_key}/onboarding`;
    mappings[persona.persona_key].intro[language.code] = `${basePath}/intro/${language.code}.wav`;
    mappings[persona.persona_key].greeting[language.code] = `${basePath}/greeting/${language.code}.wav`;
    for (const region of regions) {
      for (const kind of ['intro', 'greeting']) {
        tasks.push({ persona, language, region, kind });
      }
    }
  }
}

await fs.mkdir(outputRoot, { recursive: true });
const failures = [];
let completed = 0;

async function runTask(task) {
  const { persona, language, region, kind } = task;
  const relativePath = mappings[persona.persona_key][kind][language.code];
  const outputPath = path.join(outputRoot, region.name, relativePath);
  try {
    const existing = await fs.stat(outputPath).catch(() => null);
    if (!existing?.size) {
      const voiceId = persona[region.voiceColumn];
      let bytes;
      let lastError;
      for (let attempt = 1; attempt <= 4; attempt += 1) {
        try {
          bytes = await synthesize(region, voiceId, language[kind], language.type);
          break;
        } catch (error) {
          lastError = error;
          if (attempt < 4) await new Promise((resolve) => setTimeout(resolve, attempt * 2_000));
        }
      }
      if (!bytes) throw lastError;
      await fs.mkdir(path.dirname(outputPath), { recursive: true });
      await fs.writeFile(outputPath, bytes);
    }
    completed += 1;
    console.log(`[${completed}/${tasks.length}] ${persona.persona_key} ${region.name} ${kind} ${language.code}`);
  } catch (error) {
    completed += 1;
    const message = `${persona.persona_key} ${region.name} ${kind} ${language.code}: ${error instanceof Error ? error.message : String(error)}`;
    failures.push(message);
    console.error(`[${completed}/${tasks.length}] FAILED ${message}`);
  }
}

const queue = [...tasks];
const workerCount = Math.max(1, Math.min(4, Number(argumentValue('--concurrency', '1')) || 1));
const workers = Array.from({ length: workerCount }, async () => {
  while (queue.length > 0) {
    const task = queue.shift();
    if (task) await runTask(task);
  }
});
await Promise.all(workers);

await fs.writeFile(path.join(outputRoot, 'catalog-audio-paths.json'), `${JSON.stringify(mappings, null, 2)}\n`);
await fs.writeFile(path.join(outputRoot, 'failures.txt'), failures.length ? `${failures.join('\n')}\n` : '');

console.log(`Generated files: ${completed - failures.length}/${tasks.length}`);
console.log(`Output: ${outputRoot}`);
if (failures.length > 0) process.exitCode = 1;
