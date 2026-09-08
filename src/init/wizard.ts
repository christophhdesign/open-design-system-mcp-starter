// The `init` wizard: turns a checkout path (or an installed package) into a ds.config.json entry.
// Non-interactive when the caller already supplies a systemId plus a root or a package and no
// `ask`; otherwise asks questions (via an injected `ask`, for tests, or node:readline on
// stdin/stdout), defaulting every answer from `detectSystem`, or from `detectPackage` when
// `answers.package` is set (package mode: the system is only ever `npm install`ed, never checked
// out; see README's "Systems consumed from npm"). Either way it writes (or merges into) the
// config file and re-loads it through `loadDsConfig` so a bad answer fails loudly instead of
// shipping a config nothing can read.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline';
import { loadDsConfig } from '../config.ts';
import type { CatalogSource, DsConfig, SystemConfig, TokensSource } from '../types.ts';
import { detectPackage, detectSystem, type Detection } from './detect.ts';

export interface InitAnswers {
  systemId: string;
  root: string;
  name?: string;
  componentModel?: 'react' | 'custom-elements';
  componentsPkg?: string;
  catalog?: CatalogSource;
  tokens?: TokensSource;
  docs?: { include: string[] };
  rootEnv?: string;
  /**
   * Package mode: a system that is only ever `npm install`ed, e.g. "@acme/elements". When
   * present, the wizard detects from `node_modules/<package>` under `root` (default the current
   * directory) instead of scanning a checkout, and `root` is stored as "." -- the config dir is
   * the app folder that has the package installed.
   */
  package?: string;
  /** Package mode: the tokens/foundations package, e.g. "@acme/foundations". Detected from a peerDependency of `package` when omitted. */
  foundationsPackage?: string;
}

export type Ask = (question: string, defaultValue: string) => Promise<string>;

export interface RunInitOptions {
  configPath: string;
  answers?: Partial<InitAnswers>;
  ask?: Ask;
  log?: (line: string) => void;
}

export interface RunInitResult {
  systemId: string;
  config: DsConfig;
  configPath: string;
}

// ---------------------------------------------------------------------------
// Shared defaults: the same function backs both the non-interactive fill-in and the interactive
// prompts' default values, so the two paths can never quietly diverge.
// ---------------------------------------------------------------------------

function defaultCatalog(detection: Detection): CatalogSource | undefined {
  if (detection.componentModel === 'custom-elements' && detection.manifests[0]) {
    return { adapter: 'custom-elements-manifest', path: detection.manifests[0] };
  }
  if (detection.componentModel === 'react' && detection.reactSrc[0]) {
    const dir = detection.reactSrc[0].dir;
    const barrel = detection.barrels.find((b) => b.startsWith(`${dir}/`));
    return { adapter: 'react-docgen', src: dir, barrel };
  }
  // Fall back to whichever signal exists even when it disagrees with componentModel (e.g. a
  // caller-overridden componentModel with no matching source detected).
  if (detection.manifests[0]) return { adapter: 'custom-elements-manifest', path: detection.manifests[0] };
  if (detection.reactSrc[0]) {
    const dir = detection.reactSrc[0].dir;
    const barrel = detection.barrels.find((b) => b.startsWith(`${dir}/`));
    return { adapter: 'react-docgen', src: dir, barrel };
  }
  return undefined;
}

function defaultTokens(detection: Detection): TokensSource | undefined {
  if (detection.cssTokenFiles.length > 0) {
    return { adapter: 'css-vars', files: detection.cssTokenFiles.map((f) => f.path) };
  }
  if (detection.dtcgFiles.length > 0) {
    return { adapter: 'dtcg', files: detection.dtcgFiles };
  }
  return undefined;
}

function defaultDocs(detection: Detection): { include: string[] } | undefined {
  return detection.docsGlobs.length > 0 ? { include: detection.docsGlobs } : undefined;
}

function defaultRootEnv(systemId: string): string {
  const snake = systemId.replace(/[^a-zA-Z0-9]+/g, '_').toUpperCase();
  return `${snake}_DIR`;
}

