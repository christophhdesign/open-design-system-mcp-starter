import { z } from 'zod';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { searchDocs } from '../search/index.ts';
import type { DocChunk, SystemId, SystemRegistry } from '../types.ts';
import { resolveSystem, truncate } from './index.ts';

export interface GetGuidanceArgs {
  system?: string;
  topic: string;
  component?: string;
}

export interface GetGuidanceResult {
  system: SystemId;
  chunks: Array<DocChunk & { score: number; matchedOn: string[] }>;
  note?: string;
}

const inputShape = {
  system: z.string().optional().describe('System id to search. Optional when only one system is configured.'),
  topic: z.string().describe("A component name, or a question like 'when not to use a modal' or 'how do I migrate off the deprecated variant prop'."),
  component: z.string().optional().describe('Narrow results to docs that mention this exact component name or tag.'),
};

function renderText(system: string, topic: string, chunks: Array<DocChunk & { score: number; matchedOn: string[] }>): string {
  if (chunks.length === 0) {
    return `No docs in '${system}' matched "${topic}". Try a broader phrase, or drop the component filter.`;
  }
  const sections = chunks.map((c) => `### ${c.trail.join(' > ')} (${c.path})\n${c.text}`);
  return `Guidance for "${topic}" in ${system}:\n\n${sections.join('\n\n')}`;
}

export function run(registry: SystemRegistry, args: GetGuidanceArgs): { text: string; structured: GetGuidanceResult; isError?: true } {
  const resolved = resolveSystem(registry, args.system);
  if ('error' in resolved) {
    return { text: resolved.error, structured: { system: args.system ?? '', chunks: [] }, isError: true };
  }
  const { data } = resolved;

  if (!data.docs || data.docs.chunks.length === 0) {
    const note = `No docs are indexed for '${data.id}'. Add "docs": { "include": [...] } to ds.config.json for this system and run extract.`;
    return { text: note, structured: { system: data.id, chunks: [], note } };
  }

  const chunks = searchDocs(data, args.topic, { component: args.component });
  const text = truncate(renderText(data.id, args.topic, chunks));
  return { text, structured: { system: data.id, chunks } };
}

export function register(server: McpServer, registry: SystemRegistry): void {
  server.registerTool(
    'get_guidance',
    {
      title: 'Get design guidance from docs',
      description:
        "Get written guidance from this system's own docs -- when to use or not use a component, migration notes, patterns -- for a component name or a question (e.g. 'when not to use a modal', 'how do I migrate off the deprecated variant prop'). Call this before making a judgment call the API surface alone doesn't answer. Returns the most relevant doc sections, ranked, never a guess.",
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
