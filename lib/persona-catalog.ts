import seedCatalogJSON from '@/data/personas-v7.json';
import { sql } from '@/lib/db';

export type PersonaCatalogSeedItem = {
  key: string;
  displayOrder: number;
  isEnabled: boolean;
  searchAliases: string[];
  avatarPath?: string | null;
  profile: RichPersonaProfile;
};

type JSONRecord = Record<string, unknown>;

type RichPersonaProfile = {
  identity: {
    display_name: string;
    group_or_field: string;
    profile_type?: string;
    scene?: string;
  };
  public_facts?: JSONRecord;
  persona_observations?: JSONRecord & {
    personality?: string;
    core_vibe?: string;
    speaking_style?: string;
    speaking_parameters?: JSONRecord;
    emotional_reactions?: JSONRecord;
  };
  daily_life?: JSONRecord;
  interests?: unknown[];
  unlikely_topics?: unknown[];
  conversation_gravity?: unknown[];
  member_dynamics?: JSONRecord;
  language_profile?: JSONRecord & {
    public_language_context?: unknown[];
    formality_tendency?: string;
    code_switching?: string;
    speech_rhythm_note?: string;
  };
  fan_appeal?: unknown[];
  behavior_examples?: unknown[];
  metadata?: JSONRecord;
  persona_prompt?: string;
};

export type PersonaCatalogStyle = {
  archetype: string;
  direction: string;
  chatRhythm: string;
  tone: string;
  commonExpressionStyle: string;
  humorStyle: string;
  emotionalResponseStyle: string;
};

export type PersonaCatalogRow = {
  persona_key: string;
  display_order: number;
  is_enabled: boolean;
  display_name: string;
  group_name: string;
  search_aliases: unknown;
  persona_style: unknown;
  target_languages: unknown;
  avatar_path: string | null;
  has_voice: boolean;
  source_version: string;
  updated_at: string;
};

export type PersonaCatalogItem = {
  key: string;
  displayOrder: number;
  displayName: string;
  group: string;
  searchAliases: string[];
  persona: PersonaCatalogStyle;
  targetLanguages: string[];
  avatarURL?: string;
  hasVoice: boolean;
};

export type PersonaCatalogPayload = {
  version: string;
  personas: PersonaCatalogItem[];
};

export type ResolvedPersonaCatalogPrompt = {
  displayName: string;
  group: string;
  persona: string;
};

type PersonaSeedCatalog = {
  version: string;
  personas: PersonaCatalogSeedItem[];
};

const seedCatalog = seedCatalogJSON as PersonaSeedCatalog;

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
}

function personaStyle(value: unknown): PersonaCatalogStyle {
  const style = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const text = (key: string) => typeof style[key] === 'string' ? style[key] as string : '';
  const observations = style.persona_observations && typeof style.persona_observations === 'object'
    ? style.persona_observations as Record<string, unknown>
    : null;
  const language = style.language_profile && typeof style.language_profile === 'object'
    ? style.language_profile as Record<string, unknown>
    : null;
  const reactions = observations?.emotional_reactions && typeof observations.emotional_reactions === 'object'
    ? observations.emotional_reactions as Record<string, unknown>
    : {};

  if (observations) {
    return {
      archetype: typeof observations.core_vibe === 'string' ? observations.core_vibe : '',
      direction: typeof observations.personality === 'string' ? observations.personality : '',
      chatRhythm: typeof observations.speaking_style === 'string' ? observations.speaking_style : '',
      tone: typeof language?.formality_tendency === 'string' ? language.formality_tendency : '',
      commonExpressionStyle: typeof language?.code_switching === 'string' ? language.code_switching : '',
      humorStyle: typeof reactions.when_teasing === 'string' ? reactions.when_teasing : '',
      emotionalResponseStyle: Object.entries(reactions)
        .filter(([, behavior]) => typeof behavior === 'string')
        .map(([state, behavior]) => `${state}: ${behavior}`)
        .join('\n')
    };
  }

  return {
    archetype: text('archetype'),
    direction: text('direction'),
    chatRhythm: text('chatRhythm'),
    tone: text('tone'),
    commonExpressionStyle: text('commonExpressionStyle'),
    humorStyle: text('humorStyle'),
    emotionalResponseStyle: text('emotionalResponseStyle')
  };
}

function ageOnDate(birthDate: string, today = new Date()) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(birthDate);
  if (!match) return undefined;
  const birthYear = Number(match[1]);
  const birthMonth = Number(match[2]);
  const birthDay = Number(match[3]);
  let age = today.getUTCFullYear() - birthYear;
  const beforeBirthday = today.getUTCMonth() + 1 < birthMonth
    || (today.getUTCMonth() + 1 === birthMonth && today.getUTCDate() < birthDay);
  if (beforeBirthday) age -= 1;
  return age >= 0 && age < 130 ? age : undefined;
}

function runtimePersona(value: unknown) {
  const profile = value && typeof value === 'object' ? value as RichPersonaProfile : null;
  if (!profile?.identity || !profile.persona_observations) {
    return { persona_observations: personaStyle(value) };
  }

  const publicFacts = { ...(profile.public_facts ?? {}) };
  delete publicFacts.age_as_of;
  delete publicFacts.age_note;
  if (typeof publicFacts.birth_date === 'string') {
    const age = ageOnDate(publicFacts.birth_date);
    if (age !== undefined) publicFacts.age = age;
  } else {
    delete publicFacts.age;
  }

  // Deliberately omit metadata, fan_appeal and the prebuilt persona_prompt.
  // Global learning/safety/relationship behavior is composed separately.
  return {
    identity: profile.identity,
    public_facts: publicFacts,
    persona_observations: profile.persona_observations,
    daily_life: profile.daily_life ?? {},
    interests: profile.interests ?? [],
    unlikely_topics: profile.unlikely_topics ?? [],
    conversation_gravity: profile.conversation_gravity ?? [],
    member_dynamics: profile.member_dynamics ?? {},
    language_profile: profile.language_profile ?? {},
    behavior_examples: profile.behavior_examples ?? []
  };
}

