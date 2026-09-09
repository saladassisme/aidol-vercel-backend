create table if not exists persona_catalog_configs (
  persona_key text primary key,
  display_order integer not null default 0,
  is_enabled boolean not null default true,
  display_name text not null,
  group_name text not null,
  search_aliases jsonb not null default '[]'::jsonb,
  persona_style jsonb not null default '{}'::jsonb,
  target_languages jsonb not null default '[]'::jsonb,
  avatar_path text,
  voice_id text,
  source_version text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Allows an already-created v3 table to be upgraded in place.
alter table persona_catalog_configs
  add column if not exists source_version text not null default '';

create index if not exists persona_catalog_configs_display_order_idx
  on persona_catalog_configs (display_order asc, persona_key asc);

create index if not exists persona_catalog_configs_enabled_idx
  on persona_catalog_configs (is_enabled)
  where is_enabled = true;

-- This table contains server-only configuration such as Voice IDs. Keep it
-- unavailable to Supabase's public Data API roles; the backend connects with
-- the database service credential instead.
alter table persona_catalog_configs enable row level security;
revoke all on table persona_catalog_configs from anon, authenticated;

create or replace function touch_persona_catalog_configs_updated_at()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists persona_catalog_configs_touch_updated_at
  on persona_catalog_configs;

create trigger persona_catalog_configs_touch_updated_at
before update on persona_catalog_configs
for each row
execute function touch_persona_catalog_configs_updated_at();

revoke execute on function touch_persona_catalog_configs_updated_at() from public;
