create table if not exists theater_catalog_configs (
  scenario_key text primary key,
  sort_order integer not null default 0,
  is_enabled boolean not null default true,
  system_image text not null,
  accent_hex text not null,
  backdrop_kind text not null,
  content_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists theater_catalog_configs_sort_order_idx
  on theater_catalog_configs (sort_order asc, scenario_key asc);
