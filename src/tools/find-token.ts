import { z } from 'zod';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { findTokens } from '../search/index.ts';
import type { SystemId, SystemRegistry, TokenCategory, TokenHit } from '../types.ts';
import { resolveSystem, truncate } from './index.ts';

export interface FindTokenArgs {
  system?: string;
  query: string;
  category?: TokenCategory;
  limit?: number;
}

export interface FindTokenResult {
  system: SystemId;
  hits: TokenHit[];
}

const CATEGORY_VALUES = ['color', 'space', 'size', 'typography', 'radius', 'shadow', 'motion', 'border', 'opacity', 'z-index', 'other'] as const;

const inputShape = {
  system: z.string().optional().describe('System id to search. Optional when only one system is configured.'),
  query: z.string().describe("A raw value to translate (e.g. '#1a1a1a', '16px', '1rem') or a word (e.g. 'muted', 'gap')."),
  category: z.enum(CATEGORY_VALUES).optional().describe('Restrict the search to one token category.'),
  limit: z.number().int().positive().max(20).optional().describe('Max hits to return. Default 6.'),
};

function renderText(system: string, query: string, hits: TokenHit[]): string {
  if (hits.length === 0) {
    return `No tokens in '${system}' matched "${query}". Never write a raw color or length value; if nothing matches, say so and ask.`;
  }
  const lines = hits.map((h, i) => {
    const theme = h.token.valuesByTheme ? ` (themes: ${Object.entries(h.token.valuesByTheme).map(([k, v]) => `${k}=${v}`).join(', ')})` : '';
    return `${i + 1}. write \`${h.write}\` -- **${h.token.name}** [${h.token.category}]${h.token.value ? `, value ${h.token.value}` : ''}${theme}\n   matched: ${h.matchedOn.join(', ')}`;
  });
  return `Token matches for "${query}" in ${system}:\n\n${lines.join('\n\n')}`;
}

export function run(registry: SystemRegistry, args: FindTokenArgs): { text: string; structured: FindTokenResult; isError?: true } {
  const resolved = resolveSystem(registry, args.system);
  if ('error' in resolved) {
    return { text: resolved.error, structured: { system: args.system ?? '', hits: [] }, isError: true };
  }
  const { data } = resolved;
  const hits = findTokens(data, args.query, { category: args.category, limit: args.limit });
  const text = truncate(renderText(data.id, args.query, hits));
  return { text, structured: { system: data.id, hits } };
}

export function register(server: McpServer, registry: SystemRegistry): void {
  server.registerTool(
    'find_token',
    {
      title: 'Find a design token',
      description:
        "Find the design token for a raw color, a raw length, or a word like 'muted' or 'gap', before writing a hex code, rgb(), or a bare px/rem value in code. Returns exactly what to write (var(--x), or a class when the system exposes one) and the per-theme values. Never hardcode a color or spacing value; find the token instead.",
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
