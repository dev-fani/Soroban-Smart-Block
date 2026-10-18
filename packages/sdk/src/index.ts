/**
 * Soroban Smart Block Explorer TypeScript SDK
 *
 * Thin fetch wrapper for consuming the Soroban Smart Block Explorer API.
 *
 * Note: Generated type definitions (api.types.ts) are produced by openapi-typescript.
 * Run `npm run generate-types` to generate them against docs/api/openapi.yaml.
 */

import type { ClientConfig, RequestOptions, ResponseMetadata, ApiResponse } from './types.js';
import { createApiError, CancelledError, NetworkError, TimeoutError } from './errors.js';
import type { EventIterator, EventRecord, IterateEventsOptions } from './events.js';
import { createEventIterator } from './events.js';

export type { ClientConfig, RequestOptions, ResponseMetadata, ApiResponse } from './types.js';
export {
  ExplorerError,
  ApiError,
  ValidationError,
  AuthenticationError,
  AuthorizationError,
  NotFoundError,
  ConflictError,
  RateLimitError,
  ServerError,
  NetworkError,
  TimeoutError,
  CancelledError,
  createApiError,
  isRetryableStatus,
  SDK_ERROR_CODES,
} from './errors.js';
export { createEventIterator, collectEvents } from './events.js';
export type { EventRecord, EventPage, EventQuery, EventIterator, IterateEventsOptions, PartialDataWarning } from './events.js';

/**
 * Combine a caller-supplied signal with the client timeout so cancellation
 * does not silently disable the timeout (and vice versa).
 */
function withTimeout(userSignal: AbortSignal | null | undefined, ms: number): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(ms);
  if (!userSignal) return timeoutSignal;
  if (typeof AbortSignal.any === 'function') {
    return AbortSignal.any([userSignal, timeoutSignal]);
  }
  const controller = new AbortController();
  if (userSignal.aborted) {
    controller.abort(userSignal.reason);
  } else {
    userSignal.addEventListener('abort', () => controller.abort(userSignal.reason), { once: true });
  }
  timeoutSignal.addEventListener('abort', () => controller.abort(timeoutSignal.reason), { once: true });
  return controller.signal;
}

export { signRequest } from "./signing.js";
export type { SignRequestInput } from "./signing.js";

export class ExplorerApiClient {
  private baseUrl: string;
  private apiKey?: string;
  private bearerToken?: string;
  private csrfToken?: string;
  private timeout: number;
  private defaultHeaders: Record<string, string>;

  constructor(config: ClientConfig = {}) {
    this.baseUrl = config.baseUrl || 'http://localhost:3001';
    this.apiKey = config.apiKey;
    this.bearerToken = config.bearerToken;
    this.csrfToken = config.csrfToken;
    this.timeout = config.timeout || 30000;
    this.defaultHeaders = {
      'Content-Type': 'application/json',
      ...config.headers,
    };
  }

  /**
   * Fetch a CSRF token from the server.
   * Must be called before making state-changing requests (POST/PATCH/DELETE).
   */
  async fetchCsrfToken(): Promise<{ csrfToken: string }> {
    const response = await this.request<{ csrfToken: string }>('GET', '/api/csrf-token', {
      credentials: 'include',
    });
    this.csrfToken = response.data.csrfToken;
    return response.data;
  }

  /**
   * Make an HTTP request to the API.
   */
  async request<T>(
    method: string,
    endpoint: string,
    options: RequestOptions = {}
  ): Promise<ApiResponse<T>> {
    const { params, signal, ...rest } = options;
    const url = this.buildUrl(endpoint, params);
    const headers = this.buildHeaders(method);
    const fetchOptions: RequestInit = {
      method,
      headers,
      ...rest,
      signal: withTimeout(signal, this.timeout),
      body: options.body ? JSON.stringify(options.body) : undefined,
    };

    let response: Response;
    try {
      response = await fetch(url, fetchOptions);
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        // Distinguish caller cancellation from a client timeout.
        if (signal?.aborted) {
          throw new CancelledError('Request cancelled by caller', { cause: error });
        }
        throw new TimeoutError(`Request timeout after ${this.timeout}ms`, {
          timeoutMs: this.timeout,
          cause: error,
        });
      }
      if (error instanceof TypeError) {
        throw new NetworkError(`Network error: ${error.message}`, { cause: error });
      }
      throw error;
    }