function formatPersonaForPrompt(value: unknown) {
  return `CURRENT STAR PERSONA (structured public-facing profile):\n${JSON.stringify(runtimePersona(value), null, 2)}`;
}

function ensureTrailingSlash(value: string) {
  return value.endsWith('/') ? value : `${value}/`;
}

function resolveAssetURL(value: string | null | undefined, resourceBaseURL: string) {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return new URL(trimmed.replace(/^\/+/, ''), ensureTrailingSlash(resourceBaseURL)).toString();
}

function seedItemToCatalogItem(item: PersonaCatalogSeedItem, resourceBaseURL: string): PersonaCatalogItem {
  const publicLanguages = item.profile.public_facts?.public_languages;
  return {
    key: item.key,
    displayOrder: item.displayOrder,
    displayName: item.profile.identity.display_name,
    group: item.profile.identity.group_or_field,
    searchAliases: item.searchAliases,
    persona: personaStyle(item.profile),
    targetLanguages: stringArray(publicLanguages),
    avatarURL: resolveAssetURL(item.avatarPath, resourceBaseURL),
    hasVoice: false
  };
}

export function buildPersonaCatalogSeedPayload(resourceBaseURL: string): PersonaCatalogPayload {
  return {
    version: seedCatalog.version,
    personas: seedCatalog.personas
      .filter((item) => item.isEnabled)
      .slice()
      .sort((left, right) => (left.displayOrder - right.displayOrder) || left.key.localeCompare(right.key))
      .map((item) => seedItemToCatalogItem(item, resourceBaseURL))
  };
}

export async function ensurePersonaSeedRows() {
  const existing = await sql<{ count: string }[]>`
    select count(*)::text as count
    from persona_catalog_configs
    where source_version = ${seedCatalog.version}
  `;
  if (Number(existing[0]?.count ?? 0) >= seedCatalog.personas.length) return;

  const seedRows = seedCatalog.personas.map((item) => ({
    persona_key: item.key,
    display_order: item.displayOrder,
    is_enabled: item.isEnabled,
    display_name: item.profile.identity.display_name,
    group_name: item.profile.identity.group_or_field,
    search_aliases: item.searchAliases,
    persona_style: item.profile,
    target_languages: stringArray(item.profile.public_facts?.public_languages),
    avatar_path: item.avatarPath ?? null,
    source_version: seedCatalog.version
  }));

  await sql`
    insert into persona_catalog_configs (
      persona_key,
      display_order,
      is_enabled,
      display_name,
      group_name,
      search_aliases,
      persona_style,
      target_languages,
      avatar_path,
      source_version
    )
    select
      seed.persona_key,
      seed.display_order,
      seed.is_enabled,
      seed.display_name,
      seed.group_name,
      seed.search_aliases,
      seed.persona_style,
      seed.target_languages,
      seed.avatar_path,
      seed.source_version
    from jsonb_to_recordset(${sql.json(JSON.parse(JSON.stringify(seedRows)))}) as seed(
      persona_key text,
      display_order integer,
      is_enabled boolean,
      display_name text,
      group_name text,
      search_aliases jsonb,
      persona_style jsonb,
      target_languages jsonb,
      avatar_path text,
      source_version text
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

export async function resolvePersonaCatalogPrompt(
  personaKey: string
): Promise<ResolvedPersonaCatalogPrompt | null> {
  await ensurePersonaSeedRows();
  const rows = await sql<Array<{
    display_name: string;
    group_name: string;
    persona_style: unknown;
  }>>`
    select display_name, group_name, persona_style
    from persona_catalog_configs
    where persona_key = ${personaKey}
    limit 1
  `;
  const row = rows[0];
  if (!row) return null;

  return {
    displayName: row.display_name,
    group: row.group_name,
    persona: formatPersonaForPrompt(row.persona_style)
  };
}

export function personaCatalogRowsToPayload(
  rows: PersonaCatalogRow[],
  resourceBaseURL: string
): PersonaCatalogPayload {
  const latestUpdate = rows.reduce(
    (latest, row) => row.updated_at > latest ? row.updated_at : latest,
    ''
  );
  const sourceVersion = rows
    .map((row) => row.source_version)
    .filter(Boolean)
    .sort()
    .at(-1) || seedCatalog.version;

  return {
    version: `${sourceVersion}-${rows.length}-${latestUpdate}`,
    personas: rows
      .filter((row) => row.is_enabled)
      .sort((left, right) => (left.display_order - right.display_order) || left.persona_key.localeCompare(right.persona_key))
      .map((row) => ({
        key: row.persona_key,
        displayOrder: row.display_order,
        displayName: row.display_name,
        group: row.group_name,
        searchAliases: stringArray(row.search_aliases),
        persona: personaStyle(row.persona_style),
        targetLanguages: stringArray(row.target_languages),
        avatarURL: resolveAssetURL(row.avatar_path, resourceBaseURL),
        hasVoice: row.has_voice
      }))
  };
}
