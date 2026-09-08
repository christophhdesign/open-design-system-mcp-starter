import { z } from 'zod';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { listTokens } from '../search/index.ts';
import type { SystemId, SystemRegistry, Token, TokenCategory } from '../types.ts';
import { resolveSystem, truncate } from './index.ts';

export interface ListTokensArgs {
  system?: string;
  category?: TokenCategory;
  query?: string;
  limit?: number;
}

export interface ListTokensResult {
  system: SystemId;
  count: number;
  tokens: Token[];
}

const CATEGORY_VALUES = ['color', 'space', 'size', 'typography', 'radius', 'shadow', 'motion', 'border', 'opacity', 'z-index', 'other'] as const;

const inputShape = {
  system: z.string().optional().describe('System id to search. Optional when only one system is configured.'),
  category: z.enum(CATEGORY_VALUES).optional().describe('Restrict the list to one token category.'),
  query: z.string().optional().describe("Filter by word, matched against name segments and description (e.g. 'muted', 'gap').") ,
  limit: z.number().int().positive().max(200).optional().describe('Max tokens to return. Default 40.'),
};

function writeFor(token: Token): string {
  return token.cssVar ? `var(${token.cssVar})` : token.name;
}

function renderText(system: string, tokens: Token[]): string {
  if (tokens.length === 0) {
    return `No tokens in '${system}' matched. Never write a raw color or length value; broaden the query or drop the category filter.`;
  }
  const header = '| token | write | value | themes |\n| --- | --- | --- | --- |';
  const rows = tokens.map((t) => {
    const themes = t.valuesByTheme ? Object.keys(t.valuesByTheme).join(', ') : '';
    return `| ${t.name} | \`${writeFor(t)}\` | ${t.value ?? ''} | ${themes} |`;
  });
  return `Tokens in ${system}:\n\n${[header, ...rows].join('\n')}`;
}

export function run(registry: SystemRegistry, args: ListTokensArgs): { text: string; structured: ListTokensResult; isError?: true } {
  const resolved = resolveSystem(registry, args.system);
  if ('error' in resolved) {
    return { text: resolved.error, structured: { system: args.system ?? '', count: 0, tokens: [] }, isError: true };
  }
  const { data } = resolved;
  const tokens = listTokens(data, { category: args.category, query: args.query, limit: args.limit });
  const text = truncate(renderText(data.id, tokens));
  return { text, structured: { system: data.id, count: tokens.length, tokens } };
}

export function register(server: McpServer, registry: SystemRegistry): void {
  server.registerTool(
    'list_tokens',
    {
      title: 'List design tokens',
      description:
        "List design tokens, optionally filtered by category (color, space, size, typography, radius, shadow, motion, border, opacity, z-index) or a word. Use this to browse what's available (e.g. every space token, every color) rather than guessing a token name; use find_token instead when you have a raw value or a single word to translate.",
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
