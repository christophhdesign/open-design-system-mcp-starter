// MCP resources: the same data the tools serve, exposed for clients that
// attach context up front rather than calling a tool mid-task.

import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ReadResourceResult } from '@modelcontextprotocol/sdk/types.js';

import { componentSummary, getComponentDetail } from './search/index.ts';
import type { SystemData, SystemRegistry } from './types.ts';

function first(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

function getSystemOrThrow(registry: SystemRegistry, id: string | undefined): SystemData {
  if (!id) throw new Error('A system id is required in the resource URI.');
  return registry.get(id);
}

function compactCatalog(data: SystemData) {
  return data.catalog.components.flatMap((c) => c.exports.map((exp) => componentSummary(data, exp)));
}

function compactTokens(data: SystemData) {
  return (data.tokens?.tokens ?? []).map((t) => ({ name: t.name, cssVar: t.cssVar, value: t.value, category: t.category }));
}

function llmsTxt(data: SystemData): string {
  const name = data.cfg.name ?? data.id;
  const how =
    data.cfg.componentModel === 'custom-elements'
      ? `Register once by importing '${data.cfg.componentsPkg ?? data.id}', then use its elements as HTML tags.`
      : `Import components by name from '${data.cfg.componentsPkg ?? data.id}'.`;
  const lines = [`# ${name}`, '', how, '', 'Components:'];
  // Catalog exports only. allExports also carries importable symbols (class
  // names, helpers) that have no entry of their own and would list blank.
  for (const c of data.catalog.components) {
    for (const exp of c.exports) lines.push(`- ${exp.displayName}: ${exp.description}`);
  }
  return lines.join('\n');
}

export function registerResources(server: McpServer, registry: SystemRegistry): void {
  server.registerResource(
    'catalog',
    new ResourceTemplate('ds://{system}/catalog', {
      list: async () => ({
        resources: registry.ids().map((id) => ({ uri: `ds://${id}/catalog`, name: `${id} catalog`, mimeType: 'application/json' })),
      }),
    }),
    { title: 'Component catalog', description: 'Compact catalog: name, tag, one-line description, usage, deprecated flag.', mimeType: 'application/json' },
    async (uri, variables): Promise<ReadResourceResult> => {
      const data = getSystemOrThrow(registry, first(variables.system));
      return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(compactCatalog(data), null, 2) }] };
    },
  );

  server.registerResource(
    'tokens',
    new ResourceTemplate('ds://{system}/tokens', {
      list: async () => ({
        resources: registry.ids().map((id) => ({ uri: `ds://${id}/tokens`, name: `${id} tokens`, mimeType: 'application/json' })),
      }),
    }),
    { title: 'Design tokens', description: 'Compact token list: name, CSS var, value, category.', mimeType: 'application/json' },
    async (uri, variables): Promise<ReadResourceResult> => {
      const data = getSystemOrThrow(registry, first(variables.system));
      return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(compactTokens(data), null, 2) }] };
    },
  );

  server.registerResource(
    'component',
    new ResourceTemplate('ds://{system}/components/{name}', {
      list: async () => ({
        resources: registry.ids().flatMap((id) => {
          const data = registry.get(id);
          return data.catalog.components.flatMap((c) =>
            c.exports.map((exp) => ({
              uri: `ds://${id}/components/${exp.displayName}`,
              name: `${id}: ${exp.displayName}`,
              mimeType: 'application/json',
            })),
          );
        }),
      }),
    }),
    { title: 'Component detail', description: 'Full detail for one component: props, events, slots, a11y, examples.', mimeType: 'application/json' },
    async (uri, variables): Promise<ReadResourceResult> => {
      const data = getSystemOrThrow(registry, first(variables.system));
      const name = first(variables.name);
      const detail = name ? getComponentDetail(data, name) : undefined;
      if (!detail) {
        throw new Error(`Component '${name}' not found in system '${data.id}'.`);
      }
      return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(detail, null, 2) }] };
    },
  );

  server.registerResource(
    'llms-txt',
    new ResourceTemplate('ds://{system}/llms.txt', {
      list: async () => ({
        resources: registry.ids().map((id) => ({ uri: `ds://${id}/llms.txt`, name: `${id} llms.txt`, mimeType: 'text/plain' })),
      }),
    }),
    { title: 'llms.txt index', description: 'A short generated index: system, how to consume it, one line per component.', mimeType: 'text/plain' },
    async (uri, variables): Promise<ReadResourceResult> => {
      const data = getSystemOrThrow(registry, first(variables.system));
      return { contents: [{ uri: uri.href, mimeType: 'text/plain', text: llmsTxt(data) }] };
    },
  );
}
