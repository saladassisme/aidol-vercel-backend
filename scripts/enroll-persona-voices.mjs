import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import postgres from 'postgres';

const CONFIRMATION_FLAG = '--confirm-authorized';
const manifestPath = process.argv.find((argument) => argument.endsWith('.json'));

if (!process.argv.includes(CONFIRMATION_FLAG) || !manifestPath) {
  throw new Error(`Usage: node --env-file=.env.local scripts/enroll-persona-voices.mjs ${CONFIRMATION_FLAG} /path/to/manifest.json`);
}

const databaseURL = process.env.DATABASE_URL || process.env.POSTGRES_URL;
if (!databaseURL) throw new Error('DATABASE_URL is required.');

const targetModel = process.env.DASHSCOPE_TTS_VC_MODEL || 'qwen3-tts-vc-2026-01-22';
const endpointBase = (value) => value.trim().replace(/\/$/, '').replace(/\/api\/v1$/, '');
const regions = [
  {
    name: 'mainland',
    column: 'voice_id_mainland',
    apiKey: process.env.DASHSCOPE_API_KEY_MAINLAND,
    baseURL: endpointBase(process.env.DASHSCOPE_API_BASE_URL_MAINLAND || 'https://dashscope.aliyuncs.com')
  },
  {
    name: 'overseas',
    column: 'voice_id_overseas',
    apiKey: process.env.DASHSCOPE_API_KEY_OVERSEAS,
    baseURL: endpointBase(process.env.DASHSCOPE_API_BASE_URL_OVERSEAS || 'https://dashscope-intl.aliyuncs.com')
  }
];

for (const region of regions) {
  if (!region.apiKey) throw new Error(`DASHSCOPE_API_KEY_${region.name.toUpperCase()} is required.`);
}

const manifest = JSON.parse(await fs.readFile(path.resolve(manifestPath), 'utf8'));
if (!Array.isArray(manifest) || manifest.length === 0) throw new Error('Manifest must be a non-empty JSON array.');

const catalogJSON = JSON.parse(await fs.readFile(new URL('../data/personas-v7.json', import.meta.url), 'utf8'));
const catalog = new Map(catalogJSON.personas.map((persona) => [persona.key, persona]));
const sql = postgres(databaseURL, { ssl: 'require', max: 1, prepare: false });

function mimeTypeFor(filePath) {
  switch (path.extname(filePath).toLowerCase()) {
    case '.wav': return 'audio/wav';
    case '.mp3': return 'audio/mpeg';
    case '.m4a': return 'audio/mp4';
    default: throw new Error(`Unsupported audio format: ${filePath}`);
  }
}

function preferredName(value) {
  const normalized = value.toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/^_+|_+$/g, '');
  return (`aidol_${normalized || 'voice'}`).slice(0, 32);
}

async function ensureCatalogRow(personaKey) {
  const persona = catalog.get(personaKey);
  if (!persona) throw new Error(`Unknown persona key: ${personaKey}`);
  const profile = persona.profile;
  const languages = Array.isArray(profile?.public_facts?.public_languages)
    ? profile.public_facts.public_languages
    : [];
  await sql`
    insert into persona_catalog_configs (
      persona_key, display_order, is_enabled, display_name, group_name,
      search_aliases, persona_style, target_languages, avatar_path, source_version
    ) values (
      ${persona.key}, ${persona.displayOrder}, ${persona.isEnabled},
      ${profile.identity.display_name}, ${profile.identity.group_or_field},
      ${sql.json(persona.searchAliases || [])}, ${sql.json(profile)},
      ${sql.json(languages)}, ${persona.avatarPath || null}, ${catalogJSON.version}
    )
    on conflict (persona_key) do update set
      display_order = excluded.display_order,
      is_enabled = excluded.is_enabled,
      display_name = excluded.display_name,
      group_name = excluded.group_name,
      search_aliases = excluded.search_aliases,
      persona_style = excluded.persona_style,
      target_languages = excluded.target_languages,
      avatar_path = coalesce(persona_catalog_configs.avatar_path, excluded.avatar_path),
      source_version = excluded.source_version
  `;
}

async function createVoice({ region, audioBytes, mimeType, name }) {
  const response = await fetch(`${region.baseURL}/api/v1/services/audio/tts/customization`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${region.apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'qwen-voice-enrollment',
      input: {
        action: 'create',
        target_model: targetModel,
        preferred_name: name,
        audio: { data: `data:${mimeType};base64,${audioBytes.toString('base64')}` }
      }
    })
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`${region.name} enrollment failed: HTTP ${response.status} ${body}`);
  const json = JSON.parse(body);
  const voiceId = json.output?.voice ?? json.output?.voice_id ?? json.voice;
  if (!voiceId) throw new Error(`${region.name} enrollment returned no Voice ID.`);
  return String(voiceId);
}

try {
  const failures = [];
  for (const item of manifest) {
    const personaKey = String(item.personaKey || '').trim();
    const audioPath = path.resolve(String(item.audioPath || ''));
    const audioBytes = await fs.readFile(audioPath);
    if (audioBytes.length >= 10 * 1024 * 1024) throw new Error(`${audioPath} must be smaller than 10 MB.`);
    await ensureCatalogRow(personaKey);

    const existingRows = await sql`
      select voice_id_mainland, voice_id_overseas
      from persona_catalog_configs
      where persona_key = ${personaKey}
      limit 1
    `;
    const existing = existingRows[0] || {};

    for (const region of regions) {
      if (existing[region.column]) {
        console.log(`${personaKey} ${region.name}: already configured, skipped`);
        continue;
      }
      try {
        const voiceId = await createVoice({
          region,
          audioBytes,
          mimeType: mimeTypeFor(audioPath),
          name: preferredName(item.preferredName || personaKey)
        });
        if (region.name === 'mainland') {
          await sql`update persona_catalog_configs set voice_id_mainland = ${voiceId} where persona_key = ${personaKey}`;
        } else {
          await sql`update persona_catalog_configs set voice_id_overseas = ${voiceId} where persona_key = ${personaKey}`;
        }
        console.log(`${personaKey} ${region.name}: configured`);
      } catch (error) {
        failures.push(`${personaKey} ${region.name}: ${error instanceof Error ? error.message : String(error)}`);
        console.error(`${personaKey} ${region.name}: failed`);
      }
    }
  }
  if (failures.length > 0) {
    throw new Error(`Enrollment completed with failures:\n${failures.join('\n')}`);
  }
} finally {
  await sql.end();
}
