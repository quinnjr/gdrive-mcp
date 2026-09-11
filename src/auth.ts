import { OAuth2Client } from 'google-auth-library';
import { drive_v3, google } from 'googleapis';
import type { Config } from './config.js';

export const DRIVE_SCOPES = ['https://www.googleapis.com/auth/drive'];

export class AuthProvider {
  private client: OAuth2Client | null = null;
  private initPromise: Promise<OAuth2Client> | null = null;
  constructor(private readonly config: Config) {}

  getClient(): Promise<OAuth2Client> {
    if (this.client) return Promise.resolve(this.client);
    if (!this.initPromise) {
      this.initPromise = (async () => {
        const client = new OAuth2Client(this.config.clientId, this.config.clientSecret);
        client.setCredentials({ refresh_token: this.config.refreshToken });
        this.client = client;
        this.initPromise = null;
        return client;
      })();
    }
    return this.initPromise;
  }

  async getDrive(): Promise<drive_v3.Drive> {
    return google.drive({ version: 'v3', auth: await this.getClient() });
  }
}
