-- Required for Apple subscription deduplication.
-- Note: partial unique indexes cannot be used directly by INSERT ... ON CONFLICT (column),
-- so application code uses update-then-insert. Run this in Supabase SQL editor if missing.
create unique index if not exists idx_subscriptions_original_transaction_id_unique
  on subscriptions (original_transaction_id)
  where original_transaction_id is not null;
