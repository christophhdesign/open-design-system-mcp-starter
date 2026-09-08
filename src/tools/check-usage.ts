import { z } from 'zod';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { checkUsage } from '../check/analyze.ts';
import type { SystemRegistry, UsageReport } from '../types.ts';
import { resolveSystem, truncate } from './index.ts';

export interface CheckUsageArgs {
  system?: string;
  code: string;
  language?: 'tsx' | 'html' | 'auto';
  filename?: string;
  extraAllowedImports?: string[];
}

export type CheckUsageResult = UsageReport | { system: string; error: string };

const inputShape = {
  system: z.string().optional().describe('System id to check against. Optional when only one system is configured.'),
  code: z.string().describe('The JSX/TSX or HTML snippet to check.'),
  language: z.enum(['tsx', 'html', 'auto']).optional().describe("Force the language instead of auto-detecting from the snippet. Default 'auto'."),
  filename: z.string().optional().describe('Filename to associate with the snippet; cosmetic only.'),
  extraAllowedImports: z.array(z.string()).optional().describe('Additional import specifiers to allow, beyond the system package, foundations package, and react/react-dom.'),
};

function renderText(report: UsageReport): string {
  const errors = report.findings.filter((f) => f.severity === 'error').length;
  const warnings = report.findings.filter((f) => f.severity === 'warning').length;
  const usedLabel = report.usedComponents.length > 0 ? report.usedComponents.join(', ') : '(none)';

  const lines: string[] = [];
  lines.push(`${errors} error${errors === 1 ? '' : 's'}, ${warnings} warning${warnings === 1 ? '' : 's'}. Components used: ${usedLabel}.`);

  if (report.usedComponents.length === 0) {
    lines.push("\n**No design-system components were used in this snippet.** If that's not intentional, call search_components to find the right one instead of writing raw markup.");
  }

  for (const f of report.findings) {
    const loc = f.line !== undefined ? `line ${f.line}` : 'unknown line';
    const fix = f.fix ? ` (fix: ${f.fix})` : '';
    lines.push(`- [${f.severity}] ${loc}: ${f.message}${fix}`);
  }

  return lines.join('\n');
}

export function run(registry: SystemRegistry, args: CheckUsageArgs): { text: string; structured: CheckUsageResult; isError?: true } {
  const resolved = resolveSystem(registry, args.system);
  if ('error' in resolved) {
    return { text: resolved.error, structured: { system: args.system ?? '', error: resolved.error }, isError: true };
  }
  const { data } = resolved;
  const report = checkUsage(data, args.code, { language: args.language, filename: args.filename, extraAllowedImports: args.extraAllowedImports });
  const text = truncate(renderText(report));
  return { text, structured: report };
}

export function register(server: McpServer, registry: SystemRegistry): void {
  server.registerTool(
    'check_usage',
    {
      title: 'Check design-system usage',
      description:
        'Check a JSX/TSX or HTML snippet against the design system BEFORE committing it: unknown components (including hallucinated imports), invented props, invalid literal/boolean/number prop values, raw colors and lengths, missing accessible names, disallowed imports, deprecated API. Call it on every file you write that uses the system.',
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
