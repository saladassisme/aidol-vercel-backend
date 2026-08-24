alter table users
  add column if not exists tts_preview_count int not null default 0;

update users
set tts_preview_count = 1
where tts_preview_count = 0
  and tts_preview_used_at is not null;
