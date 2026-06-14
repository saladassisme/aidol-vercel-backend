alter table users
add column if not exists tts_preview_used_at timestamptz;
