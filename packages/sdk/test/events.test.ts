import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createEventIterator, collectEvents } from '../src/events';
import type { EventPage, EventSourceClient } from '../src/events';
import { ExplorerApiClient } from '../src/index';
import { CancelledError, ApiError } from '../src/errors';

/** A fake EventSourceClient that serves a scripted sequence of pages. */
function fakeClient(pages: Array<EventPage | Error>): EventSourceClient & { calls: Array<Record<string, unknown>>; signal?: AbortSignal } {
  const calls: Array<Record<string, unknown>> = [];
  let i = 0;
  return {
    calls,
    async get<T>(_endpoint: string, options?: { params?: Record<string, unknown>; signal?: AbortSignal }) {
      calls.push(options?.params ?? {});
      const next = pages[i++];
      if (next instanceof Error) throw next;
      return { data: next as unknown as T, meta: { status: 200, statusText: 'OK', headers: new Headers() } };
    },
  };
}

const page = (seqs: number[], next: number | null): EventPage => ({
  data: seqs.map((seq) => ({ seq, function: 'transfer' })),
  next_cursor: next,
  page_info: { has_next: next !== null, has_previous: false, start_cursor: null, end_cursor: null },
});

describe('createEventIterator (#1080)', () => {
  it('follows next_cursor across pages and stops when the cursor is null', async () => {
    const client = fakeClient([page([3, 2], 2), page([1], null)]);
    const iter = createEventIterator(client, { limit: 2 });
    const seqs = await collectEvents(iter);
    expect(seqs.map((e: { seq: number }) => e.seq)).toEqual([3, 2, 1]);
    // two page fetches only
    expect(client.calls).toHaveLength(2);
    expect(client.calls[0].limit).toBe(2);
    expect(client.calls[1].after_seq).toBe(2);
  });

  it('does not fetch another page after an empty first page', async () => {
    const client = fakeClient([{ data: [], next_cursor: 999 }]);
    const seqs = await collectEvents(createEventIterator(client));
    expect(seqs).toEqual([]);
    expect(client.calls).toHaveLength(1);
  });

  it('stops when the server repeats the cursor we sent', async () => {
    const client = fakeClient([{ data: [{ seq: 7 }], next_cursor: 5 }, { data: [{ seq: 6 }], next_cursor: 5 }]);
    const iter = createEventIterator(client, { cursor: 5 });
    const seqs = await collectEvents(iter);
    // The echoed cursor would re-request the same page, so iteration ends
    // after serving the rows we already have.
    expect(seqs.map((e: { seq: number }) => e.seq)).toEqual([7]);
    expect(client.calls).toHaveLength(1);
  });

  it('honours maxEvents without fetching more pages', async () => {
    const client = fakeClient([page([5, 4, 3], 3), page([2, 1], null)]);
    const seqs = await collectEvents(createEventIterator(client, { limit: 3, maxEvents: 2 }));
    expect(seqs.map((e: { seq: number }) => e.seq)).toEqual([5, 4]);
    expect(client.calls).toHaveLength(1);
  });

  it('honours maxPages', async () => {
    const client = fakeClient([page([5, 4], 4), page([3, 2], 2), page([1], null)]);
    const seqs = await collectEvents(createEventIterator(client, { maxPages: 1 }));
    expect(seqs.map((e: { seq: number }) => e.seq)).toEqual([5, 4]);
    expect(client.calls).toHaveLength(1);
  });

  it('passes filters through to the request', async () => {
    const client = fakeClient([{ data: [], next_cursor: null }]);
    await collectEvents(createEventIterator(client, { contract: 'C1', fn: 'swap', type: 'soroban', count: 'exact' }));
    expect(client.calls[0]).toMatchObject({ contract: 'C1', fn: 'swap', type: 'soroban', count: 'exact' });
    // no cursor on the first page
    expect(client.calls[0].after_seq).toBeUndefined();
  });

  it('cancels iteration and aborts in-flight work via .cancel()', async () => {
    const controller = new AbortController();
    const client: EventSourceClient = {
      async get<T>(_e: string, options?: { signal?: AbortSignal }) {
        options?.signal?.addEventListener('abort', () => controller.abort());
        await new Promise((r) => setTimeout(r, 5));
        return { data: page([1], null) as unknown as T, meta: { status: 200, statusText: 'OK', headers: new Headers() } };
      },
    };
    const iter = createEventIterator(client);
    const pending = iter.next();
    iter.cancel();
    await expect(pending).rejects.toThrow(CancelledError);
  });

  it('is not re-iterable after completion and stops after done', async () => {
    const client = fakeClient([page([2, 1], null)]);
    const iter = createEventIterator(client);
    await collectEvents(iter);
    const after = await iter.next();
    expect(after.done).toBe(true);
  });

  it('does not issue any request until first next()', () => {
    const client = fakeClient([page([1], null)]);
    createEventIterator(client);
    expect(client.calls).toHaveLength(0);
  });
});

describe('ExplorerApiClient.iterateEvents (#1080)', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json', ...headers },
    });
  }

  it('paginates through /api/events with the real client', async () => {
    const client = new ExplorerApiClient({ baseUrl: 'http://test.local' });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ data: [{ seq: 9 }, { seq: 8 }], next_cursor: '8' }))
      .mockResolvedValueOnce(jsonResponse({ data: [{ seq: 7 }], next_cursor: null }));
    global.fetch = fetchMock as unknown as typeof fetch;

    const seqs: number[] = [];
    for await (const ev of client.iterateEvents({ limit: 2 })) {
      seqs.push((ev as unknown as { seq: number }).seq);
    }
    expect(seqs).toEqual([9, 8, 7]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const secondUrl = fetchMock.mock.calls[1][0] as string;
    expect(secondUrl).toContain('after_seq=8');
    expect(secondUrl).toContain('limit=2');
  });

  it('surfaces API errors from within the iterator', async () => {
    const client = new ExplorerApiClient({ baseUrl: 'http://test.local' });
    global.fetch = vi
      .fn()
      .mockResolvedValue(jsonResponse({ error: 'Invalid limit' }, 422)) as unknown as typeof fetch;

    await expect(collectEvents(client.iterateEvents({ limit: 0 }))).rejects.toThrow(ApiError);
  });
});
