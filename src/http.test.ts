import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { startHttp } from './http.ts';
import { makeRegistry, makeSystemData } from './test-helpers.ts';

async function connectClient(url: string, token?: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(
    new URL(url),
    token ? { requestInit: { headers: { Authorization: `Bearer ${token}` } } } : undefined
  );
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await client.connect(transport);
  return client;
}

async function fetchHealth(url: string): Promise<{ ok: boolean; sessions: number; sessionTtlMs: number; maxSessions: number }> {
  const base = new URL(url);
  const res = await fetch(`${base.protocol}//${base.host}/healthz`);
  return (await res.json()) as { ok: boolean; sessions: number; sessionTtlMs: number; maxSessions: number };
}

/** Polls `check` until it returns true or `timeoutMs` elapses; throws on timeout. */
async function waitFor(check: () => Promise<boolean>, timeoutMs: number, intervalMs = 20): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() >= deadline) throw new Error('waitFor: timed out');
    await new Promise((resolvePromise) => setTimeout(resolvePromise, intervalMs));
  }
}

test('http: listTools and callTool over the streamable HTTP transport', async () => {
  const registry = makeRegistry(makeSystemData());
  const { url, close } = await startHttp(registry, { port: 0 });
  try {
    const client = await connectClient(url);
    try {
      const { tools } = await client.listTools();
      assert.ok(tools.some((t) => t.name === 'resolve_component'));

      const result = await client.callTool({ name: 'resolve_component', arguments: { name: 'Card' } });
      assert.ok(!result.isError);
      const structured = result.structuredContent as { status?: string };
      assert.equal(structured.status, 'alias');
    } finally {
      await client.close();
    }
  } finally {
    await close();
  }
});

test('http: two clients get distinct sessions and both work', async () => {
  const registry = makeRegistry(makeSystemData());
  const { url, close } = await startHttp(registry, { port: 0 });
  try {
    const clientA = await connectClient(url);
    const clientB = await connectClient(url);
    try {
      const transportA = (clientA as unknown as { transport: StreamableHTTPClientTransport }).transport;
      const transportB = (clientB as unknown as { transport: StreamableHTTPClientTransport }).transport;
      assert.ok(transportA.sessionId);
      assert.ok(transportB.sessionId);
      assert.notEqual(transportA.sessionId, transportB.sessionId);

      const resultA = await clientA.callTool({ name: 'search_components', arguments: { query: 'Card' } });
      const resultB = await clientB.callTool({ name: 'search_components', arguments: { query: 'Card' } });
      assert.ok(!resultA.isError);
      assert.ok(!resultB.isError);
    } finally {
      await clientA.close();
      await clientB.close();
    }
  } finally {
    await close();
  }
});

test('http: GET /healthz reports the configured system', async () => {
  const registry = makeRegistry(makeSystemData());
  const { url, close } = await startHttp(registry, { port: 0 });
  try {
    const base = new URL(url);
    const res = await fetch(`${base.protocol}//${base.host}/healthz`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean; systems: Array<{ id: string }>; sessions: number };
    assert.equal(body.ok, true);
    assert.ok(body.systems.some((s) => s.id === 'acme'));
    assert.equal(body.sessions, 0);
  } finally {
    await close();
  }
});

test('http: with a token configured, a missing header is rejected and a correct one is accepted', async () => {
  const registry = makeRegistry(makeSystemData());
  const token = 'secret-test-token';
  const { url, close } = await startHttp(registry, { port: 0, token });
  try {
    const base = new URL(url);
    const unauthed = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });
    assert.equal(unauthed.status, 401);

    // /healthz never requires the token.
    const health = await fetch(`${base.protocol}//${base.host}/healthz`);
    assert.equal(health.status, 200);

    const client = await connectClient(url, token);
    try {
      const { tools } = await client.listTools();
      assert.ok(tools.length > 0);
    } finally {
      await client.close();
    }
  } finally {
    await close();
  }
});

test('http: an idle session is swept once it exceeds the ttl', async () => {
  const registry = makeRegistry(makeSystemData());
  const { url, close } = await startHttp(registry, { port: 0, sessionTtlMs: 200 });
  try {
    const client = await connectClient(url);

    const initial = await fetchHealth(url);
    assert.equal(initial.sessions, 1);

    // The sweeper runs every min(ttl/4, 60s) = 50ms here; give it ~500ms of idle time.
    await waitFor(async () => (await fetchHealth(url)).sessions === 0, 2000);

    // The transport is already gone server-side; closing the stale client is best-effort.
    await client.close().catch(() => {});
  } finally {
    await close();
  }
});

test('http: maxSessions evicts the least recently seen session to admit a new one', async () => {
  const registry = makeRegistry(makeSystemData());
  const { url, close } = await startHttp(registry, { port: 0, maxSessions: 1 });
  try {
    const clientA = await connectClient(url);
    const clientB = await connectClient(url);
    try {
      const health = await fetchHealth(url);
      assert.equal(health.sessions, 1);

      // Client A's session was evicted to admit client B; its next call fails.
      await assert.rejects(() => clientA.listTools());

      // Client B, the newest session, still works.
      const { tools } = await clientB.listTools();
      assert.ok(tools.length > 0);
    } finally {
      await clientA.close().catch(() => {});
      await clientB.close().catch(() => {});
    }
  } finally {
    await close();
  }
});

test('http: /healthz reports the session ttl and max sessions', async () => {
  const registry = makeRegistry(makeSystemData());
  const { url, close } = await startHttp(registry, { port: 0, sessionTtlMs: 12345, maxSessions: 7 });
  try {
    const body = await fetchHealth(url);
    assert.equal(body.sessionTtlMs, 12345);
    assert.equal(body.maxSessions, 7);
  } finally {
    await close();
  }
});

test('http: DELETE closes the session', async () => {
  const registry = makeRegistry(makeSystemData());
  const { url, close } = await startHttp(registry, { port: 0 });
  try {
    const client = await connectClient(url);
    const transport = (client as unknown as { transport: StreamableHTTPClientTransport }).transport;
    const sessionId = transport.sessionId;
    assert.ok(sessionId);

    await transport.terminateSession();

    // The session is gone: a follow-up request with the same (now stale) session id is rejected.
    const res = await fetch(url, {
      method: 'GET',
      headers: { 'mcp-session-id': sessionId!, accept: 'text/event-stream' },
    });
    assert.equal(res.status, 400);
  } finally {
    await close();
  }
});
