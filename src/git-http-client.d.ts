// Type declaration for the vendored isomorphic-git HTTP client.
declare const http: {
  request: (args: {
    url: string;
    method?: string;
    headers?: Record<string, string>;
    body?: AsyncIterableIterator<Uint8Array>;
    onProgress?: (event: { phase: string; loaded: number; total: number }) => void;
    signal?: AbortSignal;
  }) => Promise<{
    url: string;
    method?: string;
    headers: Record<string, string>;
    body: AsyncIterableIterator<Uint8Array>;
    statusCode: number;
    statusMessage: string;
  }>;
};
export default http;
