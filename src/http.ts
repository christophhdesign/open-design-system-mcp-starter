// Streamable HTTP transport for the MCP server: a plain node:http server
// speaking the MCP Streamable HTTP protocol (POST/GET/DELETE at `path`) plus
// a GET /healthz status endpoint. No framework; CORS is intentionally absent
// (this serves agent clients, not browsers). `cli.ts` (owned by another
// slice) wires `serve --http` to `startHttp`.

import { randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';

import { checkFreshness } from './data/load.ts';
import { createServer } from './server.ts';
import type { SystemRegistry } from './types.ts';

export interface HttpOptions {
  port: number;
  host?: string;
  path?: string;
  token?: string;
  log?: (line: string) => void;
  /** Idle sessions older than this are swept. Default 30 minutes, env `DS_MCP_SESSION_TTL_MS`. */
  sessionTtlMs?: number;
  /** Cap on concurrent sessions. Default 200, env `DS_MCP_MAX_SESSIONS`. */
  maxSessions?: number;
}

interface Session {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  lastSeen: number;
}

/** Small: request bodies are JSON-RPC calls, not file uploads. */
const MAX_BODY_BYTES = 4 * 1024 * 1024;

const DEFAULT_SESSION_TTL_MS = 30 * 60 * 1000;
const DEFAULT_MAX_SESSIONS = 200;
/** The sweeper never runs more often than this, however short the TTL. */
const MAX_SWEEP_INTERVAL_MS = 60 * 1000;

/** Reads a positive-integer env override, falling back when absent or malformed. */
function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

function jsonRpcError(code: number, message: string): { jsonrpc: '2.0'; id: null; error: { code: number; message: string } } {
  return { jsonrpc: '2.0', id: null, error: { code, message } };
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(text);
}

function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolvePromise, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolvePromise(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Constant-time token comparison; unequal lengths never touch timingSafeEqual. */
function tokensMatch(provided: string, expected: string): boolean {
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function isAuthorized(req: IncomingMessage, token: string | undefined): boolean {
  if (!token) return true;
  const header = req.headers.authorization;
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
  return tokensMatch(header.slice('Bearer '.length), token);
}

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function sessionIdPrefix(id: string | undefined): string {
  return id ? id.slice(0, 8) : '-';
}

/**
 * Starts the Streamable HTTP transport. Sessions are stateful: an `initialize`
 * POST with no session header spins up a fresh `McpServer` + transport pair
 * and registers it under the session id the transport generates; every later
 * request for that session (POST/GET/DELETE) is routed to that same
 * transport via the `mcp-session-id` header, matching the reference pattern
 * from the MCP SDK's Streamable HTTP docs.
 */
export async function startHttp(registry: SystemRegistry, opts: HttpOptions): Promise<{ url: string; close(): Promise<void> }> {
  const host = opts.host ?? '127.0.0.1';
  const path = opts.path ?? '/mcp';
  const token = opts.token ?? process.env.DS_MCP_TOKEN;
  const log = opts.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  const sessionTtlMs = opts.sessionTtlMs ?? envInt('DS_MCP_SESSION_TTL_MS', DEFAULT_SESSION_TTL_MS);
  const maxSessions = opts.maxSessions ?? envInt('DS_MCP_MAX_SESSIONS', DEFAULT_MAX_SESSIONS);

  if (!token && !isLoopbackHost(host)) {
    log(`[ds-mcp-http] warning: listening on non-loopback host '${host}' with no auth token configured`);
  }

  const sessions = new Map<string, Session>();

  function logLine(method: string, status: number, sessionId: string | undefined): void {
    log(`[ds-mcp-http] ${method} ${path} ${status} ${sessionIdPrefix(sessionId)}`);
  }

  /** Closes and forgets one session, logging why. Safe to call on an already-gone id. */
  function evictSession(sessionId: string, reason: string): void {
    const session = sessions.get(sessionId);
    if (!session) return;
    sessions.delete(sessionId);
    log(`[ds-mcp-http] evicting session ${sessionIdPrefix(sessionId)} (${reason})`);
    void session.transport.close().catch((err: unknown) => {
      log(`[ds-mcp-http] error closing evicted session ${sessionIdPrefix(sessionId)}: ${(err as Error).message}`);
    });
  }

  function leastRecentlySeenSessionId(): string | undefined {
    let oldestId: string | undefined;
    let oldestSeen = Infinity;
    for (const [id, session] of sessions) {
      if (session.lastSeen < oldestSeen) {
        oldestSeen = session.lastSeen;
        oldestId = id;
      }
    }
    return oldestId;
  }

  const sweepIntervalMs = Math.min(sessionTtlMs / 4, MAX_SWEEP_INTERVAL_MS);
  const sweepTimer = setInterval(() => {
    const now = Date.now();
    for (const [id, session] of sessions) {
      if (now - session.lastSeen > sessionTtlMs) {
        evictSession(id, 'idle timeout');
      }
    }
  }, sweepIntervalMs);
  sweepTimer.unref();

  async function routeToSession(req: IncomingMessage, res: ServerResponse, sessionId: string, body?: unknown): Promise<void> {
    const session = sessions.get(sessionId);
    if (!session) {
      sendJson(res, 400, jsonRpcError(-32000, 'Bad Request: unknown session'));
      logLine(req.method ?? 'GET', 400, sessionId);
      return;
    }
    session.lastSeen = Date.now();
    await session.transport.handleRequest(req, res, body);
    logLine(req.method ?? 'GET', res.statusCode, sessionId);
  }

  async function handlePost(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let raw: Buffer;
    try {
      raw = await readBody(req, MAX_BODY_BYTES);
    } catch {
      sendJson(res, 413, jsonRpcError(-32000, 'Request body too large'));
      logLine('POST', 413, undefined);
      return;
    }

    let body: unknown;
    try {
      body = raw.length > 0 ? JSON.parse(raw.toString('utf8')) : undefined;
    } catch {
      sendJson(res, 400, jsonRpcError(-32700, 'Parse error'));
      logLine('POST', 400, undefined);
      return;
    }

    const sessionId = firstHeaderValue(req.headers['mcp-session-id']);
    if (sessionId) {
      await routeToSession(req, res, sessionId, body);
      return;
    }

    if (!isInitializeRequest(body)) {
      sendJson(res, 400, jsonRpcError(-32000, 'Bad Request: no valid session'));
      logLine('POST', 400, undefined);
      return;
    }

    const mcpServer = createServer(registry);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        if (sessions.size >= maxSessions) {
          const victim = leastRecentlySeenSessionId();
          if (victim) evictSession(victim, 'max sessions reached');
        }
        sessions.set(id, { transport, server: mcpServer, lastSeen: Date.now() });
      },
    });
    transport.onclose = () => {
      if (transport.sessionId) sessions.delete(transport.sessionId);
    };
    await mcpServer.connect(transport);
    await transport.handleRequest(req, res, body);
    logLine('POST', res.statusCode, transport.sessionId);
  }

  async function handleGetOrDelete(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const sessionId = firstHeaderValue(req.headers['mcp-session-id']);
    if (!sessionId) {
      sendJson(res, 400, jsonRpcError(-32000, 'Bad Request: missing Mcp-Session-Id header'));
      logLine(req.method ?? 'GET', 400, undefined);
      return;
    }
    await routeToSession(req, res, sessionId);
  }

  async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!isAuthorized(req, token)) {
      sendJson(res, 401, jsonRpcError(-32001, 'Unauthorized'));
      logLine(req.method ?? 'GET', 401, firstHeaderValue(req.headers['mcp-session-id']));
      return;
    }

    switch (req.method) {
      case 'POST':
        await handlePost(req, res);
        return;
      case 'GET':
      case 'DELETE':
        await handleGetOrDelete(req, res);
        return;
      default:
        sendJson(res, 405, jsonRpcError(-32000, 'Method not allowed'));
        logLine(req.method ?? '?', 405, undefined);
    }
  }

  function handleHealthz(req: IncomingMessage, res: ServerResponse): void {
    const systems = registry.ids().map((id) => {
      const data = registry.get(id);
      const freshness = checkFreshness(data);
      return {
        id,
        name: data.cfg.name ?? id,
        symbols: data.catalog.allExports.length,
        documented: data.catalog.components.reduce((n, c) => n + c.exports.length, 0),
        tokens: data.tokens?.tokens.length ?? 0,
        freshness: { catalog: freshness.catalog, tokens: freshness.tokens, docs: freshness.docs },
      };
    });
    sendJson(res, 200, { ok: true, systems, sessions: sessions.size, sessionTtlMs, maxSessions });
    logLine(req.method ?? 'GET', 200, undefined);
  }

  const server = createHttpServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? `${host}:0`}`);

    if (req.method === 'GET' && url.pathname === '/healthz') {
      handleHealthz(req, res);
      return;
    }

    if (url.pathname === path) {
      void handleMcp(req, res).catch((err: unknown) => {
        if (!res.headersSent) {
          sendJson(res, 500, jsonRpcError(-32603, 'Internal error'));
        }
        log(`[ds-mcp-http] ${req.method ?? '?'} ${path} 500 - ${(err as Error).message}`);
      });
      return;
    }

    sendJson(res, 404, jsonRpcError(-32000, 'Not found'));
  });

  await new Promise<void>((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(opts.port, host, () => resolvePromise());
  });

  const address = server.address();
  const actualPort = typeof address === 'object' && address !== null ? address.port : opts.port;
  const url = `http://${host}:${actualPort}${path}`;

  return {
    url,
    async close(): Promise<void> {
      clearInterval(sweepTimer);
      for (const session of sessions.values()) {
        await session.transport.close();
      }
      sessions.clear();
      server.closeAllConnections();
      await new Promise<void>((resolvePromise, reject) => {
        server.close((err) => (err ? reject(err) : resolvePromise()));
      });
    },
  };
}
