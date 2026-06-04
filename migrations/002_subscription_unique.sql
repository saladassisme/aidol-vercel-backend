-- Required for Apple subscription upsert (on conflict original_transaction_id).
create unique index if not exists idx_subscriptions_original_transaction_id_unique
  on subscriptions (original_transaction_id)
  where original_transaction_id is not null;
