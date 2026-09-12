import { ok } from '@/lib/response';
import { sql } from '@/lib/db';
import { logIncomingRequest } from '@/lib/request-log';
import {
  buildPersonaCatalogSeedPayload,
  ensurePersonaSeedRows,
  personaCatalogRowsToPayload,
  type PersonaCatalogRow
} from '@/lib/persona-catalog';

export const runtime = 'nodejs';

const OVERSEA_RESOURCE_BASE_URL = 'https://cdn-aidol.tos-cn-hongkong.volces.com/v1/';
const MAINLAND_RESOURCE_BASE_URL = 'https://cdn-cn-aidol.tos-cn-shanghai.volces.com/v1/';

function resolveResourceBaseURL(request: Request) {
  const forwardedHost = request.headers.get('x-forwarded-host');
  const hostHeader = request.headers.get('host');
  const urlHost = new URL(request.url).hostname;
  const hostname = (forwardedHost ?? hostHeader ?? urlHost)
    .split(',')[0]
    .trim()
    .split(':')[0]
    .toLowerCase();

  const isMainland =
    hostname === 'api-cn.aidolapp.site' ||
    hostname.endsWith('.api-cn.aidolapp.site') ||
    hostname === 'localhost' ||
    hostname === '127.0.0.1';

  return isMainland
    ? MAINLAND_RESOURCE_BASE_URL
    : OVERSEA_RESOURCE_BASE_URL;
}

export async function GET(request: Request) {
  logIncomingRequest('personas.list', request);
  const resourceBaseURL = resolveResourceBaseURL(request);

  try {
    await ensurePersonaSeedRows();
    const rows = await sql<PersonaCatalogRow[]>`
      select
        persona_key,
        display_order,
        is_enabled,
        display_name,
        group_name,
        search_aliases,
        persona_style,
        target_languages,
        avatar_path,
        welcome_intro_audio_paths,
        welcome_greeting_audio_paths,
        (
          (voice_id_mainland is not null and btrim(voice_id_mainland) <> '')
          or (voice_id_overseas is not null and btrim(voice_id_overseas) <> '')
          or (voice_id is not null and btrim(voice_id) <> '')
        ) as has_voice,
        source_version,
        updated_at::text
      from persona_catalog_configs
      order by display_order asc, persona_key asc
    `;

    return ok(personaCatalogRowsToPayload(rows, resourceBaseURL), {
      headers: {
        'Cache-Control': 'public, max-age=300, s-maxage=300, stale-while-revalidate=86400'
      }
    });
  } catch (error) {
    console.error('[personas.list] failed, fallback to seed', error);
    return ok(buildPersonaCatalogSeedPayload(resourceBaseURL), {
      headers: {
        'Cache-Control': 'public, max-age=60, s-maxage=60'
      }
    });
  }
}
