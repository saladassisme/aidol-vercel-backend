-- All runtime quota reads/writes now use quota_usage and quota_transactions.
-- The old daily_usage table is retained only in migration history, not at runtime.
drop table if exists daily_usage;
