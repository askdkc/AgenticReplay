import { afterEach, describe, expect, it } from 'vitest';
import {
  installFetchCapture,
  withFetchCaptureScope,
  type FetchCaptureEvent,
} from '../src/capture.js';

describe('fetch capture', () => {
  const disposers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (disposers.length) await disposers.pop()!();
  });

  it('captures bounded request and complete response without changing the response stream', async () => {
    const native = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response('hello world', { headers: { 'content-type': 'text/plain' } })) as typeof fetch;
    try {
      const events: FetchCaptureEvent[] = [];
      disposers.push(
        installFetchCapture({
          onEvent: (event) => {
            events.push(event);
          },
          maxBodyBytes: 100,
        }),
      );
      const response = await withFetchCaptureScope(
        { sessionId: 's', modelCallId: 'm', provider: 'p', model: 'x' },
        () => fetch('https://api.example.test/v1', { method: 'POST', body: 'request' }),
      );
      expect(await response.text()).toBe('hello world');
      await disposers[0]!();
      expect(events.map((event) => event.kind)).toEqual([
        'request-start',
        'request-body',
        'response',
      ]);
      expect(events[0]!.attemptId).toBe(events[2]!.attemptId);
      expect(events[2]!.scope?.sessionId).toBe('s');
      expect(events[2]!.body).toBe('hello world');
    } finally {
      globalThis.fetch = native;
    }
  });

  it('persists request-start before dispatching the underlying fetch', async () => {
    const native = globalThis.fetch;
    let dispatched = false;
    let releaseStart!: () => void;
    const startPersisted = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    globalThis.fetch = (async () => {
      dispatched = true;
      return new Response('ok');
    }) as typeof fetch;
    try {
      disposers.push(
        installFetchCapture({
          onEvent: async (event) => {
            if (event.kind === 'request-start') await startPersisted;
          },
        }),
      );
      const request = fetch('https://api.example.test/barrier');
      await Promise.resolve();
      expect(dispatched).toBe(false);
      releaseStart();
      expect(await (await request).text()).toBe('ok');
      expect(dispatched).toBe(true);
    } finally {
      globalThis.fetch = native;
    }
  });

  it('reports truncation while the caller still receives the complete stream', async () => {
    const native = globalThis.fetch;
    globalThis.fetch = (async () => new Response('0123456789')) as typeof fetch;
    try {
      const events: FetchCaptureEvent[] = [];
      disposers.push(
        installFetchCapture({
          onEvent: (event) => {
            events.push(event);
          },
          maxBodyBytes: 4,
        }),
      );
      const response = await fetch('https://api.example.test/v1');
      expect(await response.text()).toBe('0123456789');
      await disposers[0]!();
      const result = events.find((event) => event.kind === 'response');
      expect(result?.captureStatus).toBe('partial');
      expect(result?.captureIssues).toContain('body_limit');
      expect(result?.body).toBe('0123');
    } finally {
      globalThis.fetch = native;
    }
  });

  it('marks an exact byte boundary complete and a body over 1MiB partial', async () => {
    const native = globalThis.fetch;
    globalThis.fetch = (async () => new Response('ok')) as typeof fetch;
    try {
      const events: FetchCaptureEvent[] = [];
      disposers.push(
        installFetchCapture({
          onEvent: (event) => {
            events.push(event);
          },
          maxBodyBytes: 4,
        }),
      );
      await (await fetch('https://api.example.test/v1', { method: 'POST', body: '1234' })).text();
      await disposers[0]!();
      expect(events.find((event) => event.kind === 'request-body')?.captureStatus).toBe('complete');

      const second: FetchCaptureEvent[] = [];
      globalThis.fetch = (async () => new Response('ok')) as typeof fetch;
      disposers.push(
        installFetchCapture({
          onEvent: (event) => {
            second.push(event);
          },
          maxBodyBytes: 1024 * 1024,
        }),
      );
      await (
        await fetch('https://api.example.test/v1', {
          method: 'POST',
          body: 'x'.repeat(1024 * 1024 + 1),
        })
      ).text();
      await disposers[0]!();
      expect(second.find((event) => event.kind === 'request-body')?.captureStatus).toBe('partial');
      expect(second.find((event) => event.kind === 'request-body')?.captureIssues).toContain(
        'body_limit',
      );
    } finally {
      globalThis.fetch = native;
    }
  });

  it('reports origin failures and caller aborts without claiming success', async () => {
    const native = globalThis.fetch;
    try {
      const events: FetchCaptureEvent[] = [];
      globalThis.fetch = (async () => {
        throw new Error('offline');
      }) as typeof fetch;
      disposers.push(
        installFetchCapture({
          onEvent: (event) => {
            events.push(event);
          },
        }),
      );
      await expect(fetch('https://api.example.test/v1')).rejects.toThrow('offline');
      await disposers[0]!();
      expect(events.find((event) => event.kind === 'error')?.terminalOutcome).toBe('origin_error');

      const aborted = new AbortController();
      const abortEvents: FetchCaptureEvent[] = [];
      globalThis.fetch = (async () => {
        throw new DOMException('aborted', 'AbortError');
      }) as typeof fetch;
      disposers.push(
        installFetchCapture({
          onEvent: (event) => {
            abortEvents.push(event);
          },
        }),
      );
      aborted.abort();
      await expect(
        fetch('https://api.example.test/v1', { signal: aborted.signal }),
      ).rejects.toThrow('aborted');
      await disposers[0]!();
      expect(abortEvents.find((event) => event.kind === 'error')?.terminalOutcome).toBe(
        'client_aborted',
      );
    } finally {
      globalThis.fetch = native;
    }
  });

  it('fails closed on sink failure even when sink diagnostics succeed', async () => {
    const native = globalThis.fetch;
    let dispatches = 0;
    globalThis.fetch = (async () => {
      dispatches++;
      return new Response('ok');
    }) as typeof fetch;
    try {
      let failures = 0;
      const dispose = installFetchCapture({
        onEvent: async () => {
          throw new Error('sink');
        },
        onSinkError: () => {
          failures++;
        },
      });
      await expect(fetch('https://api.example.test/v1')).rejects.toThrow('sink');
      await expect(fetch('https://api.example.test/v2')).rejects.toThrow('sink');
      await expect(dispose()).rejects.toThrow('sink');
      expect(failures).toBeGreaterThan(0);
      expect(dispatches).toBe(0);
    } finally {
      globalThis.fetch = native;
    }
  });

  it('surfaces a post-dispatch sink failure when the capture is disposed', async () => {
    const native = globalThis.fetch;
    globalThis.fetch = (async () => new Response('ok')) as typeof fetch;
    try {
      const dispose = installFetchCapture({
        onEvent: (event) => {
          if (event.kind === 'response') throw new Error('response sink');
        },
      });
      const response = await fetch('https://api.example.test/post-dispatch');
      expect(await response.text()).toBe('ok');
      await expect(dispose()).rejects.toThrow('response sink');
    } finally {
      globalThis.fetch = native;
    }
  });

  it('surfaces an undefined sink rejection when the capture is disposed', async () => {
    const native = globalThis.fetch;
    globalThis.fetch = (async () => new Response('ok')) as typeof fetch;
    try {
      const dispose = installFetchCapture({
        onEvent: (event) => {
          if (event.kind === 'response') throw undefined;
        },
      });
      const response = await fetch('https://api.example.test/undefined-sink');
      expect(await response.text()).toBe('ok');
      await expect(dispose()).rejects.toThrow('fetch capture sink failed');
    } finally {
      globalThis.fetch = native;
    }
  });

  it('fails explicitly when another process-global sink is already installed', () => {
    const native = globalThis.fetch;
    try {
      const dispose = installFetchCapture({ onEvent: () => undefined });
      disposers.push(dispose);
      expect(() => installFetchCapture({ onEvent: () => undefined })).toThrow(
        /already installed.*one process-global sink/,
      );
    } finally {
      globalThis.fetch = native;
    }
  });

  it('omits invalid UTF-8 bodies instead of persisting replacement characters', async () => {
    const native = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(new Uint8Array([0xff, 0xfe]), {
        headers: { 'content-type': 'application/octet-stream' },
      })) as typeof fetch;
    try {
      const events: FetchCaptureEvent[] = [];
      disposers.push(installFetchCapture({ onEvent: (event) => events.push(event) }));
      const response = await fetch('https://api.example.test/binary');
      expect(await response.arrayBuffer()).toEqual(new Uint8Array([0xff, 0xfe]).buffer);
      await disposers[0]!();
      const captured = events.find((event) => event.kind === 'response');
      expect(captured?.body).toBeUndefined();
      expect(captured?.captureStatus).toBe('partial');
      expect(captured?.captureIssues).toContain('unsupported_binary_body');
    } finally {
      globalThis.fetch = native;
    }
  });

  it('records fetch boundary content-encoding normalization without marking complete content incomplete', async () => {
    const native = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response('normalized', { headers: { 'content-encoding': 'gzip' } })) as typeof fetch;
    try {
      const events: FetchCaptureEvent[] = [];
      disposers.push(installFetchCapture({ onEvent: (event) => events.push(event) }));
      const response = await fetch('https://api.example.test/encoded');
      expect(await response.text()).toBe('normalized');
      await disposers[0]!();
      const captured = events.find((event) => event.kind === 'response');
      expect(captured?.captureStatus).toBe('complete');
      expect(captured?.captureIssues).toContain('content_encoding_normalized');
    } finally {
      globalThis.fetch = native;
    }
  });

  it('limits request streams by bytes without consuming the original request', async () => {
    const native = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const request = input instanceof Request ? input : new Request(input);
      return new Response(await request.text());
    }) as typeof fetch;
    try {
      const events: FetchCaptureEvent[] = [];
      disposers.push(
        installFetchCapture({
          onEvent: (event) => {
            events.push(event);
          },
          maxBodyBytes: 5,
        }),
      );
      const request = new Request('https://api.example.test/v1', {
        method: 'POST',
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('😀abc'));
            controller.close();
          },
        }),
        duplex: 'half',
      } as RequestInit);
      const response = await fetch(request);
      expect(await response.text()).toBe('😀abc');
      await disposers[0]!();
      const body = events.find((event) => event.kind === 'request-body');
      expect(body?.captureStatus).toBe('partial');
      expect(body?.captureIssues).toContain('body_limit');
      expect(body?.requestBytes).toBeGreaterThan(5);
      expect(body?.capturedBytes).toBe(5);
    } finally {
      globalThis.fetch = native;
    }
  });

  it('rejects an aggregate buffering limit that is smaller than one body', () => {
    expect(() =>
      installFetchCapture({ onEvent: () => undefined, maxBodyBytes: 10, maxBufferedBytes: 9 }),
    ).toThrow(/maxBufferedBytes/);
  });

  it('finalizes unread responses as incomplete when the disposer runs', async () => {
    const native = globalThis.fetch;
    globalThis.fetch = (async () => new Response('unread')) as typeof fetch;
    try {
      const events: FetchCaptureEvent[] = [];
      disposers.push(
        installFetchCapture({
          onEvent: (event) => {
            events.push(event);
          },
          maxBodyBytes: 32,
        }),
      );
      await fetch('https://api.example.test/unread');
      await disposers[0]!();
      const response = events.find((event) => event.kind === 'response');
      expect(response?.terminalOutcome).toBe('client_aborted');
      expect(response?.captureStatus).toBe('partial');
      expect(response?.captureIssues).toContain('not_consumed');
    } finally {
      globalThis.fetch = native;
    }
  });

  it('records caller cancellation distinctly from an origin error', async () => {
    const native = globalThis.fetch;
    globalThis.fetch = (async () => new Response('cancel me')) as typeof fetch;
    try {
      const events: FetchCaptureEvent[] = [];
      disposers.push(
        installFetchCapture({
          onEvent: (event) => {
            events.push(event);
          },
          maxBodyBytes: 32,
        }),
      );
      const response = await fetch('https://api.example.test/cancel');
      const reader = response.body!.getReader();
      await reader.read();
      await reader.cancel('caller stopped');
      await disposers[0]!();
      const captured = events.find((event) => event.kind === 'response');
      expect(captured?.terminalOutcome).toBe('client_aborted');
      expect(captured?.captureIssues).toContain('consumer_cancelled');
    } finally {
      globalThis.fetch = native;
    }
  });

  it('omits a concurrent response that cannot reserve the aggregate body budget', async () => {
    const native = globalThis.fetch;
    globalThis.fetch = (async () => new Response('response')) as typeof fetch;
    try {
      const events: FetchCaptureEvent[] = [];
      disposers.push(
        installFetchCapture({
          onEvent: (event) => {
            events.push(event);
          },
          maxBodyBytes: 4,
          maxBufferedBytes: 4,
        }),
      );
      await Promise.all([fetch('https://api.example.test/a'), fetch('https://api.example.test/b')]);
      await disposers[0]!();
      const responses = events.filter(
        (event): event is Extract<FetchCaptureEvent, { kind: 'response' }> =>
          event.kind === 'response',
      );
      expect(responses).toHaveLength(2);
      expect(responses.some((event) => event.captureIssues?.includes('buffer_limit'))).toBe(true);
      expect(responses.every((event) => event.captureStatus === 'partial')).toBe(true);
    } finally {
      globalThis.fetch = native;
    }
  });
});
