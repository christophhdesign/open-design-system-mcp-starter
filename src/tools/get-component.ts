import { z } from 'zod';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { getComponentDetail, searchComponents } from '../search/index.ts';
import type { ComponentDetail, SearchHit, SystemId, SystemRegistry } from '../types.ts';
import { resolveSystem, truncate } from './index.ts';

export interface GetComponentArgs {
  system?: string;
  name: string;
  detail?: 'brief' | 'full';
}

export type GetComponentResult =
  | { system: SystemId; component: ComponentDetail }
  | { system: SystemId; error: string; nearest: SearchHit[] };

const inputShape = {
  system: z.string().optional().describe('System id to look up. Optional when only one system is configured.'),
  name: z.string().describe('The exact component name or tag to inspect (use resolve_component first if unsure it exists).'),
  detail: z.enum(['brief', 'full']).optional().describe("'brief' returns a compact summary (props + a11y). 'full' (default) includes examples, guidance and common mistakes."),
};

function renderText(detail: ComponentDetail, level: 'brief' | 'full'): string {
  const lines: string[] = [];
  lines.push(`# ${detail.name}${detail.tagName ? ` (\`${detail.tagName}\`)` : ''}`);
  lines.push(detail.description);
  lines.push(`\nUsage: \`${detail.usage}\``);
  if (detail.deprecated) {
    lines.push(`\n**Deprecated**${detail.deprecated.since ? ` since ${detail.deprecated.since}` : ''}${detail.deprecated.replacement ? `, use ${detail.deprecated.replacement}` : ''}. ${detail.deprecated.note ?? ''}`);
  }

  lines.push('\n## Props');
  if (detail.props.length === 0) {
    lines.push('(none)');
  } else {
    for (const p of detail.props) {
      const req = p.required ? ' (required)' : '';
      const def = p.defaultValue !== undefined ? `, default \`${p.defaultValue}\`` : '';
      const dep = p.deprecated ? ` -- DEPRECATED: ${p.deprecated}` : '';
      lines.push(`- \`${p.name}\`: \`${p.type}\`${req}${def}${dep}${p.description ? ` -- ${p.description}` : ''}`);
    }
  }
  if (detail.inheritedProps?.length) {
    lines.push(`\nInherited props: ${detail.inheritedProps.map((p) => `\`${p}\``).join(', ')}`);
  }

  if (detail.a11y?.accessibleName && detail.a11y.accessibleName !== 'none') {
    lines.push(`\n## Accessibility\nAccessible name: **${detail.a11y.accessibleName}**.`);
    for (const n of detail.a11y.notes ?? []) lines.push(`- ${n}`);
  }

  if (level === 'full') {
    if (detail.events?.length) {
      lines.push('\n## Events');
      for (const e of detail.events) lines.push(`- \`${e.name}\`${e.type ? `: \`${e.type}\`` : ''}${e.description ? ` -- ${e.description}` : ''}`);
    }
    if (detail.slots?.length) {
      lines.push('\n## Slots');
      for (const s of detail.slots) lines.push(`- ${s.name === '' ? '(default)' : `\`${s.name}\``}${s.description ? ` -- ${s.description}` : ''}`);
    }
    if (detail.commonMistakes?.length) {
      lines.push('\n## Common mistakes');
      for (const m of detail.commonMistakes) lines.push(`- Wrote \`${m.wrote}\`, use \`${m.use}\`.${m.note ? ` ${m.note}` : ''}`);
    }
    if (detail.guidance?.do?.length) {
      lines.push('\n## Do');
      for (const d of detail.guidance.do) lines.push(`- ${d}`);
    }
    if (detail.guidance?.dont?.length) {
      lines.push('\n## Don\'t');
      for (const d of detail.guidance.dont) lines.push(`- ${d}`);
    }
    if (detail.examples.length) {
      lines.push('\n## Examples');
      for (const ex of detail.examples) {
        lines.push(`${ex.title ? `**${ex.title}**\n` : ''}\`\`\`${ex.language ?? ''}\n${ex.code}\n\`\`\``);
      }
    }
  }

  return lines.join('\n');
}

export function run(registry: SystemRegistry, args: GetComponentArgs): { text: string; structured: GetComponentResult; isError?: true } {
  const resolved = resolveSystem(registry, args.system);
  if ('error' in resolved) {
    return { text: resolved.error, structured: { system: args.system ?? '', error: resolved.error, nearest: [] }, isError: true };
  }
  const { data } = resolved;
  const detail = getComponentDetail(data, args.name);
  if (!detail) {
    const nearest = searchComponents(data, args.name, { limit: 3 });
    const systemName = data.cfg.name ?? data.id;
    const nearestText = nearest.length > 0 ? ` Nearest: ${nearest.map((h) => h.tagName ?? h.name).join(', ')}.` : '';
    const message = `'${args.name}' is not a component in ${systemName}.${nearestText} Never guess -- call search_components or resolve_component first.`;
    return { text: message, structured: { system: data.id, error: message, nearest }, isError: true };
  }
  const level = args.detail ?? 'full';
  const budget = level === 'brief' ? 1200 : 4000;
  const text = truncate(renderText(detail, level), budget);
  return { text, structured: { system: data.id, component: detail } };
}

export function register(server: McpServer, registry: SystemRegistry): void {
  server.registerTool(
    'get_component',
    {
      title: 'Get component detail',
      description:
        "Get the real props, types, allowed values, events, slots, accessibility rule and examples for one component. Call this before writing any props for a component; never guess a prop name or an allowed value. Also returns common mistakes -- prop names agents commonly get wrong on this component, and the right spelling.",
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
