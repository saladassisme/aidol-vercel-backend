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
  const hostname = new URL(request.url).hostname.toLowerCase();
  if (hostname.startsWith('api-cn.') || hostname.includes('.api-cn.')) {
    return MAINLAND_RESOURCE_BASE_URL;
  }
  return OVERSEA_RESOURCE_BASE_URL;
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
