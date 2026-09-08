// catalog-json adapter: loads an already-built catalog. Accepts either this repo's SystemCatalog
// shape or the minimal sibling shape `{ components, allExports, allPropsByExport }` (the format
// open-design-system-bench extracts), fills in defaults, and restamps `system` and
// `source.adapter` so the file always reflects the system it was loaded for.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { CatalogEvent, CatalogExport, CatalogProp, CatalogSlot, SystemCatalog, SystemConfig, SystemId } from '../types.ts';
import { sha256 } from './index.ts';

export function extractCatalog(id: SystemId, cfg: SystemConfig, root: string): SystemCatalog {
  if (cfg.catalog.adapter !== 'catalog-json') {
    throw new Error(`catalog-json adapter called with catalog.adapter = '${cfg.catalog.adapter}'`);
  }

  const filePath = resolve(root, cfg.catalog.path);
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (err) {
    throw new Error(`catalog-json: could not read ${filePath}: ${(err as Error).message}`);
  }

  let json: Record<string, unknown>;
  try {
    json = JSON.parse(raw) as Record<string, unknown>;
  } catch (err) {
    throw new Error(`catalog-json: ${filePath} is not valid JSON: ${(err as Error).message}`);
  }

  const components = normalizeComponents(json.components);
  const allExports: string[] = Array.isArray(json.allExports)
    ? (json.allExports as string[])
    : deriveAllExports(components);
  const allPropsByExport: Record<string, string[]> =
    json.allPropsByExport && typeof json.allPropsByExport === 'object'
      ? (json.allPropsByExport as Record<string, string[]>)
      : derivePropsByExport(components);

  const existingSource =
    json.source && typeof json.source === 'object' ? (json.source as Record<string, unknown>) : {};

  return {
    system: id,
    generatedAt: typeof json.generatedAt === 'string' ? json.generatedAt : new Date().toISOString(),
    source: {
      root,
      commit: typeof existingSource.commit === 'string' ? existingSource.commit : undefined,
      // Freshness compares against the file this adapter reads, so the stamp must be
      // the hash of that file. A hash the upstream tool stamped (of its own source
      // tree) is kept separately for provenance.
      srcHash: sha256(raw),
      ...(typeof existingSource.srcHash === 'string' && existingSource.srcHash !== sha256(raw)
        ? { upstreamSrcHash: existingSource.srcHash }
        : {}),
      adapter: 'catalog-json',
    },
    components,
    allExports,
    allPropsByExport,
  };
}

function normalizeComponents(raw: unknown): SystemCatalog['components'] {
  if (!Array.isArray(raw)) return [];
  return raw.map((c: any) => ({
    dir: typeof c?.dir === 'string' ? c.dir : '',
    exports: Array.isArray(c?.exports) ? c.exports.map(normalizeExport) : [],
  }));
}

function normalizeExport(e: any): CatalogExport {
  return {
    displayName: String(e?.displayName ?? ''),
    tagName: typeof e?.tagName === 'string' ? e.tagName : undefined,
    description: typeof e?.description === 'string' ? e.description : '',
    props: Array.isArray(e?.props) ? e.props.map(normalizeProp) : [],
    inheritedProps: Array.isArray(e?.inheritedProps) ? e.inheritedProps : undefined,
    events: Array.isArray(e?.events) ? e.events.map(normalizeEvent) : undefined,
    slots: Array.isArray(e?.slots) ? e.slots.map(normalizeSlot) : undefined,
    examples: Array.isArray(e?.examples) ? e.examples : undefined,
    a11y: e?.a11y && typeof e.a11y === 'object' ? e.a11y : undefined,
    guidance: e?.guidance && typeof e.guidance === 'object' ? e.guidance : undefined,
    deprecated: e?.deprecated && typeof e.deprecated === 'object' ? e.deprecated : undefined,
    docs: Array.isArray(e?.docs) ? e.docs : undefined,
  };
}

function normalizeProp(p: any): CatalogProp {
  return {
    name: String(p?.name ?? ''),
    type: typeof p?.type === 'string' ? p.type : 'unknown',
    required: !!p?.required,
    defaultValue: typeof p?.defaultValue === 'string' ? p.defaultValue : undefined,
    description: typeof p?.description === 'string' ? p.description : undefined,
    deprecated: typeof p?.deprecated === 'string' ? p.deprecated : undefined,
  };
}

function normalizeEvent(e: any): CatalogEvent {
  return {
    name: String(e?.name ?? ''),
    type: typeof e?.type === 'string' ? e.type : undefined,
    description: typeof e?.description === 'string' ? e.description : undefined,
  };
}

function normalizeSlot(s: any): CatalogSlot {
  return {
    name: typeof s?.name === 'string' ? s.name : '',
    description: typeof s?.description === 'string' ? s.description : undefined,
  };
}

function deriveAllExports(components: SystemCatalog['components']): string[] {
  const names = new Set<string>();
  for (const c of components) {
    for (const e of c.exports) names.add(e.displayName);
  }
  return Array.from(names).sort();
}

function derivePropsByExport(components: SystemCatalog['components']): Record<string, string[]> {
  const map: Record<string, string[]> = {};
  for (const c of components) {
    for (const e of c.exports) {
      map[e.displayName] = e.props.map((p) => p.name);
    }
  }
  return map;
}
