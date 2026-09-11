import { OAuth2Client } from 'google-auth-library';
import { drive_v3, google } from 'googleapis';
import type { Config } from './config.js';

export const DRIVE_SCOPES = ['https://www.googleapis.com/auth/drive'];

/**
 * Concurrency contract: one shared OAuth2Client for all callers.
 * Construction is deduplicated via initPromise; token refresh is
 * delegated to google-auth-library's shared client.
 */
export class AuthProvider {
  private client: OAuth2Client | null = null;
  private initPromise: Promise<OAuth2Client> | null = null;
  constructor(private readonly config: Config) {}

  getClient(): Promise<OAuth2Client> {
    if (this.client) return Promise.resolve(this.client);
    if (!this.initPromise) {
      const p = (async () => {
        const client = new OAuth2Client(this.config.clientId, this.config.clientSecret);
        client.setCredentials({ refresh_token: this.config.refreshToken });
        this.client = client;
        return client;
      })();
      this.initPromise = p;
      p.then(
        () => { if (this.initPromise === p) this.initPromise = null; },
        () => { if (this.initPromise === p) this.initPromise = null; },
      );
      return p;
    }
    return this.initPromise;
  }

  async getDrive(): Promise<drive_v3.Drive> {
    return google.drive({ version: 'v3', auth: await this.getClient() });
  }
}
