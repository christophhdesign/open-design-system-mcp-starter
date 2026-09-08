// custom-elements-manifest adapter: parses a Custom Elements Manifest (schema 1.x or 2.x) into
// SystemCatalog. Each `modules[].declarations[]` entry that carries `customElement: true` and/or
// a `tagName` becomes one CatalogExport. Props come from `attributes[]` (attribute spelling wins)
// merged with non-static, non-private/protected `members[]` of kind `field`.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { CatalogEvent, CatalogExport, CatalogProp, CatalogSlot, SystemCatalog, SystemConfig, SystemId } from '../types.ts';
import { sha256 } from './index.ts';

export function extractCatalog(id: SystemId, cfg: SystemConfig, root: string): SystemCatalog {
  if (cfg.catalog.adapter !== 'custom-elements-manifest') {
    throw new Error(
      `custom-elements-manifest adapter called with catalog.adapter = '${cfg.catalog.adapter}'`
    );
  }

  const filePath = resolve(root, cfg.catalog.path);
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (err) {
    throw new Error(`custom-elements-manifest: could not read ${filePath}: ${(err as Error).message}`);
  }

  let manifest: any;
  try {
    manifest = JSON.parse(raw);
  } catch (err) {
    throw new Error(`custom-elements-manifest: ${filePath} is not valid JSON: ${(err as Error).message}`);
  }

  const components: SystemCatalog['components'] = [];
  const allExports = new Set<string>();
  const allPropsByExport: Record<string, string[]> = {};

  const modules = Array.isArray(manifest.modules) ? manifest.modules : [];
  for (const mod of modules) {
    const declarations = Array.isArray(mod?.declarations) ? mod.declarations : [];
    const exportsForModule: CatalogExport[] = [];

    for (const decl of declarations) {
      const isElement = decl?.customElement === true || typeof decl?.tagName === 'string';
      if (!isElement) continue;

      const tagName: string | undefined = typeof decl.tagName === 'string' ? decl.tagName : undefined;
      const className: string | undefined = typeof decl.name === 'string' ? decl.name : undefined;
      const displayName = tagName ?? className ?? 'UnknownElement';

      const description =
        typeof decl.description === 'string' && decl.description.length > 0
          ? decl.description
          : typeof decl.summary === 'string'
            ? decl.summary
            : '';

      const props = mergeProps(decl);
      const events = normalizeEvents(decl.events);
      const slots = normalizeSlots(decl.slots);
      const deprecated = normalizeDeclDeprecated(decl.deprecated);

      const catExport: CatalogExport = {
        displayName,
        tagName,
        description,
        props,
        events: events.length ? events : undefined,
        slots: slots.length ? slots : undefined,
        deprecated,
      };
      exportsForModule.push(catExport);

      allExports.add(displayName);
      if (className && className !== displayName) allExports.add(className);

      const propSpellings = expandPropSpellings(props.map((p) => p.name));
      allPropsByExport[displayName] = propSpellings;
      if (className && className !== displayName) allPropsByExport[className] = propSpellings;
    }

    if (exportsForModule.length) {
      components.push({ dir: typeof mod.path === 'string' ? mod.path : '', exports: exportsForModule });
    }
  }

  return {
    system: id,
    generatedAt: new Date().toISOString(),
    source: { root, adapter: 'custom-elements-manifest', srcHash: sha256(raw) },
    components,
    allExports: Array.from(allExports).sort(),
    allPropsByExport,
  };
}

function mergeProps(decl: any): CatalogProp[] {
  const attributes = Array.isArray(decl.attributes) ? decl.attributes : [];
  const members = Array.isArray(decl.members) ? decl.members : [];

  const props: CatalogProp[] = [];
  const seen = new Set<string>();

  for (const attr of attributes) {
    if (typeof attr?.name !== 'string') continue;
    props.push({
      name: attr.name,
      type: typeof attr.type?.text === 'string' ? attr.type.text : 'string',
      required: false,
      defaultValue: typeof attr.default === 'string' ? attr.default : undefined,
      description: typeof attr.description === 'string' ? attr.description : undefined,
      deprecated: normalizePropDeprecated(attr.deprecated),
    });
    seen.add(canonicalPropKey(attr.name));
  }

  for (const member of members) {
    if (member?.kind !== 'field') continue;
    if (member.static === true) continue;
    if (member.privacy === 'private' || member.privacy === 'protected') continue;
    if (typeof member.name !== 'string') continue;
    if (seen.has(canonicalPropKey(member.name))) continue;

    props.push({
      name: member.name,
      type: typeof member.type?.text === 'string' ? member.type.text : 'unknown',
      required: false,
      defaultValue: typeof member.default === 'string' ? member.default : undefined,
      description: typeof member.description === 'string' ? member.description : undefined,
      deprecated: normalizePropDeprecated(member.deprecated),
    });
    seen.add(canonicalPropKey(member.name));
  }

  return props;
}

function normalizeEvents(raw: unknown): CatalogEvent[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((e: any) => typeof e?.name === 'string')
    .map((e: any) => ({
      name: e.name,
      type: typeof e.type?.text === 'string' ? e.type.text : typeof e.type === 'string' ? e.type : undefined,
      description: typeof e.description === 'string' ? e.description : undefined,
    }));
}

function normalizeSlots(raw: unknown): CatalogSlot[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((s: any) => ({
    name: typeof s?.name === 'string' ? s.name : '',
    description: typeof s?.description === 'string' ? s.description : undefined,
  }));
}

function normalizePropDeprecated(raw: unknown): string | undefined {
  if (raw === true) return 'deprecated';
  if (typeof raw === 'string' && raw.length > 0) return raw;
  return undefined;
}

function normalizeDeclDeprecated(raw: unknown): CatalogExport['deprecated'] {
  if (raw === true) return {};
  if (typeof raw === 'string' && raw.length > 0) return { note: raw };
  return undefined;
}

/** Lowercased, dash-stripped, for matching "aria-label" against "ariaLabel". */
function canonicalPropKey(name: string): string {
  return name.toLowerCase().replace(/-/g, '');
}

function kebabToCamel(name: string): string {
  return name.replace(/-([a-z0-9])/gi, (_, c: string) => c.toUpperCase());
}

function camelToKebab(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
}

/** Every prop name plus its kebab and camel spellings, per SystemCatalog.allPropsByExport. */
function expandPropSpellings(names: string[]): string[] {
  const set = new Set<string>();
  for (const name of names) {
    set.add(name);
    set.add(kebabToCamel(name));
    set.add(camelToKebab(name));
  }
  return Array.from(set).sort();
}
