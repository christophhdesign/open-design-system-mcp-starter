// Synthetic system data for tests. Fictional names only ("Acme" is the
// starter's own example vendor, see ds.config.json) -- never a real design
// system.

import type {
  AliasEntry,
  AliasMap,
  CatalogExport,
  DocsIndex,
  Pattern,
  SystemCatalog,
  SystemConfig,
  SystemData,
  SystemRegistry,
  SystemTokens,
  Token,
} from './types.ts';

export interface MakeSystemDataOptions extends Partial<SystemData> {
  model?: 'react' | 'custom-elements';
}

function buildExports(model: 'react' | 'custom-elements'): CatalogExport[] {
  const isCe = model === 'custom-elements';

  const surface: CatalogExport = {
    displayName: isCe ? 'acme-surface' : 'Surface',
    description: 'A container with padding and a background; the base building block for cards and panels.',
    props: [
      { name: 'tone', type: "'neutral' | 'brand'", required: false, defaultValue: 'neutral', description: 'Background emphasis.' },
      { name: 'padding', type: "'none' | 'sm' | 'md' | 'lg'", required: false, defaultValue: 'md', description: 'Inner spacing scale.' },
      { name: 'bordered', type: 'boolean', required: false, defaultValue: 'false', description: 'Draw a hairline border.' },
    ],
    inheritedProps: ['className', 'style'],
    slots: isCe ? [{ name: '', description: 'Default slot: the surface content.' }] : undefined,
    a11y: { accessibleName: 'none' },
    examples: [{ title: 'Basic surface', code: isCe ? '<acme-surface tone="brand">Hello</acme-surface>' : '<Surface tone="brand">Hello</Surface>', language: isCe ? 'html' : 'tsx' }],
    docs: ['docs/surface.md'],
  };

  const stack: CatalogExport = {
    displayName: isCe ? 'acme-stack' : 'Stack',
    description: 'Lays out children in a row or column with a consistent gap between them.',
    props: [
      { name: 'direction', type: "'row' | 'column'", required: false, defaultValue: 'column', description: 'Layout axis.' },
      { name: 'gap', type: "'xs' | 'sm' | 'md' | 'lg' | 'xl'", required: false, defaultValue: 'md', description: 'Space between children, from the space scale.' },
      { name: 'align', type: "'start' | 'center' | 'end' | 'stretch'", required: false, defaultValue: 'stretch', description: 'Cross-axis alignment.' },
    ],
    inheritedProps: ['className'],
    examples: [],
    docs: [],
  };

  const button: CatalogExport = {
    displayName: isCe ? 'acme-button' : 'Button',
    description: 'A clickable control that triggers an action.',
    props: [
      { name: 'tone', type: "'neutral' | 'brand' | 'danger'", required: false, defaultValue: 'neutral', description: 'Visual emphasis.' },
      { name: 'size', type: "'sm' | 'md' | 'lg'", required: false, defaultValue: 'md', description: 'Control size.' },
      { name: 'disabled', type: 'boolean', required: false, defaultValue: 'false', description: 'Disables interaction.' },
      { name: 'iconOnly', type: 'boolean', required: false, defaultValue: 'false', description: 'Renders without visible text; requires an accessible name.' },
    ],
    inheritedProps: [],
    events: isCe ? [{ name: 'press', type: 'CustomEvent<void>', description: 'Fires when the button is activated.' }] : undefined,
    a11y: { accessibleName: 'recommended', notes: ['Icon-only buttons must set aria-label or another accessible name.'] },
    examples: [{ title: 'Primary action', code: isCe ? '<acme-button tone="brand">Save</acme-button>' : '<Button tone="brand">Save</Button>', language: isCe ? 'html' : 'tsx' }],
    docs: ['docs/button.md'],
  };

  const textInput: CatalogExport = {
    displayName: isCe ? 'acme-text-input' : 'TextInput',
    description: 'A single-line text field.',
    props: [
      { name: 'value', type: 'string', required: false, description: 'Current value.' },
      { name: 'placeholder', type: 'string', required: false, description: 'Placeholder text.' },
      { name: 'disabled', type: 'boolean', required: false, defaultValue: 'false' },
      { name: 'required', type: 'boolean', required: false, defaultValue: 'false' },
    ],
    inheritedProps: ['id', 'name'],
    events: isCe ? [{ name: 'change', type: 'CustomEvent<string>', description: 'Fires when the value commits.' }] : undefined,
    a11y: { accessibleName: 'required', notes: ['Provide a label via <label>, aria-label, or aria-labelledby.'] },
    examples: [],
    docs: [],
  };

  const badge: CatalogExport = {
    displayName: isCe ? 'acme-badge' : 'Badge',
    description: 'A small status indicator.',
    props: [
      { name: 'tone', type: "'neutral' | 'info' | 'success' | 'danger'", required: false, defaultValue: 'neutral' },
      { name: 'color', type: 'string', required: false, description: 'Legacy raw color override.', deprecated: 'use tone instead' },
      { name: 'size', type: "'sm' | 'md'", required: false, defaultValue: 'md' },
    ],
    inheritedProps: [],
    examples: [],
    docs: [],
  };

  return [surface, stack, button, textInput, badge];
}

