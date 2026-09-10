alter table persona_catalog_configs
  add column if not exists welcome_intro_audio_paths jsonb not null default '{}'::jsonb,
  add column if not exists welcome_greeting_audio_paths jsonb not null default '{}'::jsonb;

comment on column persona_catalog_configs.welcome_intro_audio_paths is
  'Native-language code to pre-generated onboarding intro audio CDN path.';

comment on column persona_catalog_configs.welcome_greeting_audio_paths is
  'Target-language code to pre-generated onboarding greeting audio CDN path.';
