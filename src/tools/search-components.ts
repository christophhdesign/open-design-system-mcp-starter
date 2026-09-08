import { z } from 'zod';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { searchComponents } from '../search/index.ts';
import type { SearchHit, SystemId, SystemRegistry } from '../types.ts';
import { resolveSystem, truncate } from './index.ts';

export interface SearchComponentsArgs {
  system?: string;
  query: string;
  limit?: number;
}

export interface SearchComponentsResult {
  system: SystemId;
  hits: SearchHit[];
}

const inputShape = {
  system: z.string().optional().describe('System id to search. Optional when only one system is configured.'),
  query: z.string().describe("What you're looking for: a concept ('dismissible notice'), a guessed name ('Card'), or a prop word ('gap')."),
  limit: z.number().int().positive().max(20).optional().describe('Max hits to return. Default 8.'),
};

function renderText(system: string, query: string, hits: SearchHit[]): string {
  if (hits.length === 0) {
    return `No components in '${system}' matched "${query}". Try resolve_component to check a specific name, or a broader word.`;
  }
  const lines = hits.map((h, i) => {
    const dep = h.deprecated ? ' (deprecated)' : '';
    return `${i + 1}. **${h.name}**${h.tagName ? ` (\`${h.tagName}\`)` : ''}${dep} -- ${h.description}\n   usage: \`${h.usage}\`\n   matched: ${h.matchedOn.join(', ')}`;
  });
  return `Search results for "${query}" in ${system}:\n\n${lines.join('\n\n')}`;
}

export function run(registry: SystemRegistry, args: SearchComponentsArgs): { text: string; structured: SearchComponentsResult; isError?: true } {
  const resolved = resolveSystem(registry, args.system);
  if ('error' in resolved) {
    return { text: resolved.error, structured: { system: args.system ?? '', hits: [] }, isError: true };
  }
  const { data } = resolved;
  const hits = searchComponents(data, args.query, { limit: args.limit });
  const text = truncate(renderText(data.id, args.query, hits));
  return { text, structured: { system: data.id, hits } };
}

export function register(server: McpServer, registry: SystemRegistry): void {
  server.registerTool(
    'search_components',
    {
      title: 'Search components',
      description:
        "Search the design system for a component by concept, guessed name, or description before writing UI code. Use this first when you don't know the exact component name -- it understands vocabulary from other systems (e.g. 'Card', 'Box') and maps it to what this system actually calls it. Returns ranked candidates with why each matched. Never guess a component name; search for it.",
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