function buildCatalog(id: string, model: 'react' | 'custom-elements'): SystemCatalog {
  const exports = buildExports(model);
  const allExports = exports.map((e) => e.displayName);
  const allPropsByExport: Record<string, string[]> = {};
  for (const exp of exports) {
    const names = exp.props.map((p) => p.name);
    if (model === 'custom-elements') {
      const withKebab = new Set<string>();
      for (const n of names) {
        withKebab.add(n);
        const kebab = n.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
        withKebab.add(kebab);
      }
      allPropsByExport[exp.displayName] = [...withKebab];
    } else {
      allPropsByExport[exp.displayName] = names;
    }
  }
  return {
    system: id,
    generatedAt: '2026-08-25T00:00:00.000Z',
    source: { root: '/virtual/acme', adapter: model === 'custom-elements' ? 'custom-elements-manifest' : 'react-docgen' },
    components: exports.map((exp) => ({ dir: `src/components/${exp.displayName.replace(/^acme-/, '')}`, exports: [exp] })),
    allExports,
    allPropsByExport,
  };
}

function buildTokens(id: string): SystemTokens {
  const tokens: Token[] = [
    // Primitives
    { name: 'color.gray.900', cssVar: '--acme-color-gray-900', value: '#111318', category: 'color' },
    { name: 'color.gray.0', cssVar: '--acme-color-gray-0', value: '#ffffff', category: 'color' },
    { name: 'color.brand.600', cssVar: '--acme-color-brand-600', value: '#2563eb', category: 'color' },
    { name: 'space.1', cssVar: '--acme-space-1', value: '4px', category: 'space' },
    { name: 'space.2', cssVar: '--acme-space-2', value: '8px', category: 'space' },
    { name: 'space.4', cssVar: '--acme-space-4', value: '16px', category: 'space' },
    { name: 'radius.sm', cssVar: '--acme-radius-sm', value: '4px', category: 'radius' },
    { name: 'radius.md', cssVar: '--acme-radius-md', value: '8px', category: 'radius' },
    { name: 'typography.body', cssVar: '--acme-typography-body', value: '14px', category: 'typography', description: 'Default body text size.' },
    // Semantic layer: reference primitives via var(), with per-theme values.
    {
      name: 'color.text.default',
      cssVar: '--acme-color-text-default',
      value: 'var(--acme-color-gray-900)',
      valuesByTheme: { light: 'var(--acme-color-gray-900)', dark: 'var(--acme-color-gray-0)' },
      category: 'color',
      references: ['color.gray.900'],
      description: 'Default body text color.',
    },
    {
      name: 'color.text.muted',
      cssVar: '--acme-color-text-muted',
      value: '#5b6b7a',
      valuesByTheme: { light: '#5b6b7a', dark: '#98a5b1' },
      category: 'color',
      references: ['color.gray.900'],
      description: 'Muted, secondary text color.',
    },
    {
      name: 'color.surface.default',
      cssVar: '--acme-color-surface-default',
      value: 'var(--acme-color-gray-0)',
      valuesByTheme: { light: 'var(--acme-color-gray-0)', dark: '#15181d' },
      category: 'color',
      references: ['color.gray.0'],
      description: 'Default surface background.',
    },
  ];
  return {
    system: id,
    generatedAt: '2026-08-25T00:00:00.000Z',
    source: { root: '/virtual/acme', files: ['tokens.css'], adapter: 'css-vars' },
    tokens,
    cssVars: tokens.map((t) => t.cssVar).filter((v): v is string => Boolean(v)),
    themes: ['light', 'dark'],
  };
}

