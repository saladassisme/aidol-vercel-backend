create table if not exists group_chats (
  id uuid primary key,
  user_id uuid not null references users(id) on delete cascade,
  name text not null,
  member_profile_ids jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_group_chats_user_updated
  on group_chats(user_id, updated_at desc);

create table if not exists group_chat_messages (
  id uuid primary key,
  group_chat_id uuid not null references group_chats(id) on delete cascade,
  sender_type text not null check (sender_type in ('user', 'ai', 'system')),
  sender_profile_id text,
  content_type text not null default 'text',
  content text not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_group_chat_messages_group_created
  on group_chat_messages(group_chat_id, created_at asc);
