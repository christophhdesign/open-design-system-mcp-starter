// Every shared contract in the starter. Nothing here names a real design
// system: ids, package names and component names all arrive from ds.config.json.
//
// The catalog and token shapes are a superset of open-design-system-bench's
// SystemCatalog / SystemTokens, so a catalog.json the bench extracted loads
// here unchanged (via the 'catalog-json' adapter). Keep that true.

export type SystemId = string;

// ---------------------------------------------------------------------------
// Config: ds.config.json
// ---------------------------------------------------------------------------

export interface DsConfig {
  systems: Record<SystemId, SystemConfig>;
}

/**
 * One system = one consumable kit. A design system with a React kit and a
 * web-component kit declares two systems; every tool takes a `system`
 * argument (optional when only one is configured).
 */
export interface SystemConfig {
  /** Human name shown to agents, e.g. "Acme Elements". Defaults to the id. */
  name?: string;
  description?: string;
  /** Checkout root the adapters read from. Relative paths resolve against the config file's directory. */
  root?: string;
  /** Env var that overrides `root` (a CI checkout, a teammate's path). */
  rootEnv?: string;
  /** Where generated ground truth lives. Default: data/<id>. Committed on purpose. */
  dataDir?: string;
  /** 'react' (default): components are imported by name. 'custom-elements': registered once, written as dashed tags. */
  componentModel?: 'react' | 'custom-elements';
  /** The specifier consumers import (react) or register (custom-elements), e.g. "@acme/react". */
  componentsPkg?: string;
  /** Tokens/foundations package, if separate. */
  foundationsPkg?: string;
  catalog: CatalogSource;
  tokens?: TokensSource;
  /** Markdown docs to index, globs relative to root. */
  docs?: { include: string[]; exclude?: string[] };
  /** Team-maintained alias file, relative to the config dir. Default: <dataDir>/aliases.json if present. */
  aliases?: string;
  /**
   * Figma Code Connect files (`*.figma.tsx`) to enrich the catalog with: a team-written example,
   * the Figma node link, and design-side aliases from enum maps. Globs relative to `root`, or to
   * `codeConnect.root` when the mappings live in another checkout (a storybook repo) than the
   * system consumed here.
   */
  codeConnect?: { include: string[]; root?: string };
}

/** Where the catalog comes from. Adapters are the only place format knowledge lives. */
export type CatalogSource =
  /** An already-built catalog in this repo's SystemCatalog shape (or the bench's). Path relative to root. */
  | { adapter: 'catalog-json'; path: string }
  /** A custom-elements.json (Custom Elements Manifest, schema 1.x or 2.x). Path relative to root. */
  | { adapter: 'custom-elements-manifest'; path: string }
  /** Reserved for react-docgen-typescript extraction from a source tree. Not implemented in P0: the adapter returns a clear error. */
  | { adapter: 'react-docgen'; src: string; barrel?: string };

export type TokensSource =
  /** CSS files declaring custom properties, e.g. compiled tokens.css. Paths relative to root. */
  | { adapter: 'css-vars'; files: string[] }
  /** Design Tokens Community Group JSON (DTCG) files. Paths relative to root. */
  | { adapter: 'dtcg'; files: string[] };

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

export interface CatalogProp {
  name: string;
  type: string;
  required: boolean;
  defaultValue?: string;
  description?: string;
  /** Present when the prop is deprecated; the string is the replacement or note. */
  deprecated?: string;
}

export interface CatalogEvent {
  name: string;
  type?: string;
  description?: string;
}

export interface CatalogSlot {
  /** '' is the default slot. */
  name: string;
  description?: string;
}

export interface CatalogExample {
  title?: string;
  code: string;
  /** 'tsx' | 'html' | ... defaults to tsx for react, html for custom elements. */
  language?: string;
  /** Where it came from (story id, doc path). */
  source?: string;
}

