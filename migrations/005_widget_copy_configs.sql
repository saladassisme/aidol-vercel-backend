create table if not exists widget_copy_configs (
  language_code text primary key,
  medium_messages jsonb not null default '[]'::jsonb,
  small_messages jsonb not null default '[]'::jsonb,
  empty_medium_message text not null default '',
  empty_small_message text not null default '',
  gallery_display_name text not null default '',
  gallery_description text not null default '',
  updated_at timestamptz not null default now()
);

create index if not exists idx_widget_copy_configs_updated_at
  on widget_copy_configs(updated_at desc);
