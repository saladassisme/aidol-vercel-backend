alter table daily_usage
add column if not exists theater_session_count int not null default 0;

alter table users
add column if not exists tts_preview_count int not null default 0,
add column if not exists voice_letter_trial_used_at timestamptz,
add column if not exists theater_trial_used_at timestamptz;

create table if not exists quota_usage (
  user_id uuid not null references users(id) on delete cascade,
  quota_key text not null,
  period_key text not null,
  used_count int not null default 0 check (used_count >= 0),
  reserved_count int not null default 0 check (reserved_count >= 0),
  updated_at timestamptz not null default now(),
  primary key (user_id, quota_key, period_key)
);

create table if not exists quota_transactions (
  id uuid primary key,
  user_id uuid not null references users(id) on delete cascade,
  quota_key text not null,
  period_key text not null,
  idempotency_key text not null,
  amount int not null default 1 check (amount > 0),
  status text not null check (status in ('reserved', 'committed', 'released')),
  metadata jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, quota_key, idempotency_key)
);

create index if not exists idx_quota_transactions_user_created
  on quota_transactions (user_id, created_at desc);

create table if not exists voice_letters (
  id uuid primary key,
  user_id uuid not null references users(id) on delete cascade,
  quota_transaction_id uuid references quota_transactions(id),
  quota_period_key text not null,
  profile_id text not null,
  request_key text not null,
  status text not null check (status in ('preparing', 'succeeded', 'failed')),
  reply_payload jsonb,
  audio_url text,
  audio_base64 text,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, quota_period_key),
  unique (user_id, request_key)
);

-- Preserve current counters while moving existing installations to the ledger.
insert into quota_usage (user_id, quota_key, period_key, used_count)
select user_id, 'chat_reply', usage_date::text, chat_reply_count
from daily_usage
where chat_reply_count > 0
on conflict (user_id, quota_key, period_key) do nothing;

insert into quota_usage (user_id, quota_key, period_key, used_count)
select user_id, 'voice_reply', usage_date::text, tts_count
from daily_usage
where tts_count > 0
on conflict (user_id, quota_key, period_key) do nothing;

insert into quota_usage (user_id, quota_key, period_key, used_count)
select user_id, 'theater_session', usage_date::text, theater_session_count
from daily_usage
where theater_session_count > 0
on conflict (user_id, quota_key, period_key) do nothing;

insert into quota_usage (user_id, quota_key, period_key, used_count)
select user_id, 'voice_clone', to_char(usage_date, 'YYYY-MM'), sum(voice_clone_count)::int
from daily_usage
where voice_clone_count > 0
group by user_id, to_char(usage_date, 'YYYY-MM')
on conflict (user_id, quota_key, period_key) do nothing;

insert into quota_usage (user_id, quota_key, period_key, used_count)
select id, 'tts_preview', 'lifetime', greatest(tts_preview_count, 0)
from users
where tts_preview_count > 0
on conflict (user_id, quota_key, period_key) do nothing;

insert into quota_usage (user_id, quota_key, period_key, used_count)
select id, 'voice_letter', 'lifetime', 1
from users
where voice_letter_trial_used_at is not null
on conflict (user_id, quota_key, period_key) do nothing;

insert into quota_usage (user_id, quota_key, period_key, used_count)
select id, 'theater_session', 'lifetime', 1
from users
where theater_trial_used_at is not null
on conflict (user_id, quota_key, period_key) do nothing;
