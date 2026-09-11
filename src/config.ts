export interface Config {
  clientId: string; clientSecret: string; refreshToken: string; port: number;
  apiKey: string | null; inlineLimitBytes: number; logLevel: string; corsOrigins: string[];
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const v = env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

export function getConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const port = env.PORT === undefined || env.PORT === '' ? 3000 : Number(env.PORT);
  if (!Number.isInteger(port) || port <= 0) throw new Error('Invalid PORT: must be a positive integer');
  const mb = env.DRIVE_INLINE_LIMIT_MB === undefined || env.DRIVE_INLINE_LIMIT_MB === '' ? 10 : Number(env.DRIVE_INLINE_LIMIT_MB);
  if (!Number.isFinite(mb) || mb <= 0) throw new Error('Invalid DRIVE_INLINE_LIMIT_MB: must be a positive number');
  return {
    clientId: required(env, 'GOOGLE_CLIENT_ID'),
    clientSecret: required(env, 'GOOGLE_CLIENT_SECRET'),
    refreshToken: required(env, 'GOOGLE_REFRESH_TOKEN'),
    port,
    apiKey: env.API_KEY ? env.API_KEY : null,
    inlineLimitBytes: Math.round(mb * 1024 * 1024),
    logLevel: env.LOG_LEVEL || 'info',
    corsOrigins: (env.CORS_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean),
  };
}
