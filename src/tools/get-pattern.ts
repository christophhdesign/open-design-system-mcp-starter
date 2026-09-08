import { z } from 'zod';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { searchPatterns } from '../search/index.ts';
import type { Pattern, SystemData, SystemId, SystemRegistry } from '../types.ts';
import { resolveSystem, truncate } from './index.ts';

export interface GetPatternArgs {
  system?: string;
  query: string;
  limit?: number;
}

export interface GetPatternResult {
  system: SystemId;
  hits: Array<Pattern & { score: number; matchedOn: string[] }>;
  note?: string;
}

const inputShape = {
  system: z.string().optional().describe('System id to search. Optional when only one system is configured.'),
  query: z.string().describe("What you need, in plain words, e.g. 'labeled form field with error', 'confirm dialog', 'empty state'."),
  limit: z.number().int().positive().max(20).optional().describe('Max patterns to return. Default 5.'),
};

function noPatternsNote(data: SystemData): string {
  return (
    `No patterns are authored yet for '${data.id}'.\n` +
    `Add markdown files to data/${data.id}/patterns/: optional front matter (title, description, tags, language) between `+
    `'---' lines, then a first H1 as the title, a first paragraph as the description, and one fenced code block as the code.\n` +
    `Try search_components in the meantime and compose the UI from individual components.`
  );
}

function renderText(system: SystemId, query: string, hits: Array<Pattern & { score: number; matchedOn: string[] }>): string {
  if (hits.length === 0) {
    return `No patterns in '${system}' matched "${query}". Try a broader phrase, or use search_components to compose from individual components.`;
  }
  const sections = hits.map((h) => {
    const uses = h.components.length > 0 ? `\nuses: ${h.components.join(', ')}` : '';
    return `### ${h.title}\n${h.description}\n\n\`\`\`${h.language}\n${h.code}\n\`\`\`${uses}`;
  });
  return `Patterns for "${query}" in ${system}:\n\n${sections.join('\n\n')}`;
}

export function run(registry: SystemRegistry, args: GetPatternArgs): { text: string; structured: GetPatternResult; isError?: true } {
  const resolved = resolveSystem(registry, args.system);
  if ('error' in resolved) {
    return { text: resolved.error, structured: { system: args.system ?? '', hits: [] }, isError: true };
  }
  const { data } = resolved;

  if (!data.patterns || data.patterns.length === 0) {
    const note = noPatternsNote(data);
    return { text: note, structured: { system: data.id, hits: [], note } };
  }

  const hits = searchPatterns(data, args.query, { limit: args.limit });
  const text = truncate(renderText(data.id, args.query, hits));
  return { text, structured: { system: data.id, hits } };
}

export function register(server: McpServer, registry: SystemRegistry): void {
  server.registerTool(
    'get_pattern',
    {
      title: 'Get a design system pattern',
      description:
        "Get a complete, correct recipe composed from this design system's real components for a common UI need (labeled field with error, confirm dialog, empty state). Prefer a pattern over composing from scratch.",
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
