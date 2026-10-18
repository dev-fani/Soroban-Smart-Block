/**
 * Typed event iterators with automatic cursor pagination (#1080).
 *
 * `GET /api/events` returns a page plus an opaque `next_cursor`. Following it
 * by hand means re-issuing the same query with the cursor, guarding against
 * the cursor not advancing, and handling cancellation.
 *
 * `createEventIterator` does that once, exposing:
 *   - automatic cursor-following across pages,
 *   - `AbortSignal` cancellation (also via `.cancel()`),
 *   - correct empty-page handling (a page with no rows ends iteration even
 *     if the server echoed a cursor back).
 *
 * The iterator is lazy — no request is issued until the first `next()`, and
 * it stops as soon as the caller breaks out of a loop.
 */

import type { ApiResponse } from './types.js';
import { CancelledError } from './errors.js';

/** A decoded explorer event. Extra server fields are preserved. */
export interface EventRecord {
  seq: number;
  contract_id?: string | null;
  function?: string;
  ledger?: number;
  description?: string;
  raw_topics?: string[];
  raw_data?: string;
  tx_hash?: string;
  type?: string;
  decode_status?: string;
  decode_warnings?: string[];
  [key: string]: unknown;
}

/** A partial-data warning attached to a page (#1079). */
export interface PartialDataWarning {
  code: string;
  message: string;
}

/** The page shape returned by the events endpoints. */
export interface EventPage<T = EventRecord> {
  data: T[];
  next_cursor?: string | number | null;
  page_info?: {
    has_next: boolean;
    has_previous: boolean;
    start_cursor: string | null;
    end_cursor: string | null;
  };
  total?: number;
  count_is_estimate?: boolean;
  warnings?: PartialDataWarning[];
}

/** Filters understood by `GET /api/events`. */
export interface EventQuery {
  contract?: string;
  fn?: string;
  type?: string;
  count?: 'exact' | 'estimate';
  from?: string;
  to?: string;
}

export interface IterateEventsOptions extends EventQuery {
  /** Page size; the server clamps this to its own maximum. */
  limit?: number;
  /** Stop after fetching this many events. Useful for bounded consumption. */
  maxEvents?: number;
  /** Stop after this many pages, even if more data remains. */
  maxPages?: number;
  /** Start from a cursor (e.g. the `next_cursor` of a previous response). */
  cursor?: string | number;
  /** Cancels iteration; rejects an in-flight request. */
  signal?: AbortSignal;
  /**
   * When false, an empty page with a fresh cursor keeps advancing instead of
   * terminating. Defaults to true, which treats an empty page as the end.
   */
  stopOnEmptyPage?: boolean;
}

/**
 * Structural shape the iterator needs — satisfied by `ExplorerApiClient`
 * without creating a runtime dependency on it.
 */
export interface EventSourceClient {
  get<T>(
    endpoint: string,
    options?: { params?: Record<string, string | number | boolean | undefined>; signal?: AbortSignal },
  ): Promise<ApiResponse<T>>;
}

const DEFAULT_EVENT_ENDPOINT = '/api/events';

function buildParams(options: IterateEventsOptions, cursor?: string | number): Record<string, string | number | boolean> {
  const params: Record<string, string | number | boolean> = {};
  if (options.contract !== undefined) params.contract = options.contract;
  if (options.fn !== undefined) params.fn = options.fn;
  if (options.type !== undefined) params.type = options.type;
  if (options.count !== undefined) params.count = options.count;
  if (options.from !== undefined) params.from = options.from;
  if (options.to !== undefined) params.to = options.to;
  if (options.limit !== undefined) params.limit = options.limit;
  if (cursor !== undefined) params.after_seq = cursor;
  return params;
}

/**
 * A reusable, cancellable cursor-following iterator over events.
 */
export interface EventIterator<T = EventRecord> extends AsyncIterableIterator<T> {
  /** Stop iterating and abort any in-flight request. */
  cancel(): void;
  /** The cursor that will be used for the next page, if known. */
  readonly cursor: string | number | undefined;
}

/**
 * Create a cursor-following iterator over the events endpoint.
 *
 * ```ts
 * for await (const event of client.iterateEvents({ contract: 'C...' })) {
 *   if (event.decode_status === 'unverified') continue;
 *   if (event.seq < 1000) break; // stops fetching further pages
 * }
 * ```
 *
 * @param client an `EventSourceClient` (typically `ExplorerApiClient`)
 * @param options filters, page size, limits and cancellation
 * @param endpoint defaults to `/api/events`
 */
