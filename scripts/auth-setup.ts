import http from 'node:http';
import { OAuth2Client } from 'google-auth-library';
import { DRIVE_SCOPES } from '../src/auth.js';

export function buildAuthUrl(clientId: string, redirectUri: string): string {
  const tmp = new OAuth2Client(clientId, 'unused-secret', redirectUri);
  return tmp.generateAuthUrl({ access_type: 'offline', scope: DRIVE_SCOPES, prompt: 'consent' });
}

async function main(): Promise<void> {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log('Usage: npm run auth:setup\n\nRequires GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in env.\nPrints GOOGLE_REFRESH_TOKEN to stdout.');
    return;
  }
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error('Missing GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET in env');
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const redirectUri = `http://127.0.0.1:${port}/oauth2callback`;
  const client = new OAuth2Client(clientId, clientSecret, redirectUri);
  const code: string = await new Promise((resolve, reject) => {
    server.on('request', (req, res) => {
      const url = new URL(req.url || '/', redirectUri);
      const c = url.searchParams.get('code');
      const err = url.searchParams.get('error');
      res.end(c ? 'OK — you can close this tab.' : 'Missing code param.');
      server.close();
      if (c) resolve(c);
      else reject(new Error(`OAuth failed: ${err ?? 'no code returned'}`));
    });
    console.log(`Open this URL in your browser:\n\n${buildAuthUrl(clientId, redirectUri)}\n`);
  });
  const { tokens } = await client.getToken(code);
  if (!tokens.refresh_token) throw new Error('No refresh_token returned. Remove app access at myaccount.google.com/permissions and retry.');
  console.log(`\nGOOGLE_REFRESH_TOKEN=${tokens.refresh_token}`);
}

const isMain = process.argv[1]?.endsWith('auth-setup.ts') ?? false;
if (isMain) {
  main().catch((err) => { console.error(String((err as Error)?.message ?? err)); process.exit(1); });
}
