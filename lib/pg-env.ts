// @vercel/postgres reads POSTGRES_URL; Supabase integrations usually expose DATABASE_URL.
if (!process.env.POSTGRES_URL?.trim()) {
  const databaseURL = process.env.DATABASE_URL?.trim();
  if (databaseURL) {
    process.env.POSTGRES_URL = databaseURL;
  }
}
