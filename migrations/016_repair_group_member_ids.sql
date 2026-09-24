-- Older clients sent member_profile_ids as a JSON-encoded string inside jsonb.
-- Normalize those rows so membership checks and future updates see a JSON array.
update group_chats
set member_profile_ids = (member_profile_ids #>> '{}')::jsonb
where jsonb_typeof(member_profile_ids) = 'string'
  and (member_profile_ids #>> '{}') like '[%';
