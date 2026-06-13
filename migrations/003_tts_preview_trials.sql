create table if not exists tts_preview_trials (
  user_id uuid primary key references users(id) on delete cascade,
  consumed_at timestamptz not null default now()
);
