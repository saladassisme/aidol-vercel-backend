import { ok } from '@/lib/response';
import { sql } from '@/lib/db';
import { logIncomingRequest } from '@/lib/request-log';
import {
  buildTheaterCatalogSeedPayload,
  theaterCatalogRowsToPayload,
  type TheaterCatalogRow
} from '@/lib/theater-catalog';

export const runtime = 'nodejs';

const OVERSEA_RESOURCE_BASE_URL = 'https://cdn-aidol.tos-cn-hongkong.volces.com/v1/';
const MAINLAND_RESOURCE_BASE_URL = 'https://cdn-cn-aidol.tos-cn-shanghai.volces.com/v1/';

function normalizeLanguageCode(languageCode: string | null) {
  const raw = (languageCode || '').trim();
  if (!raw) return '';
  if (raw === 'zh') return 'zh-Hans';
  return raw;
}

function resolveResourceBaseURL(request: Request) {
  const hostname = new URL(request.url).hostname.toLowerCase();
  if (hostname.startsWith('api-cn.') || hostname.includes('.api-cn.')) {
    return MAINLAND_RESOURCE_BASE_URL;
  }
  return OVERSEA_RESOURCE_BASE_URL;
}

function buildSeedRows(resourceBaseURL: string) {
  const seedPayload = buildTheaterCatalogSeedPayload(resourceBaseURL);
  return seedPayload.scenarios.map((scenario) => [
    scenario.key,
    scenario.sortOrder,
    true,
    scenario.systemImage,
    scenario.accentHex,
    scenario.backdrop,
    JSON.stringify({
      titles: { [seedPayload.resolvedUiLanguageCode]: scenario.title, en: scenario.title },
      subtitles: { [seedPayload.resolvedUiLanguageCode]: scenario.subtitle, en: scenario.subtitle },
      backgroundHints: { [seedPayload.resolvedUiLanguageCode]: scenario.backgroundHint, en: scenario.backgroundHint },
      yourRoles: { [seedPayload.resolvedUiLanguageCode]: scenario.yourRole, en: scenario.yourRole },
      partnerRoles: { [seedPayload.resolvedUiLanguageCode]: scenario.partnerRole, en: scenario.partnerRole },
      objectives: { [seedPayload.resolvedUiLanguageCode]: scenario.objective, en: scenario.objective },
      openingPrompts: { [seedPayload.resolvedUiLanguageCode]: scenario.openingPrompt, en: scenario.openingPrompt },
      personaHints: { [seedPayload.resolvedUiLanguageCode]: scenario.personaHint, en: scenario.personaHint },
      quickReplies: {
        [seedPayload.resolvedUiLanguageCode]: scenario.quickReplies,
        en: scenario.quickReplies
      },
      backgroundImageURL: null,
      ambientAudioURL: null
    })
  ] as const);
}

async function ensureSeedRows(resourceBaseURL: string) {
  const existing = await sql<{ count: string }[]>`select count(*)::text as count from theater_catalog_configs`;
  if ((existing[0]?.count ?? '0') !== '0') return;

  for (const row of buildSeedRows(resourceBaseURL)) {
    await sql`
      insert into theater_catalog_configs (
        scenario_key,
        sort_order,
        is_enabled,
        system_image,
        accent_hex,
        backdrop_kind,
        content_json
      ) values (
        ${row[0]},
        ${row[1]},
        ${row[2]},
        ${row[3]},
        ${row[4]},
        ${row[5]},
        ${row[6]}::jsonb
      )
      on conflict (scenario_key) do nothing
    `;
  }
}

export async function GET(request: Request) {
  logIncomingRequest('theater.scenarios', request);
  try {
    const url = new URL(request.url);
    const resourceBaseURL = resolveResourceBaseURL(request);
    const seedPayload = buildTheaterCatalogSeedPayload(resourceBaseURL);
    const requestedUiLanguageCode = normalizeLanguageCode(url.searchParams.get('uiLanguage')) || seedPayload.resolvedUiLanguageCode;
    const requestedTargetLanguageCode = normalizeLanguageCode(url.searchParams.get('targetLanguage')) || seedPayload.resolvedTargetLanguageCode;

    await ensureSeedRows(resourceBaseURL);

    const rows = await sql<TheaterCatalogRow[]>`
      select
        scenario_key,
        sort_order,
        is_enabled,
        system_image,
        accent_hex,
        backdrop_kind,
        content_json
      from theater_catalog_configs
      order by sort_order asc, scenario_key asc
    `;

    const payload = theaterCatalogRowsToPayload(
      rows,
      requestedUiLanguageCode,
      requestedTargetLanguageCode,
      resourceBaseURL
    );

    return ok(payload, {
      headers: {
        'Cache-Control': 'public, max-age=300, s-maxage=300'
      }
    });
  } catch (error) {
    console.error('[theater.scenarios] failed, fallback to seed', error);
    return ok(buildTheaterCatalogSeedPayload(resolveResourceBaseURL(request)), {
      headers: {
        'Cache-Control': 'public, max-age=300, s-maxage=300'
      }
    });
  }
}