export interface CatalogExport {
  /** Public symbol (react: PascalCase export; custom-elements: the dashed tag name). */
  displayName: string;
  /** Custom elements only: the tag, when displayName is a class name. */
  tagName?: string;
  description: string;
  props: CatalogProp[];
  /** Names only, of props declared outside the system's own source (DOM attrs, style-system spreads). */
  inheritedProps?: string[];
  events?: CatalogEvent[];
  slots?: CatalogSlot[];
  examples?: CatalogExample[];
  a11y?: {
    /** Does this component need an accessible name from the consumer? */
    accessibleName?: 'required' | 'recommended' | 'none';
    notes?: string[];
  };
  guidance?: { do?: string[]; dont?: string[]; notes?: string[] };
  deprecated?: { since?: string; replacement?: string; note?: string };
  /** Markdown docs that mention this export, relative to root. */
  docs?: string[];
  /** Figma component this export is connected to (from Code Connect). */
  figma?: { nodeId: string; url: string; source?: string };
  /**
   * Where the props table came from: the docgen parser, a `<Name>Props` type resolved by the
   * adapter's fallback, a hand-written overlay, or a Code Connect stub. Absent means docgen.
   */
  docSource?: 'docgen' | 'props-type' | 'overlay' | 'code-connect';
}

export interface SystemCatalog {
  system: SystemId;
  generatedAt: string;
  source: {
    root: string;
    commit?: string;
    /** Hash of what the adapter read, compared by the freshness check. */
    srcHash?: string;
    /** A hash stamped by an upstream tool (catalog-json input), kept for provenance only. */
    upstreamSrcHash?: string;
    adapter?: string;
    /** Set at load time when data/<id>/overlay.json was merged over the extracted catalog. */
    overlay?: { path: string; hash: string; exports: number };
    /** Set at extract time when Code Connect files enriched the catalog. */
    codeConnect?: { files: number; mapped: number; hash: string };
  };
  components: Array<{ dir: string; exports: CatalogExport[] }>;
  /** Flat symbol list. This is the hallucination check set: a name not here does not exist. */
  allExports: string[];
  /**
   * Names in allExports that are types only (interfaces, type aliases), never values. They are
   * legitimate to import but can never be components, so they are excluded from "undocumented
   * component" reports. Filled by adapters that can tell (react-docgen via the checker).
   */
  typeOnlyExports?: string[];
  /** Gradeable prop names per export, including attribute aliases (kebab and camel spellings for custom elements). */
  allPropsByExport: Record<string, string[]>;
}

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

export type TokenCategory = 'color' | 'space' | 'size' | 'typography' | 'radius' | 'shadow' | 'motion' | 'border' | 'opacity' | 'z-index' | 'other';

export interface Token {
  /** Canonical name: the CSS var ('--color-text-muted') or the DTCG path ('color.text.muted'). */
  name: string;
  /** The CSS custom property to write, when one exists. */
  cssVar?: string;
  /** Resolved value in the default theme, as written. */
  value?: string;
  /** Per-theme values when the source declares them (e.g. { light: '#111', dark: '#eee' }). */
  valuesByTheme?: Record<string, string>;
  category: TokenCategory;
  /** Other tokens this one references (semantic layer), by canonical name. */
  references?: string[];
  description?: string;
}

export interface SystemTokens {
  system: SystemId;
  generatedAt: string;
  source: { root: string; files: string[]; adapter?: string; hash?: string };
  tokens: Token[];
  /** Kept for bench compatibility: every CSS var name. */
  cssVars: string[];
  themes?: string[];
}

// ---------------------------------------------------------------------------
// Aliases: what agents call things vs what this system calls them
// ---------------------------------------------------------------------------

export interface AliasEntry {
  /** The name an agent is likely to write ('Card', 'spacing'). */
  alias: string;
  /** The concept in plain words ('surface container', 'stack gap'). */
  concept?: string;
  /** The name THIS system uses, when the team has mapped it. Absent in the ecosystem lexicon. */
  target?: string;
  note?: string;
  /** How often models invented this exact name in the mined evidence (lexicon entries only). */
  occurrences?: number;
  /** 'code-connect' entries come from Figma enum maps; the team file wins over them, they win over the lexicon. */
  source: 'lexicon' | 'team' | 'code-connect';
}

export interface AliasMap {
  components: AliasEntry[];
  props: AliasEntry[];
}

// ---------------------------------------------------------------------------
// Docs index
// ---------------------------------------------------------------------------

export interface DocChunk {
  /** Path relative to root. */
  path: string;
  heading: string;
  /** Heading trail, e.g. ['Button', 'Accessibility']. */
  trail: string[];
  text: string;
  /** Catalog export names this chunk mentions. */
  mentions: string[];
}

export interface DocsIndex {
  system: SystemId;
  generatedAt: string;
  /** Hash of the matched markdown files at extract time, for freshness checks. */
  sourceHash?: string;
  chunks: DocChunk[];
}

// ---------------------------------------------------------------------------
// Tool results (structuredContent shapes)
// ---------------------------------------------------------------------------

