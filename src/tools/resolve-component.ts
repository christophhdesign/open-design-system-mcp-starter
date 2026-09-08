import { z } from 'zod';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { resolveComponent } from '../search/index.ts';
import type { ResolveResult, SystemRegistry } from '../types.ts';
import { resolveSystem, truncate } from './index.ts';

export interface ResolveComponentArgs {
  system?: string;
  name: string;
}

const inputShape = {
  system: z.string().optional().describe('System id to check against. Optional when only one system is configured.'),
  name: z.string().describe('The component name to verify, exactly as you intend to write or import it.'),
};

function renderText(result: ResolveResult): string {
  if (result.status === 'exact') {
    return `'${result.component.name}' exists in ${result.system}. Usage: \`${result.component.usage}\`${result.component.deprecated ? ' -- NOTE: deprecated.' : ''}`;
  }
  if (result.status === 'alias') {
    return `You wrote '${result.alias}'; ${result.system} calls this **${result.target.name}**${result.concept ? ` (${result.concept})` : ''}. Usage: \`${result.target.usage}\`${result.note ? `\n${result.note}` : ''}`;
  }
  return result.message;
}

export function run(registry: SystemRegistry, args: ResolveComponentArgs): { text: string; structured: ResolveResult; isError?: true } {
  const resolved = resolveSystem(registry, args.system);
  if ('error' in resolved) {
    return {
      text: resolved.error,
      structured: { status: 'missing', system: args.system ?? '', query: args.name, message: resolved.error, nearest: [] },
      isError: true,
    };
  }
  const { data } = resolved;
  const result = resolveComponent(data, args.name);
  // 'missing' is a legitimate, expected answer here (that is the whole point
  // of this tool) -- it is not a tool error. Only an unknown system is.
  const text = truncate(renderText(result));
  return { text, structured: result };
}

export function register(server: McpServer, registry: SystemRegistry): void {
  server.registerTool(
    'resolve_component',
    {
      title: 'Resolve component name',
      description:
        "Check whether a component name exists in the design system BEFORE importing or writing it. Returns 'exact' when it exists, 'alias' when this system uses a different name for what you meant (with the real name to use), or 'missing' with the nearest real components and why. Never guess a component name; call this first.",
      inputSchema: inputShape,
    },
    async (args): Promise<CallToolResult> => {
      const result = run(registry, args);
      return {
        content: [{ type: 'text', text: result.text }],
        structuredContent: result.structured as unknown as Record<string, unknown>,
        isError: result.isError,
      };
    },
  );
}
