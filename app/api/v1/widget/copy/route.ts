import { ok } from '@/lib/response';
import { sql } from '@/lib/db';
import { logIncomingRequest } from '@/lib/request-log';
import { widgetCopySeedPayload, type WidgetCopyPayload } from '@/lib/widget-copy';

export const runtime = 'nodejs';

type WidgetCopyRow = {
  language_code: string;
  medium_messages: string[] | null;
  small_messages: string[] | null;
  empty_medium_message: string | null;
  empty_small_message: string | null;
  gallery_display_name: string | null;
  gallery_description: string | null;
};

function normalizeLanguageCode(languageCode: string) {
  if (languageCode === 'zh') return 'zh-Hans';
  return languageCode;
}

function seedRowTuples() {
  return Object.entries(widgetCopySeedPayload.packs).map(([languageCode, pack]) => [
    normalizeLanguageCode(languageCode),
    JSON.stringify(pack.mediumMessages),
    JSON.stringify(pack.smallMessages),
    pack.emptyMediumMessage,
    pack.emptySmallMessage,
    pack.galleryDisplayName,
    pack.galleryDescription
  ] as const);
}

async function ensureSeedRows() {
  const existing = await sql<{ count: string }[]>`select count(*)::text as count from widget_copy_configs`;
  if ((existing[0]?.count ?? '0') !== '0') return;

  const rows = seedRowTuples();
  for (const row of rows) {
    await sql`
      insert into widget_copy_configs (
        language_code,
        medium_messages,
        small_messages,
        empty_medium_message,
        empty_small_message,
        gallery_display_name,
        gallery_description
      ) values (
        ${row[0]},
        ${row[1]}::jsonb,
        ${row[2]}::jsonb,
        ${row[3]},
        ${row[4]},
        ${row[5]},
        ${row[6]}
      )
      on conflict (language_code) do nothing
    `;
  }
}

function rowsToPayload(rows: WidgetCopyRow[]): WidgetCopyPayload {
  if (rows.length === 0) {
    return widgetCopySeedPayload;
  }

  const packs = Object.fromEntries(
    rows.map((row) => [
      normalizeLanguageCode(row.language_code),
      {
        mediumMessages: Array.isArray(row.medium_messages) ? row.medium_messages : [],
        smallMessages: Array.isArray(row.small_messages) ? row.small_messages : [],
        emptyMediumMessage: row.empty_medium_message || '',
        emptySmallMessage: row.empty_small_message || '',
        galleryDisplayName: row.gallery_display_name || '',
        galleryDescription: row.gallery_description || ''
      }
    ])
  );

  return { packs };
}

export async function GET(request: Request) {
  logIncomingRequest('widget.copy', request);
  try {
    await ensureSeedRows();
    const rows = await sql<WidgetCopyRow[]>`
      select
        language_code,
        medium_messages,
        small_messages,
        empty_medium_message,
        empty_small_message,
        gallery_display_name,
        gallery_description
      from widget_copy_configs
      order by language_code asc
    `;

    return ok(rowsToPayload(rows), {
      headers: {
        'Cache-Control': 'public, max-age=300, s-maxage=300'
      }
    });
  } catch (error) {
    console.error('[widget.copy] failed, fallback to seed', error);
    return ok(widgetCopySeedPayload, {
      headers: {
        'Cache-Control': 'public, max-age=300, s-maxage=300'
      }
    });
  }
}