export interface ComponentSummary {
  name: string;
  tagName?: string;
  description: string;
  /** For react: `import { X } from '<componentsPkg>'`; for custom elements: `<x-tag>` after registering componentsPkg. */
  usage: string;
  deprecated?: CatalogExport['deprecated'];
}

export interface SearchHit extends ComponentSummary {
  score: number;
  /** Why it matched: 'name' | 'alias:<alias>' | 'description' | 'docs' | 'prop:<name>'. */
  matchedOn: string[];
}

export type ResolveResult =
  | { status: 'exact'; system: SystemId; component: ComponentSummary }
  | { status: 'alias'; system: SystemId; alias: string; concept?: string; target: ComponentSummary; note?: string }
  | { status: 'missing'; system: SystemId; query: string; message: string; nearest: SearchHit[]; concept?: string };

export interface TokenHit {
  token: Token;
  score: number;
  matchedOn: string[];
  /** What to write in code: 'var(--x)' or a class name when the system exposes one. */
  write: string;
}

export interface ComponentDetail extends ComponentSummary {
  props: CatalogProp[];
  inheritedProps?: string[];
  events?: CatalogEvent[];
  slots?: CatalogSlot[];
  examples: CatalogExample[];
  a11y?: CatalogExport['a11y'];
  guidance?: CatalogExport['guidance'];
  docs?: string[];
  /** Props that a team-alias or lexicon says agents commonly get wrong on this component, with the right spelling. */
  commonMistakes?: Array<{ wrote: string; use: string; note?: string }>;
}

// ---------------------------------------------------------------------------
// Runtime: what the server holds in memory per system
// ---------------------------------------------------------------------------

/** Everything the tools need for one system, loaded once from its data dir. */
export interface SystemData {
  id: SystemId;
  cfg: SystemConfig;
  /** Absolute checkout root after rootEnv override, or undefined when the config has none. */
  root?: string;
  /** Absolute data dir the files were read from. */
  dataDir: string;
  catalog: SystemCatalog;
  tokens?: SystemTokens;
  docs?: DocsIndex;
  /** Authored recipes from data/<id>/patterns, when present. */
  patterns?: Pattern[];
  /** Lexicon merged with the team file; team entries win on the same alias. */
  aliases: AliasMap;
}

/** All configured systems, loaded. Tools resolve `system` arguments through it. */
export interface SystemRegistry {
  systems: Map<SystemId, SystemData>;
  /** Returns the named system, or the only one when `id` is omitted and exactly one is configured. Throws a clear error otherwise. */
  get(id?: SystemId): SystemData;
  ids(): SystemId[];
}

// ---------------------------------------------------------------------------
// P2: patterns, usage checks
// ---------------------------------------------------------------------------

/** A small, complete, authored recipe composed from real components (data/<id>/patterns/*.md). */
export interface Pattern {
  /** File basename without extension, e.g. 'labeled-field'. */
  id: string;
  title: string;
  description: string;
  code: string;
  /** 'tsx' | 'html' | ... */
  language: string;
  /** Catalog export names the code uses. */
  components: string[];
  /** Free-form tags from the file's front matter, e.g. ['form', 'validation']. */
  tags: string[];
}

export type UsageFindingKind =
  | 'unknown-component'
  | 'invented-prop'
  | 'raw-value'
  | 'missing-accessible-name'
  | 'disallowed-import'
  | 'deprecated'
  /** A string literal passed to a prop whose type is a literal union that does not contain it. */
  | 'invalid-value';

export interface UsageFinding {
  kind: UsageFindingKind;
  /** 'error' blocks; 'warning' needs a look. */
  severity: 'error' | 'warning';
  message: string;
  /** What to write instead, when the data knows. */
  fix?: string;
  line?: number;
  /** Component or import the finding is about. */
  subject?: string;
}

export interface UsageReport {
  system: SystemId;
  language: 'tsx' | 'html';
  findings: UsageFinding[];
  /** Catalog exports the snippet used. Empty means the design system was not used at all. */
  usedComponents: string[];
}

// ---------------------------------------------------------------------------
// P3: catalog overlay
// ---------------------------------------------------------------------------

/**
 * data/<id>/overlay.json: hand-written facts merged over the extracted catalog at load time,
 * for exports the adapter could not document (factory-built or polymorphic components) or to
 * add examples and guidance. Overlay props win over extracted props of the same name.
 */
export interface CatalogOverlay {
  exports: Array<Partial<Omit<CatalogExport, 'displayName'>> & { displayName: string; _note?: string }>;
}
