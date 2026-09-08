// The MCP server entry point: wires tools, resources and prompts onto an
// McpServer, and connects it over stdio. `cli.ts` (owned by another slice)
// calls `startStdio`.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { registerPrompts } from './prompts.ts';
import { registerResources } from './resources.ts';
import { registerAllTools } from './tools/index.ts';
import type { SystemRegistry } from './types.ts';

function readPackageVersion(): string {
  try {
    const pkgPath = fileURLToPath(new URL('../package.json', import.meta.url));
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/** Logs one line per tool response to stderr. Never write to stdout: it is the protocol channel. */
export function logResponseSize(toolName: string, charCount: number): void {
  process.stderr.write(`[ds-mcp] ${toolName} ${charCount} chars\n`);
}

interface ContentBlockLike {
  type: string;
  text?: string;
}

function textLength(result: unknown): number {
  const content = (result as { content?: ContentBlockLike[] } | undefined)?.content;
  if (!Array.isArray(content)) return 0;
  return content
    .filter((c) => c.type === 'text' && typeof c.text === 'string')
    .reduce((sum, c) => sum + (c.text?.length ?? 0), 0);
}

/**
 * Wraps every tool registered on `server` from this point on so its
 * response size is logged to stderr. Individual tool files stay unaware of
 * logging; this is the one place it happens, per the design rule that
 * every response's cost must be measurable.
 */
function instrumentToolResponseLogging(server: McpServer): void {
  // registerTool's overloads make a precisely-typed wrapper impractical;
  // this cast is isolated to this one instrumentation shim.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const original = server.registerTool.bind(server) as (...args: any[]) => unknown;
  (server as unknown as { registerTool: (...args: unknown[]) => unknown }).registerTool = (...args: unknown[]) => {
    const name = args[0] as string;
    const config = args[1];
    const cb = args[2] as (...cbArgs: unknown[]) => unknown;
    const wrapped = async (...cbArgs: unknown[]) => {
      const result = await cb(...cbArgs);
      logResponseSize(name, textLength(result));
      return result;
    };
    return original(name, config, wrapped);
  };
}

export function createServer(registry: SystemRegistry): McpServer {
  const server = new McpServer({ name: 'open-design-system-mcp', version: readPackageVersion() });

  instrumentToolResponseLogging(server);
  registerAllTools(server, registry);
  registerResources(server, registry);
  registerPrompts(server, registry);

  return server;
}

export async function startStdio(registry: SystemRegistry): Promise<void> {
  const server = createServer(registry);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
