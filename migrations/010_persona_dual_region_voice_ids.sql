alter table persona_catalog_configs
  add column if not exists voice_id_mainland text,
  add column if not exists voice_id_overseas text;

-- Preserve any previously configured preset voice while callers migrate to
-- explicit regional IDs.
update persona_catalog_configs
set
  voice_id_mainland = coalesce(voice_id_mainland, voice_id),
  voice_id_overseas = coalesce(voice_id_overseas, voice_id)
where voice_id is not null
  and btrim(voice_id) <> '';
