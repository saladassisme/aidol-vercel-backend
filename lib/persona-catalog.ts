import seedCatalogJSON from '@/data/personas-v3.json';
import { sql } from '@/lib/db';

export type PersonaCatalogSeedItem = {
  key: string;
  displayOrder: number;
  displayName: string;
  group: string;
  searchAliases: string[];
  persona: PersonaCatalogStyle;
  targetLanguages: string[];
  avatarPath?: string | null;
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

function formatPersonaStyleForPrompt(style: PersonaCatalogStyle) {
  const sections: Array<[string, string]> = [
    ['Archetype', style.archetype],
    ['Direction', style.direction],
    ['Chat rhythm', style.chatRhythm],
    ['Tone', style.tone],
    ['Common expression style', style.commonExpressionStyle],
    ['Humor style', style.humorStyle],
    ['Emotional response style', style.emotionalResponseStyle]
  ];

  return sections
    .filter(([, value]) => value.trim().length > 0)
    .map(([label, value]) => `${label}:\n${value.trim()}`)
    .join('\n\n');
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
  return {
    key: item.key,
    displayOrder: item.displayOrder,
    displayName: item.displayName,
    group: item.group,
    searchAliases: item.searchAliases,
    persona: personaStyle(item.persona),
    targetLanguages: item.targetLanguages,
    avatarURL: resolveAssetURL(item.avatarPath, resourceBaseURL),
    hasVoice: false
  };
}

export function buildPersonaCatalogSeedPayload(resourceBaseURL: string): PersonaCatalogPayload {
  return {
    version: seedCatalog.version,
    personas: seedCatalog.personas
      .slice()
      .sort((left, right) => (left.displayOrder - right.displayOrder) || left.key.localeCompare(right.key))
      .map((item) => seedItemToCatalogItem(item, resourceBaseURL))
  };
}

export async function ensurePersonaSeedRows() {
  const existing = await sql<{ count: string }[]>`select count(*)::text as count from persona_catalog_configs`;
  if ((existing[0]?.count ?? '0') !== '0') return;

  const seedRows = seedCatalog.personas.map((item) => ({
    persona_key: item.key,
    display_order: item.displayOrder,
    display_name: item.displayName,
    group_name: item.group,
    search_aliases: item.searchAliases,
    persona_style: item.persona,
    target_languages: item.targetLanguages,
    avatar_path: item.avatarPath ?? null
  }));

  await sql`
    insert into persona_catalog_configs (
      persona_key,
      display_order,
      display_name,
      group_name,
      search_aliases,
      persona_style,
      target_languages,
      avatar_path
    )
    select
      seed.persona_key,
      seed.display_order,
      seed.display_name,
      seed.group_name,
      seed.search_aliases,
      seed.persona_style,
      seed.target_languages,
      seed.avatar_path
    from jsonb_to_recordset(${JSON.stringify(seedRows)}::jsonb) as seed(
      persona_key text,
      display_order integer,
      display_name text,
      group_name text,
      search_aliases jsonb,
      persona_style jsonb,
      target_languages jsonb,
      avatar_path text
    )
    on conflict (persona_key) do nothing
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
      and is_enabled = true
    limit 1
  `;
  const row = rows[0];
  if (!row) return null;

  return {
    displayName: row.display_name,
    group: row.group_name,
    persona: formatPersonaStyleForPrompt(personaStyle(row.persona_style))
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

  return {
    version: `${rows.length}-${latestUpdate || seedCatalog.version}`,
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
