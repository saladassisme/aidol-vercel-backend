create table if not exists group_chat_turns (
  id uuid primary key,
  group_chat_id uuid not null references group_chats(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  message_hash text not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_group_chat_turns_user_created
  on group_chat_turns(user_id, created_at desc);

create table if not exists group_chat_turn_replies (
  turn_id uuid not null references group_chat_turns(id) on delete cascade,
  profile_id text not null,
  reply_payload jsonb not null,
  created_at timestamptz not null default now(),
  primary key (turn_id, profile_id)
);