function buildAliases(model: 'react' | 'custom-elements'): AliasMap {
  const surfaceName = model === 'custom-elements' ? 'acme-surface' : 'Surface';
  const componentsLexicon: AliasEntry[] = [
    { alias: 'Card', concept: 'surface container', occurrences: 25, source: 'lexicon' },
    { alias: 'Typography', concept: 'text display', occurrences: 29, source: 'lexicon' },
  ];
  const componentsTeam: AliasEntry[] = [
    { alias: 'Card', concept: 'surface container', target: surfaceName, note: `This system calls a card a ${surfaceName}.`, source: 'team' },
    { alias: 'Panel', target: surfaceName, source: 'team' },
  ];
  const propsLexicon: AliasEntry[] = [
    { alias: 'spacing', concept: 'stack gap', occurrences: 85, source: 'lexicon' },
    { alias: 'variant', concept: 'semantic emphasis', occurrences: 32, source: 'lexicon' },
    { alias: 'kind', concept: 'semantic emphasis', occurrences: 12, source: 'lexicon' },
  ];
  const propsTeam: AliasEntry[] = [
    { alias: 'spacing', target: 'gap', note: 'Stack uses gap, not spacing.', source: 'team' },
    { alias: 'kind', target: 'tone', note: 'Button/Badge use tone, not kind.', source: 'team' },
  ];
  return {
    components: [...componentsLexicon, ...componentsTeam],
    props: [...propsLexicon, ...propsTeam],
  };
}

function buildDocs(id: string, model: 'react' | 'custom-elements'): DocsIndex {
  const buttonName = model === 'custom-elements' ? 'acme-button' : 'Button';
  const surfaceName = model === 'custom-elements' ? 'acme-surface' : 'Surface';
  return {
    system: id,
    generatedAt: '2026-08-25T00:00:00.000Z',
    chunks: [
      {
        path: 'docs/button.md',
        heading: 'Accessibility',
        trail: ['Button', 'Accessibility'],
        text: 'Icon-only buttons must always carry an accessible name via aria-label.',
        mentions: [buttonName],
      },
      {
        path: 'docs/surface.md',
        heading: 'When to use',
        trail: ['Surface', 'When to use'],
        text: 'Use a Surface to group related content on a card-like background.',
        mentions: [surfaceName],
      },
    ],
  };
}

function buildPatterns(model: 'react' | 'custom-elements'): Pattern[] {
  const textInputName = model === 'custom-elements' ? 'acme-text-input' : 'TextInput';
  const stackName = model === 'custom-elements' ? 'acme-stack' : 'Stack';
  const buttonName = model === 'custom-elements' ? 'acme-button' : 'Button';
  const language = model === 'custom-elements' ? 'html' : 'tsx';

  return [
    {
      id: 'labeled-field',
      title: 'Labeled field with error',
      description: 'A text input with a required marker, ready to carry a validation error.',
      code: `<${textInputName} placeholder="you@example.com" required />`,
      language,
      components: [textInputName],
      tags: ['form', 'validation'],
    },
    {
      id: 'confirm-actions',
      title: 'Confirm dialog actions',
      description: 'A primary and secondary action laid out side by side.',
      code: `<${stackName} direction="row" gap="sm">\n  <${buttonName} tone="brand">Confirm</${buttonName}>\n  <${buttonName}>Cancel</${buttonName}>\n</${stackName}>`,
      language,
      components: [stackName, buttonName],
      tags: ['dialog', 'actions'],
    },
  ];
}

/** Builds a small synthetic system for tests. */
export function makeSystemData(overrides: MakeSystemDataOptions = {}): SystemData {
  const model = overrides.model ?? 'react';
  const id = overrides.id ?? 'acme';
  const componentsPkg = model === 'custom-elements' ? '@acme/elements' : '@acme/react';

  const cfg: SystemConfig = {
    name: 'Acme Elements',
    description: 'Fictional example system used in tests.',
    componentModel: model,
    componentsPkg,
    catalog: model === 'custom-elements'
      ? { adapter: 'custom-elements-manifest', path: 'custom-elements.json' }
      : { adapter: 'catalog-json', path: 'catalog.json' },
    tokens: { adapter: 'css-vars', files: ['tokens.css'] },
    ...overrides.cfg,
  };

  const base: SystemData = {
    id,
    cfg,
    dataDir: `/virtual/${id}`,
    catalog: buildCatalog(id, model),
    tokens: buildTokens(id),
    docs: buildDocs(id, model),
    patterns: buildPatterns(model),
    aliases: buildAliases(model),
  };

  const { model: _model, ...rest } = overrides;
  return { ...base, ...rest };
}

/** Builds a registry from one or more synthetic systems. */
export function makeRegistry(...systems: SystemData[]): SystemRegistry {
  const map = new Map(systems.map((s) => [s.id, s]));
  return {
    systems: map,
    get(id?: string) {
      if (id !== undefined) {
        const found = map.get(id);
        if (!found) {
          throw new Error(`Unknown system '${id}'. Configured systems: ${[...map.keys()].join(', ') || '(none)'}.`);
        }
        return found;
      }
      if (map.size === 1) {
        return [...map.values()][0]!;
      }
      throw new Error(`No system specified and ${map.size} systems are configured. Pass one of: ${[...map.keys()].join(', ')}.`);
    },
    ids() {
      return [...map.keys()];
    },
  };
}
