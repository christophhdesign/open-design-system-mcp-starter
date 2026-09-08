# Pairing with a benchmark

Kept in mind, not built. The starter does not depend on this.

open-design-system-mcp-starter has no code dependency on any benchmark project. The pairing
described here is possible only because the contracts happen to line up, not because either
project imports the other.

The catalog and token contracts in `src/types.ts` (`SystemCatalog`, `SystemTokens`) are a
superset of what open-design-system-bench's extractor produces. That means a `catalog.json` or
`tokens.json` the bench already extracted for a system loads here unchanged, through the
`catalog-json` adapter, with no conversion step.

That superset relationship also opens a second direction. The bench reserves an `mcp` context
level (alongside `bare`, `agents-md`, `skill`) that is not yet implemented on the bench side. If
it is built, it could attach this server to a benchmark cell and measure lift with the bench's
existing frozen tasks and graders, the same way it measures lift from an AGENTS.md section or a
skill today. That would give a design system team a concrete before/after number for shipping an
MCP server, not just an opinion that it should help.

None of this is required reading to use the starter on its own. It is here so the two projects
do not accidentally diverge on a shape that would make the pairing harder later.
