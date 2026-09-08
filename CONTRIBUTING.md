# Contributing

Thanks for looking. This repository is a template: most people should fork it and point it at
their own design system rather than change the template itself. Changes that belong here are ones
that help every design system, not one.

## Ground rules

- Nothing in `src/` may name a real design system, component, package or company. Everything
  resolves from `ds.config.json`. If you find yourself hardcoding a name, make it a config field.
- Never fabricate. A lookup miss returns "missing" plus the nearest real names; tests guard this.
- A check that cannot measure says so; it never returns a constant that prints as a result.
- Tests are offline: node:test via tsx, the MCP SDK's in-memory transport, synthetic data in
  temp dirs. No network, no model calls.
- ESM TypeScript, strict, explicit `.ts` import extensions, no build step. TypeScript is pinned to
  5.x on purpose (the 7.x native rewrite ships no compiler API and breaks extraction).
- Docs and generated text: sentence-case headings, straight quotes, no em dashes.

## Before you open a pull request

```bash
npm run check
npx tsx src/cli.ts extract && npx tsx src/cli.ts doctor
npx tsx src/cli.ts generate all --system acme-elements --target /tmp/gen-check
```

`extract` must leave `data/` unchanged (it is committed on purpose and must be idempotent).

If your machine's `~/.npmrc` points npm at a company mirror, `npm install` records that mirror in
every `resolved` URL of `package-lock.json`, and `npm ci` fails for everyone outside your network.
Regenerate the lockfile against the public registry before committing it:

```bash
rm -rf node_modules package-lock.json
npm install --registry=https://registry.npmjs.org/
```

CI rejects a lockfile that resolves from anywhere but `registry.npmjs.org`.

## Adding an adapter

Adapters live in `src/adapters/` and are the only format-aware code. Implement
`extractCatalog(id, cfg, root)` or `extractTokens(id, cfg, root)` plus a `sourceHash(cfg, root)`
for freshness, add the union member to `CatalogSource` or `TokensSource` in `src/types.ts` and to
the zod schema in `src/config.ts`, wire it in `src/adapters/index.ts`, and add an offline test on a
small fixture. Document the config shape in README.md.

## Reporting problems

Open an issue with the config entry (redact private paths), the command you ran, and the output of
`npx tsx src/cli.ts doctor`.
