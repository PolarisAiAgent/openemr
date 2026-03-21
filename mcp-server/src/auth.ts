/**
 * OpenEMR OAuth2 token management.
 * Supports Password Grant (resource owner credentials) — suitable for
 * a trusted backend agent with a dedicated service account.
 */

interface TokenResponse {
  access_token: string;
  expires_in: number;
  token_type: string;
}

interface TokenCache {
  token: string;
  expiresAt: number;
}

let cache: TokenCache | null = null;

export interface AuthConfig {
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  username: string;
  password: string;
  site?: string; // default: "default"
}

function getConfig(): AuthConfig {
  const required = ['OPENEMR_BASE_URL', 'OPENEMR_CLIENT_ID', 'OPENEMR_CLIENT_SECRET', 'OPENEMR_USERNAME', 'OPENEMR_PASSWORD'];
  for (const key of required) {
    if (!process.env[key]) {
      throw new Error(`Missing required environment variable: ${key}`);
    }
  }
  return {
    baseUrl: process.env.OPENEMR_BASE_URL!.replace(/\/$/, ''),
    clientId: process.env.OPENEMR_CLIENT_ID!,
    clientSecret: process.env.OPENEMR_CLIENT_SECRET!,
    username: process.env.OPENEMR_USERNAME!,
    password: process.env.OPENEMR_PASSWORD!,
    site: process.env.OPENEMR_SITE ?? 'default',
  };
}

export async function getAccessToken(): Promise<string> {
  const now = Date.now();
  if (cache && cache.expiresAt > now + 30_000) {
    return cache.token;
  }

  const config = getConfig();
  const tokenUrl = `${config.baseUrl}/oauth2/${config.site}/token`;

  const body = new URLSearchParams({
    grant_type: 'password',
    client_id: config.clientId,
    client_secret: config.clientSecret,
    username: config.username,
    password: config.password,
    scope: 'openid api:oemr user/Patient.read user/Appointment.read user/Appointment.write',
  });

  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`OAuth2 token request failed (${response.status}): ${text}`);
  }

  const data = (await response.json()) as TokenResponse;
  cache = {
    token: data.access_token,
    expiresAt: now + data.expires_in * 1000,
  };

  return cache.token;
}

export function getBaseUrl(): string {
  return getConfig().baseUrl;
}
