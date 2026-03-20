export declare const openemr: {
    get: <T>(path: string) => Promise<T>;
    post: <T>(path: string, body: Record<string, unknown>) => Promise<T>;
    put: <T>(path: string, body: Record<string, unknown>) => Promise<T>;
    patch: <T>(path: string, body: Record<string, unknown>) => Promise<T>;
    delete: <T>(path: string) => Promise<T>;
};
