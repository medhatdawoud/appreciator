import type { ButtonPublicConfig, ClickCounts } from '@appreciator/shared';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

interface ErrorBody {
  error?: unknown;
  message?: unknown;
}

async function readErrorBody(response: Response): Promise<ErrorBody> {
  try {
    const body: unknown = await response.json();
    return typeof body === 'object' && body !== null ? (body as ErrorBody) : {};
  } catch {
    return {};
  }
}

/** Thin client for the public button endpoints. Visitor identity is derived server-side. */
export class ApiClient {
  private readonly base: string;

  constructor(baseUrl: string, publicKey: string) {
    this.base = `${baseUrl.replace(/\/+$/, '')}/v1/buttons/${encodeURIComponent(publicKey)}`;
  }

  getConfig(): Promise<ButtonPublicConfig> {
    return this.request<ButtonPublicConfig>(`${this.base}/config`);
  }

  getState(item: string): Promise<ClickCounts> {
    const query = new URLSearchParams({ item });
    return this.request<ClickCounts>(`${this.base}/state?${query.toString()}`);
  }

  click(item: string): Promise<ClickCounts> {
    return this.request<ClickCounts>(`${this.base}/click`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ item }),
    });
  }

  private async request<T>(url: string, init: RequestInit = {}): Promise<T> {
    let response: Response;
    try {
      response = await fetch(url, { ...init, mode: 'cors', credentials: 'omit' });
    } catch {
      throw new ApiError(0, 'network_error', `Could not reach ${url}`);
    }

    if (!response.ok) {
      const body = await readErrorBody(response);
      throw new ApiError(
        response.status,
        typeof body.error === 'string' ? body.error : 'request_failed',
        typeof body.message === 'string'
          ? body.message
          : `Request failed with status ${response.status}`,
      );
    }

    return (await response.json()) as T;
  }
}
