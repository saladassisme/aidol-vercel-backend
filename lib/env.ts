export function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim().length === 0) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export function optionalEnv(name: string, fallback = ''): string {
  const value = process.env[name];
  return value && value.trim().length > 0 ? value : fallback;
}