    const data = await this.parseResponse<T>(response);
    const meta = this.extractMetadata(response);

    if (!response.ok) {
      throw createApiError(response.status, response.statusText, data, meta);
    }

    return { data, meta };
  }

  /**
   * Iterate events with automatic cursor pagination (#1080).
   *
   * Returns a lazy, cancellable async iterator that follows `next_cursor`
   * across pages. See `IterateEventsOptions` for filters, page size, bounds
   * and cancellation.
   *
   * ```ts
   * for await (const event of client.iterateEvents({ contract: 'C...', limit: 100 })) {
   *   // ...
   * }
   * ```
   */
  iterateEvents<T = EventRecord>(
    options: IterateEventsOptions = {},
  ): EventIterator<T> {
    return createEventIterator<T>(this, options, '/api/events');
  }

  /**
   * GET request helper.
   */
  async get<T>(
    endpoint: string,
    options: Omit<RequestOptions, 'body'> = {}
  ): Promise<ApiResponse<T>> {
    return this.request<T>('GET', endpoint, options);
  }

  /**
   * POST request helper.
   */
  async post<T>(
    endpoint: string,
    body?: unknown,
    options: Omit<RequestOptions, 'body'> = {}
  ): Promise<ApiResponse<T>> {
    return this.request<T>('POST', endpoint, { ...options, body });
  }

  /**
   * PATCH request helper.
   */
  async patch<T>(
    endpoint: string,
    body?: unknown,
    options: Omit<RequestOptions, 'body'> = {}
  ): Promise<ApiResponse<T>> {
    return this.request<T>('PATCH', endpoint, { ...options, body });
  }

  /**
   * DELETE request helper.
   */
  async delete<T>(
    endpoint: string,
    options: Omit<RequestOptions, 'body'> = {}
  ): Promise<ApiResponse<T>> {
    return this.request<T>('DELETE', endpoint, options);
  }

  private buildUrl(endpoint: string, params?: Record<string, string | number | boolean | undefined>): string {
    const url = new URL(endpoint, this.baseUrl);
    if (params) {
      Object.entries(params).forEach(([key, value]) => {
        if (value !== undefined) {
          url.searchParams.append(key, String(value));
        }
      });
    }
    return url.toString();
  }

  private buildHeaders(method: string): Headers {
    const headers = new Headers(this.defaultHeaders);

    if (this.apiKey) {
      headers.set('X-API-Key', this.apiKey);
    }

    if (this.bearerToken) {
      headers.set('Authorization', `Bearer ${this.bearerToken}`);
    }

    if (['POST', 'PATCH', 'DELETE'].includes(method.toUpperCase()) && this.csrfToken) {
      headers.set('X-CSRF-Token', this.csrfToken);
    }

    return headers;
  }

  private async parseResponse<T>(response: Response): Promise<T> {
    const contentType = response.headers.get('content-type');
    if (contentType?.includes('application/json')) {
      try {
        return (await response.json()) as T;
      } catch {
        throw new Error('Failed to parse JSON response');
      }
    }
    return (await response.text()) as unknown as T;
  }

  private extractMetadata(response: Response): ResponseMetadata {
    return {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
      rateLimitLimit: this.parseHeaderAsNumber(response.headers.get('X-RateLimit-Limit')),
      rateLimitRemaining: this.parseHeaderAsNumber(response.headers.get('X-RateLimit-Remaining')),
      rateLimitReset: this.parseHeaderAsNumber(response.headers.get('X-RateLimit-Reset')),
      rateLimitTier: response.headers.get('X-RateLimit-Tier') || undefined,
    };
  }

  private parseHeaderAsNumber(value: string | null): number | undefined {
    if (!value) return undefined;
    const num = parseInt(value, 10);
    return isNaN(num) ? undefined : num;
  }

  setApiKey(apiKey: string): void {
    this.apiKey = apiKey;
  }

  setBearerToken(token: string): void {
    this.bearerToken = token;
  }

  setCsrfToken(token: string): void {
    this.csrfToken = token;
  }
}

// NOTE: The `ApiError` class (and its typed subclasses) now live in
// `errors.ts` and are re-exported above for backwards compatibility.

/**
 * Create a default client instance.
 */
export function createClient(config?: ClientConfig): ExplorerApiClient {
  return new ExplorerApiClient(config);
}

export default ExplorerApiClient;

export * from './verify';
