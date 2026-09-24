alter table group_chats
  add column if not exists preferred_mode text not null default 'learning'
  check (preferred_mode in ('learning', 'chat'));

alter table group_chat_messages
  add column if not exists payload jsonb not null default '{}'::jsonb;

