/**
 * HTTP client for the OpenEMR REST API.
 * All requests are authenticated via the OAuth2 bearer token.
 */
import { getAccessToken, getBaseUrl } from './auth.js';
async function request(method, path, body) {
    const token = await getAccessToken();
    const url = `${getBaseUrl()}/apis/default${path}`;
    const init = {
        method,
        headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
        },
    };
    if (body !== undefined) {
        init.body = JSON.stringify(body);
    }
    const response = await fetch(url, init);
    if (!response.ok) {
        const text = await response.text();
        throw new Error(`OpenEMR API error ${response.status} ${method} ${path}: ${text}`);
    }
    // 204 No Content
    if (response.status === 204) {
        return undefined;
    }
    return response.json();
}
export const openemr = {
    get: (path) => request('GET', path),
    post: (path, body) => request('POST', path, body),
    put: (path, body) => request('PUT', path, body),
    patch: (path, body) => request('PATCH', path, body),
    delete: (path) => request('DELETE', path),
};
