alter table tts_cache
  add column if not exists audio_base64 text;
