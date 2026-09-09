-- Upgrade an existing persona catalog created by the earlier v3 migration.
-- The API uses this marker to apply each bundled source version exactly once.
alter table persona_catalog_configs
  add column if not exists source_version text not null default '';