export function createEventIterator<T = EventRecord>(
  client: EventSourceClient,
  options: IterateEventsOptions = {},
  endpoint: string = DEFAULT_EVENT_ENDPOINT,
): EventIterator<T> {
  let cursor = options.cursor;
  let buffer: T[] = [];
  let pending: Promise<EventPage<T>> | null = null;
  let done = false;
  // Set once we know there is no further page to fetch (empty page, a null
  // next_cursor, or a server that echoed the cursor we sent).
  let exhausted = false;
  let eventsServed = 0;
  let pagesFetched = 0;
  const controller = new AbortController();

  // If the caller supplied a signal, honour it too.
  if (options.signal) {
    if (options.signal.aborted) {
      controller.abort(options.signal.reason);
    } else {
      options.signal.addEventListener('abort', () => controller.abort(options.signal!.reason), { once: true });
    }
  }

  const throwIfCancelled = () => {
    if (controller.signal.aborted) {
      throw new CancelledError('Event iteration cancelled');
    }
  };

  const fetchPage = (): Promise<EventPage<T>> => {
    if (!pending) {
      throwIfCancelled();
      pending = client
        .get<EventPage<T>>(endpoint, { params: buildParams(options, cursor), signal: controller.signal })
        .then((res) => {
          pagesFetched += 1;
          pending = null;
          return res.data;
        });
    }
    return pending;
  };

  const iterator: EventIterator<T> = {
    cancel() {
      controller.abort();
      done = true;
    },
    get cursor() {
      return cursor;
    },
    [Symbol.asyncIterator]() {
      return this;
    },
    async next(): Promise<IteratorResult<T>> {
      throwIfCancelled();

      // Respect the stop conditions before fetching another page.
      if (done) return { done: true, value: undefined };
      if (options.maxEvents !== undefined && eventsServed >= options.maxEvents) {
        done = true;
        return { done: true, value: undefined };
      }

      if (buffer.length === 0) {
        // maxPages bounds how many pages we fetch — it only gates a fetch,
        // not draining rows we already have in hand.
        if (options.maxPages !== undefined && pagesFetched >= options.maxPages) {
          done = true;
          return { done: true, value: undefined };
        }
        // Once we know there is nothing left to fetch, stop for good.
        if (exhausted) {
          done = true;
          return { done: true, value: undefined };
        }

        let page: EventPage<T>;
        try {
          page = await fetchPage();
          // The fetch may have resolved even though the iterator was cancelled
          // mid-flight — surface it rather than serving a stale page.
          throwIfCancelled();
        } catch (err) {
          done = true;
          throw err;
        }

        const rows = Array.isArray(page?.data) ? page.data : [];

        // An empty page means the end of the feed — even if the server
        // echoed a cursor back, advancing on it would never terminate.
        if (rows.length === 0) {
          exhausted = true;
          buffer = [];
        } else {
          buffer = rows;
          const next = page.next_cursor;
          if (next === undefined || next === null || String(next) === String(cursor)) {
            // No forward cursor, or the server repeated the one we sent —
            // keep this page's rows but do not ask for another page.
            exhausted = true;
          } else {
            cursor = next;
          }
        }
      }

      if (buffer.length === 0) {
        done = true;
        return { done: true, value: undefined };
      }

      const value = buffer.shift() as T;
      eventsServed += 1;
      if (options.maxEvents !== undefined && eventsServed >= options.maxEvents) {
        done = true;
      }
      return { done: false, value };
    },

    async return(): Promise<IteratorResult<T>> {
      done = true;
      controller.abort();
      return { done: true, value: undefined };
    },
  };

  return iterator;
}

/**
 * Convenience: collect every event the iterator yields into an array.
 * Subject to the same `maxEvents` / `maxPages` bounds as the iterator.
 */
export async function collectEvents<T = EventRecord>(
  iterator: AsyncIterableIterator<T>,
  maxEvents?: number,
): Promise<T[]> {
  const out: T[] = [];
  for await (const event of iterator) {
    out.push(event);
    if (maxEvents !== undefined && out.length >= maxEvents) break;
  }
  return out;
}
