-- Group chat history is local-only. The backend keeps only short-lived turn
-- idempotency records needed to deduplicate AI replies.
do $$
begin
  if exists (
    select 1
    from pg_constraint
    where conrelid = 'group_chat_turns'::regclass
      and conname = 'group_chat_turns_group_chat_id_fkey'
  ) then
    alter table group_chat_turns
      drop constraint group_chat_turns_group_chat_id_fkey;
  end if;
end $$;

comment on table group_chat_turns is
  'Ephemeral group reply idempotency records only; chat history is owned by the client.';

create index if not exists idx_group_chat_turns_created_at
  on group_chat_turns (created_at);
