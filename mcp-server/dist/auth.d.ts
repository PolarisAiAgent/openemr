/**
 * OpenEMR OAuth2 token management.
 * Supports Password Grant (resource owner credentials) — suitable for
 * a trusted backend agent with a dedicated service account.
 */
export interface AuthConfig {
    baseUrl: string;
    clientId: string;
    clientSecret: string;
    username: string;
    password: string;
    site?: string;
}
export declare function getAccessToken(): Promise<string>;
export declare function getBaseUrl(): string;
