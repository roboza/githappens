import type { ApiError, Me } from '@githappens/cloud-api';

/**
 * Authenticated access to the configured GitHappens Cloud server (spec 14 §5.1), implemented by
 * `CloudClient` (cloud-client.ts). Feature services (patches, team footprints, sync, orgs) take this
 * interface so they can be tested with fakes. Tokens never leave the main process.
 */
export interface CloudHttp {
  /** Configured server origin without trailing slash (`cloud.serverUrl`), or null when cloud is off. */
  serverUrl(): string | null;
  /** Signed-in account, or null. */
  me(): Me | null;
  /** Organization chosen in the account menu (defaults to the first org). */
  activeOrgId(): string | null;
  /**
   * JSON request to `<server><path>` with `Authorization: Bearer` (unless `auth: false`). Refreshes the
   * access token once on 401. Throws `CloudError` for non-2xx responses and network failures.
   */
  request<T>(
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    path: string,
    opts?: {
      body?: unknown;
      headers?: Record<string, string>;
      auth?: boolean | 'optional';
      signal?: AbortSignal;
    },
  ): Promise<{ status: number; data: T; headers: Headers }>;
  /** Raw bytes to/from a presigned URL (patch blobs); no Authorization header. */
  upload(url: string, bytes: Uint8Array, signal?: AbortSignal): Promise<void>;
  download(url: string, signal?: AbortSignal): Promise<Uint8Array>;
  /** Subscribe to sign-in / sign-out / org changes. Returns an unsubscribe function. */
  onSessionChange(listener: () => void): () => void;
}

/** Non-2xx or network failure from the cloud server. `code` mirrors ApiError.error, plus 'network' / 'signed_out'. */
export class CloudError extends Error {
  constructor(
    readonly code: ApiError['error'] | 'network' | 'signed_out' | 'not_configured',
    message: string,
    readonly status?: number,
    readonly body?: ApiError,
  ) {
    super(message);
    this.name = 'CloudError';
  }
}
