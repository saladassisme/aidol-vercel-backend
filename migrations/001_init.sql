create table if not exists users (
  id uuid primary key,
  device_id text unique not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists subscriptions (
  id uuid primary key,
  user_id uuid not null references users(id) on delete cascade,
  product_id text not null,
  original_transaction_id text,
  transaction_id text,
  status text not null default 'inactive',
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_subscriptions_user_id on subscriptions(user_id);
create index if not exists idx_subscriptions_original_transaction_id on subscriptions(original_transaction_id);

create table if not exists daily_usage (
  user_id uuid not null references users(id) on delete cascade,
  usage_date date not null,
  chat_reply_count int not null default 0,
  tts_count int not null default 0,
  voice_clone_count int not null default 0,
  primary key (user_id, usage_date)
);

create table if not exists voices (
  id uuid primary key,
  user_id uuid not null references users(id) on delete cascade,
  provider text not null,
  model text not null,
  voice_id text not null,
  display_name text,
  created_at timestamptz not null default now()
);

create index if not exists idx_voices_user_id on voices(user_id);

create table if not exists tts_cache (
  id uuid primary key,
  user_id uuid not null references users(id) on delete cascade,
  voice_id text not null,
  model text not null,
  text_hash text not null,
  audio_url text not null,
  created_at timestamptz not null default now(),
  unique (user_id, voice_id, model, text_hash)
);