function splitList(answer: string): string[] {
  return answer
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function resolveRootAbs(rootAnswer: string): string {
  return isAbsolute(rootAnswer) ? rootAnswer : resolve(process.cwd(), rootAnswer);
}

// ---------------------------------------------------------------------------
// Non-interactive: fill every missing field straight from detection.
// ---------------------------------------------------------------------------

async function resolveNonInteractive(answers: Partial<InitAnswers>, log: (line: string) => void): Promise<InitAnswers> {
  return answers.package ? resolveNonInteractivePackage(answers, log) : resolveNonInteractiveCheckout(answers);
}

async function resolveNonInteractiveCheckout(answers: Partial<InitAnswers>): Promise<InitAnswers> {
  const systemId = answers.systemId!;
  const rootAbs = resolveRootAbs(answers.root!);
  const detection = detectSystem(rootAbs);

  const catalog = answers.catalog ?? defaultCatalog(detection);
  if (!catalog) {
    throw new Error(
      `Could not detect a catalog adapter under ${rootAbs}. Pass answers.catalog explicitly, ` +
        `e.g. { adapter: 'custom-elements-manifest', path: 'custom-elements.json' } or ` +
        `{ adapter: 'react-docgen', src: 'src' }.`
    );
  }

  return {
    systemId,
    root: rootAbs,
    name: answers.name ?? detection.packageName,
    componentModel: answers.componentModel ?? detection.componentModel,
    componentsPkg: answers.componentsPkg ?? detection.packageName,
    catalog,
    tokens: answers.tokens ?? defaultTokens(detection),
    docs: answers.docs ?? defaultDocs(detection),
    rootEnv: answers.rootEnv ?? defaultRootEnv(systemId),
  };
}

// ---------------------------------------------------------------------------
// Package mode: root is the app folder that has `package` installed (default the current
// directory), and stored as "." in the written config. Detection reads
// node_modules/<package>/package.json instead of scanning a checkout.
// ---------------------------------------------------------------------------

function reactTypesHint(log: (line: string) => void, hasReactTypes: boolean): void {
  if (hasReactTypes) return;
  log('Next: npm install -D @types/react @types/react-dom (react-docgen needs @types/react to resolve the package\'s .d.ts barrel).');
}

async function resolveNonInteractivePackage(answers: Partial<InitAnswers>, log: (line: string) => void): Promise<InitAnswers> {
  const systemId = answers.systemId!;
  const pkg = answers.package!;
  const appDirAbs = resolveRootAbs(answers.root ?? '.');

  const probe = detectPackage(appDirAbs, pkg);
  const foundationsPackage = answers.foundationsPackage ?? probe.peerFoundations;
  const detection = foundationsPackage ? detectPackage(appDirAbs, pkg, foundationsPackage) : probe;
  reactTypesHint(log, detection.hasReactTypes);

  if (!answers.catalog && !detection.src) {
    throw new Error(
      `Could not detect a types barrel for ${pkg} under ${detection.pkgDir}. Pass answers.catalog explicitly, ` +
        `e.g. { adapter: 'react-docgen', src: 'node_modules/${pkg}/dist' }.`
    );
  }

  return {
    systemId,
    root: appDirAbs,
    name: answers.name ?? pkg,
    componentModel: 'react',
    componentsPkg: pkg,
    package: pkg,
    foundationsPackage,
    catalog: answers.catalog ?? { adapter: 'react-docgen', src: detection.src!, barrel: detection.barrel },
    tokens: answers.tokens ?? (detection.cssFiles.length > 0 ? { adapter: 'css-vars', files: detection.cssFiles } : undefined),
    docs: answers.docs ?? (detection.readmes.length > 0 ? { include: detection.readmes } : undefined),
    rootEnv: answers.rootEnv ?? defaultRootEnv(systemId),
  };
}

// ---------------------------------------------------------------------------
// Interactive: ask in order, every default coming from the same detection helpers above so that
// an `ask` which always echoes back its default reproduces the non-interactive result exactly.
// ---------------------------------------------------------------------------

async function resolveInteractive(prefilled: Partial<InitAnswers>, ask: Ask, log: (line: string) => void): Promise<InitAnswers> {
  return prefilled.package ? resolveInteractivePackage(prefilled, ask, log) : resolveInteractiveCheckout(prefilled, ask);
}

async function resolveInteractiveCheckout(prefilled: Partial<InitAnswers>, ask: Ask): Promise<InitAnswers> {
  const systemId = prefilled.systemId ?? (await ask('System id', 'my-system'));

  const rootAnswer = prefilled.root ?? (await ask('Checkout root (path to your design system)', '.'));
  const rootAbs = resolveRootAbs(rootAnswer);
  const detection = detectSystem(rootAbs);

  const nameDefault = detection.packageName ?? '';
  const nameAnswer = prefilled.name ?? (await ask('Human name shown to agents', nameDefault));
  const name = nameAnswer || undefined;

  const componentModelDefault = detection.componentModel;
  const componentModelAnswer =
    prefilled.componentModel ?? (await ask('Component model (react | custom-elements)', componentModelDefault));
  const componentModel: 'react' | 'custom-elements' = componentModelAnswer === 'custom-elements' ? 'custom-elements' : 'react';

  let catalog: CatalogSource | undefined = prefilled.catalog;
  if (!catalog) {
    const detected = defaultCatalog(detection);
    const adapterDefault = detected?.adapter ?? (componentModel === 'custom-elements' ? 'custom-elements-manifest' : 'react-docgen');
    const adapterAnswer = (
      await ask('Catalog adapter (custom-elements-manifest | react-docgen | catalog-json)', adapterDefault)
    ).trim();

    if (adapterAnswer === 'custom-elements-manifest') {
      const pathDefault = detection.manifests[0] ?? 'custom-elements.json';
      const hint = detection.manifests.length ? ` (found: ${detection.manifests.join(', ')})` : '';
      const path = await ask(`Manifest path, relative to root${hint}`, pathDefault);
      catalog = { adapter: 'custom-elements-manifest', path };
    } else if (adapterAnswer === 'react-docgen') {
      const srcDefault = detection.reactSrc[0]?.dir ?? 'src';
      const srcHint = detection.reactSrc.length
        ? ` (found: ${detection.reactSrc.map((c) => `${c.dir} [${c.tsxCount} tsx]`).join(', ')})`
        : '';
      const src = await ask(`React source dir, relative to root${srcHint}`, srcDefault);
      const barrelDefault = detection.barrels.find((b) => b.startsWith(`${src}/`)) ?? 'none';
      const barrelHint = detection.barrels.length ? ` (found: ${detection.barrels.join(', ')})` : '';
      const barrelAnswer = await ask(`Barrel file, relative to root, or "none"${barrelHint}`, barrelDefault);
      catalog = { adapter: 'react-docgen', src, barrel: barrelAnswer && barrelAnswer !== 'none' ? barrelAnswer : undefined };
    } else {
      const path = await ask('Catalog JSON path, relative to root', 'catalog.json');
      catalog = { adapter: 'catalog-json', path };
    }
  }

  let tokens: TokensSource | undefined = prefilled.tokens;
  if (tokens === undefined) {
    const detected = defaultTokens(detection);
    const adapterDefault = detected?.adapter ?? 'none';
    const adapterAnswer = (await ask('Tokens adapter (css-vars | dtcg | none)', adapterDefault)).trim();

    if (adapterAnswer === 'css-vars') {
      const filesDefault =
        detected?.adapter === 'css-vars' ? detected.files.join(',') : detection.cssTokenFiles.map((f) => f.path).join(',') || 'tokens.css';
      const hint = detection.cssTokenFiles.length
        ? ` (found: ${detection.cssTokenFiles.map((f) => `${f.path} [${f.count}]`).join(', ')})`
        : '';
      const filesAnswer = await ask(`CSS token files, comma-separated, relative to root${hint}`, filesDefault);
      tokens = { adapter: 'css-vars', files: splitList(filesAnswer) };
    } else if (adapterAnswer === 'dtcg') {
      const filesDefault = detected?.adapter === 'dtcg' ? detected.files.join(',') : detection.dtcgFiles.join(',') || 'tokens.json';
      const hint = detection.dtcgFiles.length ? ` (found: ${detection.dtcgFiles.join(', ')})` : '';
      const filesAnswer = await ask(`DTCG token files, comma-separated, relative to root${hint}`, filesDefault);
      tokens = { adapter: 'dtcg', files: splitList(filesAnswer) };
    } else {
      tokens = undefined;
    }
  }

  let docs = prefilled.docs;
  if (docs === undefined) {
    const detected = defaultDocs(detection);
    const answerDefault = detected ? detected.include.join(',') : 'none';
    const hint = detection.docsGlobs.length ? ` (found: ${detection.docsGlobs.join(', ')})` : '';
    const answer = await ask(`Docs globs, comma-separated, relative to root, or "none"${hint}`, answerDefault);
    docs = answer === 'none' || !answer ? undefined : { include: splitList(answer) };
  }

  let componentsPkg = prefilled.componentsPkg;
  if (componentsPkg === undefined) {
    const pkgDefault = detection.packageName ?? '';
    const answer = await ask('Components package specifier (what consumers import or register)', pkgDefault);
    componentsPkg = answer || undefined;
  }

  return {
    systemId,
    root: rootAbs,
    name,
    componentModel,
    componentsPkg,
    catalog,
    tokens,
    docs,
    rootEnv: prefilled.rootEnv ?? defaultRootEnv(systemId),
  };
}

async function resolveInteractivePackage(prefilled: Partial<InitAnswers>, ask: Ask, log: (line: string) => void): Promise<InitAnswers> {
  const systemId = prefilled.systemId ?? (await ask('System id', 'my-system'));
  const pkg = prefilled.package!;

  const rootAnswer = prefilled.root ?? (await ask('App folder with the package installed (has node_modules)', '.'));
  const appDirAbs = resolveRootAbs(rootAnswer);

  // Probe without a foundations package first, purely to surface a peerDependency-based default
  // for the next question; re-detect below once the foundations package (if any) is settled.
  const probe = detectPackage(appDirAbs, pkg);

  const foundationsDefault = prefilled.foundationsPackage ?? probe.peerFoundations ?? '';
  const foundationsAnswer =
    prefilled.foundationsPackage ?? (await ask('Foundations/tokens package, or blank for none', foundationsDefault));
  const foundationsPackage = foundationsAnswer || undefined;

  const detection = foundationsPackage ? detectPackage(appDirAbs, pkg, foundationsPackage) : probe;
  reactTypesHint(log, detection.hasReactTypes);

  const nameAnswer = prefilled.name ?? (await ask('Human name shown to agents', pkg));
  const name = nameAnswer || undefined;

  let catalog: CatalogSource | undefined = prefilled.catalog;
  if (!catalog) {
    if (!detection.src) {
      throw new Error(
        `Could not detect a types barrel for ${pkg} under ${detection.pkgDir}. Pass answers.catalog explicitly, ` +
          `e.g. { adapter: 'react-docgen', src: 'node_modules/${pkg}/dist' }.`
      );
    }
    const src = await ask('React source dir (compiled .d.ts), relative to the app folder', detection.src);
    const barrelDefault = detection.barrel ?? 'none';
    const barrelAnswer = await ask('Barrel .d.ts file, relative to the app folder, or "none"', barrelDefault);
    catalog = { adapter: 'react-docgen', src, barrel: barrelAnswer && barrelAnswer !== 'none' ? barrelAnswer : undefined };
  }

  let tokens: TokensSource | undefined = prefilled.tokens;
  if (tokens === undefined) {
    const adapterDefault = detection.cssFiles.length > 0 ? 'css-vars' : 'none';
    const adapterAnswer = (await ask('Tokens adapter (css-vars | none)', adapterDefault)).trim();
    if (adapterAnswer === 'css-vars') {
      const filesDefault = detection.cssFiles.join(',') || 'tokens.css';
      const filesAnswer = await ask('CSS token files, comma-separated, relative to the app folder', filesDefault);
      tokens = { adapter: 'css-vars', files: splitList(filesAnswer) };
    } else {
      tokens = undefined;
    }
  }

  let docs = prefilled.docs;
  if (docs === undefined) {
    const answerDefault = detection.readmes.length > 0 ? detection.readmes.join(',') : 'none';
    const answer = await ask('Docs files, comma-separated, relative to the app folder, or "none"', answerDefault);
    docs = answer === 'none' || !answer ? undefined : { include: splitList(answer) };
  }

  return {
    systemId,
    root: appDirAbs,
    name,
    componentModel: 'react',
    componentsPkg: pkg,
    package: pkg,
    foundationsPackage,
    catalog,
    tokens,
    docs,
    rootEnv: prefilled.rootEnv ?? defaultRootEnv(systemId),
  };
}

function createReadlineAsk(): { ask: Ask; close: () => void } {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask: Ask = (question, defaultValue) =>
    new Promise((res) => {
      const suffix = defaultValue ? ` (${defaultValue})` : '';
      rl.question(`${question}${suffix}: `, (answer) => res(answer.trim() || defaultValue));
    });
  return { ask, close: () => rl.close() };
}

// ---------------------------------------------------------------------------
// Config write / merge
// ---------------------------------------------------------------------------

function storedRoot(rootAbs: string, configDir: string): string {
  const rel = relative(configDir, rootAbs);
  if (rel === '') return '.';
  if (!rel.startsWith('..') && !isAbsolute(rel)) return rel.split(sep).join('/');
  return rootAbs;
}

function buildSystemConfig(answers: InitAnswers, configDir: string): SystemConfig {
  return {
    ...(answers.name ? { name: answers.name } : {}),
    // Package mode: root is defined as the app folder that has the config alongside it, so it is
    // always stored as "." rather than computed relative to configDir.
    root: answers.package ? '.' : storedRoot(answers.root, configDir),
    ...(answers.rootEnv ? { rootEnv: answers.rootEnv } : {}),
    ...(answers.componentModel ? { componentModel: answers.componentModel } : {}),
    ...(answers.componentsPkg ? { componentsPkg: answers.componentsPkg } : {}),
    ...(answers.foundationsPackage ? { foundationsPkg: answers.foundationsPackage } : {}),
    catalog: answers.catalog!,
    ...(answers.tokens ? { tokens: answers.tokens } : {}),
    ...(answers.docs && answers.docs.include.length > 0 ? { docs: answers.docs } : {}),
  };
}

function mergeAndWrite(configPath: string, systemId: string, systemConfig: SystemConfig): void {
  let existing: { $schema?: unknown; systems?: Record<string, SystemConfig> } = { systems: {} };
  if (existsSync(configPath)) {
    let raw: string;
    try {
      raw = readFileSync(configPath, 'utf8');
    } catch (err) {
      throw new Error(`Could not read existing config at ${configPath}: ${(err as Error).message}`);
    }
    try {
      existing = JSON.parse(raw) as typeof existing;
    } catch (err) {
      throw new Error(`Existing config at ${configPath} is not valid JSON: ${(err as Error).message}`);
    }
  }

  const out: Record<string, unknown> = {};
  if (typeof existing.$schema === 'string') out.$schema = existing.$schema;
  out.systems = { ...(existing.systems ?? {}), [systemId]: systemConfig };

  writeFileSync(configPath, `${JSON.stringify(out, null, 2)}\n`, 'utf8');
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function runInit(opts: RunInitOptions): Promise<RunInitResult> {
  const log = opts.log ?? (() => {});
  const answers = opts.answers ?? {};

  const nonInteractive = Boolean(answers.systemId && (answers.package || answers.root) && !opts.ask);

  let resolvedAsk = opts.ask;
  let closeReadline: (() => void) | undefined;
  if (!nonInteractive && !resolvedAsk) {
    const rl = createReadlineAsk();
    resolvedAsk = rl.ask;
    closeReadline = rl.close;
  }

  let finalAnswers: InitAnswers;
  try {
    finalAnswers = nonInteractive ? await resolveNonInteractive(answers, log) : await resolveInteractive(answers, resolvedAsk!, log);
  } finally {
    closeReadline?.();
  }

  const configPath = resolve(process.cwd(), opts.configPath);
  const configDir = dirname(configPath);

  const systemConfig = buildSystemConfig(finalAnswers, configDir);
  mergeAndWrite(configPath, finalAnswers.systemId, systemConfig);

  const loaded = loadDsConfig(configPath);

  log(`Wrote ${finalAnswers.systemId} to ${configPath}`);
  const configFlag =
    basename(configPath) === 'ds.config.json' && dirname(resolve(configPath)) === process.cwd() ? '' : ` --config ${configPath}`;
  log('Next steps:');
  log(`  npx tsx src/cli.ts extract${configFlag} --system ${finalAnswers.systemId}`);
  log(`  npx tsx src/cli.ts doctor${configFlag}`);
  log(`  npx tsx src/cli.ts serve${configFlag}`);

  return { systemId: finalAnswers.systemId, config: loaded.config, configPath: loaded.configPath };
}
