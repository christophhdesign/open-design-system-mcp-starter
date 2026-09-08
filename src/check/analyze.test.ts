import assert from 'node:assert/strict';
import { test } from 'node:test';

import { makeSystemData } from '../test-helpers.ts';
import { checkUsage, parseLiteralUnion } from './analyze.ts';

function findingsOf(report: ReturnType<typeof checkUsage>, kind: string) {
  return report.findings.filter((f) => f.kind === kind);
}

// ---------------------------------------------------------------------------
// react model
// ---------------------------------------------------------------------------

test('react: unknown-component for a name imported from componentsPkg but not in the catalog', () => {
  const data = makeSystemData();
  const code = "import { Modal } from '@acme/react';\nconst X = () => <Modal>Hi</Modal>;";
  const report = checkUsage(data, code);
  assert.equal(report.language, 'tsx');
  const hits = findingsOf(report, 'unknown-component');
  assert.equal(hits.length, 1);
  assert.equal(hits[0]!.severity, 'error');
  assert.equal(hits[0]!.message, "Hallucinated component 'Modal' imported from '@acme/react'");
  assert.equal(report.usedComponents.length, 0);
});

test('react: hallucinated named import is flagged even when never used as a JSX element', () => {
  const data = makeSystemData();
  const report = checkUsage(data, "import { Modal } from '@acme/react';\n");
  const hits = findingsOf(report, 'unknown-component');
  assert.equal(hits.length, 1);
  assert.equal(hits[0]!.message, "Hallucinated component 'Modal' imported from '@acme/react'");
});

test('react: default and namespace imports from componentsPkg are unverifiable, no finding', () => {
  const data = makeSystemData();
  const report = checkUsage(data, "import Whatever from '@acme/react';\nimport * as Ns from '@acme/react';\n");
  assert.equal(findingsOf(report, 'unknown-component').length, 0);
});

test('react: an export present in allExports but undocumented (no props table) resolves as real, not hallucinated', () => {
  const data = makeSystemData();
  data.catalog.allExports.push('Card');
  data.catalog.allPropsByExport['Card'] = [];
  const code = "import { Card } from '@acme/react';\nconst X = () => <Card>Hi</Card>;";
  const report = checkUsage(data, code);
  assert.equal(findingsOf(report, 'unknown-component').length, 0);
  assert.deepEqual(report.usedComponents, ['Card']);
});

test('react: a real component resolved through an import is not flagged, and is recorded as used', () => {
  const data = makeSystemData();
  const code = "import { Button } from '@acme/react';\nconst X = () => <Button>Save</Button>;";
  const report = checkUsage(data, code);
  assert.equal(findingsOf(report, 'unknown-component').length, 0);
  assert.deepEqual(report.usedComponents, ['Button']);
});

test('react: aliased import resolves to the real name', () => {
  const data = makeSystemData();
  const code = "import { Button as Btn } from '@acme/react';\nconst X = () => <Btn>Save</Btn>;";
  const report = checkUsage(data, code);
  assert.equal(findingsOf(report, 'unknown-component').length, 0);
  assert.deepEqual(report.usedComponents, ['Button']);
});

test('react: a member expression keeps the base identifier for resolution', () => {
  const data = makeSystemData();
  const code = "import { Surface } from '@acme/react';\nconst X = () => <Surface.Header>Hi</Surface.Header>;";
  const report = checkUsage(data, code);
  assert.equal(findingsOf(report, 'unknown-component').length, 0);
  assert.deepEqual(report.usedComponents, ['Surface']);
});

test('react: a plain native tag is never the system\'s', () => {
  const data = makeSystemData();
  const code = 'const X = () => <div className="foo">Hi</div>;';
  const report = checkUsage(data, code);
  assert.equal(report.findings.filter((f) => f.kind === 'unknown-component').length, 0);
  assert.equal(report.usedComponents.length, 0);
});

test('react: invented prop, with a fix from a team prop alias', () => {
  const data = makeSystemData();
  const code = "import { Button } from '@acme/react';\nconst X = () => <Button kind=\"brand\">Save</Button>;";
  const report = checkUsage(data, code);
  const hits = findingsOf(report, 'invented-prop');
  assert.equal(hits.length, 1);
  assert.equal(hits[0]!.severity, 'warning');
  assert.equal(hits[0]!.message, "Invented prop 'kind' on Button");
  assert.equal(hits[0]!.fix, "use 'tone' instead");
});

test('react: invented prop with a case-insensitive fix when no alias applies', () => {
  const data = makeSystemData();
  const code = "import { Button } from '@acme/react';\nconst X = () => <Button Tone=\"brand\">Save</Button>;";
  const report = checkUsage(data, code);
  const hits = findingsOf(report, 'invented-prop');
  assert.equal(hits.length, 1);
  assert.equal(hits[0]!.fix, "use 'tone' instead");
});

test('react: a spread attribute suppresses invented-prop checks for that element', () => {
  const data = makeSystemData();
  const code = "import { Button } from '@acme/react';\nconst rest = {};\nconst X = () => <Button {...rest} kind=\"brand\">Save</Button>;";
  const report = checkUsage(data, code);
  assert.equal(findingsOf(report, 'invented-prop').length, 0);
});

test('react: a real, non-deprecated prop is silent', () => {
  const data = makeSystemData();
  const code = "import { Button } from '@acme/react';\nconst X = () => <Button tone=\"brand\">Save</Button>;";
  const report = checkUsage(data, code);
  assert.equal(report.findings.length, 0);
});

test('react: raw hex color in className, with an exact-token fix', () => {
  const data = makeSystemData();
  const code = "import { Surface } from '@acme/react';\nconst X = () => <Surface className=\"bg-[#ffffff]\">Hi</Surface>;";
  const report = checkUsage(data, code);
  const hits = findingsOf(report, 'raw-value');
  assert.equal(hits.length, 1);
  assert.equal(hits[0]!.message, "Raw value '#ffffff' in className");
  assert.equal(hits[0]!.fix, 'use var(--acme-color-gray-0)');
});

test('react: raw pixel length inside an inline style object, with an exact-token fix', () => {
  const data = makeSystemData();
  const code = "import { Surface } from '@acme/react';\nconst X = () => <Surface style={{ padding: '16px' }}>Hi</Surface>;";
  const report = checkUsage(data, code);
  const hits = findingsOf(report, 'raw-value');
  assert.equal(hits.length, 1);
  assert.equal(hits[0]!.message, "Raw value '16px' in style.padding");
  assert.equal(hits[0]!.fix, 'use var(--acme-space-4)');
});

test('react: raw value with no token data falls back to a generic fix', () => {
  const data = makeSystemData({ tokens: undefined });
  const code = "import { Surface } from '@acme/react';\nconst X = () => <Surface style={{ color: '#123456' }}>Hi</Surface>;";
  const report = checkUsage(data, code);
  const hits = findingsOf(report, 'raw-value');
  assert.equal(hits.length, 1);
  assert.equal(hits[0]!.fix, 'use a design token');
});

test('react: missing-accessible-name on a component whose a11y is required, absent, or provided', () => {
  const data = makeSystemData();
  const missing = checkUsage(data, "import { TextInput } from '@acme/react';\nconst X = () => <TextInput />;");
  assert.equal(findingsOf(missing, 'missing-accessible-name').length, 1);
  assert.equal(findingsOf(missing, 'missing-accessible-name')[0]!.severity, 'error');

  const withLabel = checkUsage(data, "import { TextInput } from '@acme/react';\nconst X = () => <TextInput aria-label=\"Email\" />;");
  assert.equal(findingsOf(withLabel, 'missing-accessible-name').length, 0);

  const withChildren = checkUsage(data, "import { Button } from '@acme/react';\nconst X = () => <Button>Save</Button>;");
  assert.equal(findingsOf(withChildren, 'missing-accessible-name').length, 0);
});

test('react: deprecated prop yields a warning with the replacement as fix', () => {
  const data = makeSystemData();
  const code = "import { Badge } from '@acme/react';\nconst X = () => <Badge color=\"red\">Status</Badge>;";
  const report = checkUsage(data, code);
  const hits = findingsOf(report, 'deprecated');
  assert.equal(hits.length, 1);
  assert.equal(hits[0]!.fix, 'use tone instead');
  assert.equal(findingsOf(report, 'invented-prop').length, 0);
});

test('react: deprecated export yields a warning even with no invalid props', () => {
  const data = makeSystemData();
  const badge = data.catalog.components.flatMap((c) => c.exports).find((e) => e.displayName === 'Badge')!;
  badge.deprecated = { since: '2.0', replacement: 'Chip', note: 'Renamed for clarity.' };
  const code = "import { Badge } from '@acme/react';\nconst X = () => <Badge tone=\"info\">Status</Badge>;";
  const report = checkUsage(data, code);
  const hits = findingsOf(report, 'deprecated');
  assert.equal(hits.length, 1);
  assert.equal(hits[0]!.fix, 'Chip');
});

test('react: disallowed-import for a non-relative, non-system, non-react specifier', () => {
  const data = makeSystemData();
  const code = "import lodash from 'lodash';\nimport { Button } from '@acme/react';\nconst X = () => <Button>Hi</Button>;";
  const report = checkUsage(data, code);
  const hits = findingsOf(report, 'disallowed-import');
  assert.equal(hits.length, 1);
  assert.equal(hits[0]!.message, "Disallowed import 'lodash'");
});

test('react: relative imports, react, and the system package are all allowed', () => {
  const data = makeSystemData();
  const code = "import './styles.css';\nimport React from 'react';\nimport { Button } from '@acme/react';\nconst X = () => <Button>Hi</Button>;";
  const report = checkUsage(data, code);
  assert.equal(findingsOf(report, 'disallowed-import').length, 0);
});

test('react: extraAllowedImports permits an otherwise-disallowed specifier', () => {
  const data = makeSystemData();
  const code = "import lodash from 'lodash';\nimport { Button } from '@acme/react';\nconst X = () => <Button>Hi</Button>;";
  const report = checkUsage(data, code, { extraAllowedImports: ['lodash'] });
  assert.equal(findingsOf(report, 'disallowed-import').length, 0);
});

// ---------------------------------------------------------------------------
// custom-elements model
// ---------------------------------------------------------------------------

test('custom-elements: a dashed tag resolves directly against allExports', () => {
  const data = makeSystemData({ model: 'custom-elements' });
  const report = checkUsage(data, '<acme-button tone="brand">Save</acme-button>', { language: 'html' });
  assert.equal(findingsOf(report, 'unknown-component').length, 0);
  assert.deepEqual(report.usedComponents, ['acme-button']);
});

test('custom-elements: a dashed tag not in the catalog is unknown-component', () => {
  const data = makeSystemData({ model: 'custom-elements' });
  const report = checkUsage(data, '<acme-modal>Hi</acme-modal>', { language: 'html' });
  const hits = findingsOf(report, 'unknown-component');
  assert.equal(hits.length, 1);
  assert.equal(hits[0]!.message, "Hallucinated component 'acme-modal'");
});

test('custom-elements: a named import from componentsPkg not in allExports is hallucinated, even with no JSX anchoring', () => {
  const data = makeSystemData({ model: 'custom-elements' });
  const report = checkUsage(data, "import { Button } from '@acme/elements';\n");
  const hits = findingsOf(report, 'unknown-component');
  assert.equal(hits.length, 1);
  assert.equal(hits[0]!.severity, 'error');
  assert.equal(hits[0]!.message, "Hallucinated component 'Button' imported from '@acme/elements'");
});

test('custom-elements: a dashed tag present in allExports but undocumented resolves as real, not hallucinated', () => {
  const data = makeSystemData({ model: 'custom-elements' });
  data.catalog.allExports.push('acme-card');
  data.catalog.allPropsByExport['acme-card'] = [];
  const report = checkUsage(data, '<acme-card>Hi</acme-card>', { language: 'html' });
  assert.equal(findingsOf(report, 'unknown-component').length, 0);
  assert.deepEqual(report.usedComponents, ['acme-card']);
});

test('custom-elements: a PascalCase tag is treated as a local React component, not the system\'s', () => {
  const data = makeSystemData({ model: 'custom-elements' });
  const code = "import { AcmeButton } from './local.tsx';\nconst X = () => <AcmeButton />;";
  const report = checkUsage(data, code);
  assert.equal(report.findings.filter((f) => f.kind === 'unknown-component').length, 0);
  assert.equal(report.usedComponents.length, 0);
});

test('custom-elements: invented prop with a kebab/team-alias fix', () => {
  const data = makeSystemData({ model: 'custom-elements' });
  const report = checkUsage(data, '<acme-button kind="brand">Save</acme-button>', { language: 'html' });
  const hits = findingsOf(report, 'invented-prop');
  assert.equal(hits.length, 1);
  assert.equal(hits[0]!.fix, "use 'tone' instead");
});

test('custom-elements: a real kebab-spelled prop is silent', () => {
  const data = makeSystemData({ model: 'custom-elements' });
  const report = checkUsage(data, '<acme-button icon-only tone="brand">Save</acme-button>', { language: 'html' });
  assert.equal(report.findings.filter((f) => f.kind === 'invented-prop').length, 0);
});

test('custom-elements: deprecated prop through the dashed tag', () => {
  const data = makeSystemData({ model: 'custom-elements' });
  const report = checkUsage(data, '<acme-badge color="red">Status</acme-badge>', { language: 'html' });
  const hits = findingsOf(report, 'deprecated');
  assert.equal(hits.length, 1);
  assert.equal(hits[0]!.fix, 'use tone instead');
});

test('custom-elements: missing-accessible-name on an empty required element, present with text content', () => {
  const data = makeSystemData({ model: 'custom-elements' });
  const empty = checkUsage(data, '<acme-text-input></acme-text-input>', { language: 'html' });
  assert.equal(findingsOf(empty, 'missing-accessible-name').length, 1);

  const selfClosing = checkUsage(data, '<acme-text-input />', { language: 'html' });
  assert.equal(findingsOf(selfClosing, 'missing-accessible-name').length, 1);

  const withText = checkUsage(data, '<acme-text-input>Value</acme-text-input>', { language: 'html' });
  assert.equal(findingsOf(withText, 'missing-accessible-name').length, 0);
});

test('custom-elements: raw color in a style attribute string, with an exact-token fix', () => {
  const data = makeSystemData({ model: 'custom-elements' });
  const report = checkUsage(data, '<acme-surface style="color: #ffffff;">Hi</acme-surface>', { language: 'html' });
  const hits = findingsOf(report, 'raw-value');
  assert.equal(hits.length, 1);
  assert.equal(hits[0]!.fix, 'use var(--acme-color-gray-0)');
});

test('custom-elements: raw hex color in class, via Tailwind arbitrary-value syntax', () => {
  const data = makeSystemData({ model: 'custom-elements' });
  const report = checkUsage(data, '<acme-surface class="bg-[#ffffff]">Hi</acme-surface>', { language: 'html' });
  const hits = findingsOf(report, 'raw-value');
  assert.equal(hits.length, 1);
  assert.equal(hits[0]!.message, "Raw value '#ffffff' in class");
});

// ---------------------------------------------------------------------------
// Invalid literal values
// ---------------------------------------------------------------------------

test('parseLiteralUnion: single-quoted members', () => {
  assert.deepEqual(parseLiteralUnion("'primary' | 'secondary' | 'ghost'"), ['primary', 'secondary', 'ghost']);
});

test('parseLiteralUnion: double-quoted members', () => {
  assert.deepEqual(parseLiteralUnion('"primary" | "secondary" | "ghost"'), ['primary', 'secondary', 'ghost']);
});

test('parseLiteralUnion: tolerates a trailing | undefined', () => {
  assert.deepEqual(parseLiteralUnion("'primary' | 'secondary' | undefined"), ['primary', 'secondary']);
});

test('parseLiteralUnion: returns undefined for a type that references another symbol', () => {
  assert.equal(parseLiteralUnion("'primary' | string"), undefined);
  assert.equal(parseLiteralUnion('string'), undefined);
  assert.equal(parseLiteralUnion('boolean'), undefined);
});

test('react: a valid literal value passes silently', () => {
  const data = makeSystemData();
  const code = "import { Button } from '@acme/react';\nconst X = () => <Button tone=\"danger\">Save</Button>;";
  const report = checkUsage(data, code);
  assert.equal(findingsOf(report, 'invalid-value').length, 0);
});

test('react: an invalid literal value for a union-typed prop errors with the allowed list', () => {
  const data = makeSystemData();
  const code = "import { Button } from '@acme/react';\nconst X = () => <Button tone=\"danger2\">Save</Button>;";
  const report = checkUsage(data, code);
  const hits = findingsOf(report, 'invalid-value');
  assert.equal(hits.length, 1);
  assert.equal(hits[0]!.severity, 'error');
  assert.equal(hits[0]!.message, "Invalid value 'danger2' for tone on <Button>: expected one of neutral, brand, danger");
});

test('react: a quoted-expression literal value ({\'danger2\'}) is checked the same as a plain attribute', () => {
  const data = makeSystemData();
  const code = "import { Button } from '@acme/react';\nconst X = () => <Button tone={'danger2'}>Save</Button>;";
  const report = checkUsage(data, code);
  assert.equal(findingsOf(report, 'invalid-value').length, 1);
});

test('react: a non-literal expression value is skipped for literal-union checking', () => {
  const data = makeSystemData();
  const code = "import { Button } from '@acme/react';\nconst t = 'danger2';\nconst X = () => <Button tone={t}>Save</Button>;";
  const report = checkUsage(data, code);
  assert.equal(findingsOf(report, 'invalid-value').length, 0);
});

test('react: boolean-typed prop given a non-boolean string warns', () => {
  const data = makeSystemData();
  const code = "import { Surface } from '@acme/react';\nconst X = () => <Surface bordered=\"yes\">Hi</Surface>;";
  const report = checkUsage(data, code);
  const hits = findingsOf(report, 'invalid-value');
  assert.equal(hits.length, 1);
  assert.equal(hits[0]!.severity, 'warning');
  assert.equal(hits[0]!.message, "Invalid value 'yes' for bordered on <Surface>: expected true or false");
});

test('react: number-typed prop given a non-numeric string warns', () => {
  const data = makeSystemData();
  const button = data.catalog.components.flatMap((c) => c.exports).find((e) => e.displayName === 'Button')!;
  button.props.push({ name: 'tabOrder', type: 'number', required: false });
  data.catalog.allPropsByExport['Button']!.push('tabOrder');
  const code = "import { Button } from '@acme/react';\nconst X = () => <Button tabOrder=\"abc\">Save</Button>;";
  const report = checkUsage(data, code);
  const hits = findingsOf(report, 'invalid-value');
  assert.equal(hits.length, 1);
  assert.equal(hits[0]!.severity, 'warning');
  assert.equal(hits[0]!.message, "Invalid value 'abc' for tabOrder on <Button>: expected a number");
});

test('custom-elements: an invalid literal value on a dashed tag errors with the allowed list', () => {
  const data = makeSystemData({ model: 'custom-elements' });
  const report = checkUsage(data, '<acme-button tone="danger2">Save</acme-button>', { language: 'html' });
  const hits = findingsOf(report, 'invalid-value');
  assert.equal(hits.length, 1);
  assert.equal(hits[0]!.message, "Invalid value 'danger2' for tone on <acme-button>: expected one of neutral, brand, danger");
});

// ---------------------------------------------------------------------------
// Language detection
// ---------------------------------------------------------------------------

test('language: auto-detects html for a bare tag snippet with no code syntax', () => {
  const data = makeSystemData({ model: 'custom-elements' });
  const report = checkUsage(data, '<acme-button tone="brand">Save</acme-button>');
  assert.equal(report.language, 'html');
});

test('language: auto-detects tsx when import/export/=>/{ is present', () => {
  const data = makeSystemData();
  const report = checkUsage(data, "import { Button } from '@acme/react';\nconst X = () => <Button>Save</Button>;");
  assert.equal(report.language, 'tsx');
});

test('language: an explicit language wins over detection', () => {
  const data = makeSystemData({ model: 'custom-elements' });
  const report = checkUsage(data, '<acme-button tone="brand">Save</acme-button>', { language: 'tsx' });
  assert.equal(report.language, 'tsx');
});

// ---------------------------------------------------------------------------
// Report shape
// ---------------------------------------------------------------------------

test('no-usage report: no design-system components used at all', () => {
  const data = makeSystemData();
  const report = checkUsage(data, 'const X = () => <div className="raw">Hi</div>;');
  assert.deepEqual(report.usedComponents, []);
});

test('findings are sorted by line, then kind', () => {
  const data = makeSystemData();
  const code = [
    "import { Modal } from '@acme/react';",
    "import { Button } from '@acme/react';",
    'const X = () => (',
    '  <div>',
    '    <Button kind="brand">Save</Button>',
    '    <Modal>Hi</Modal>',
    '  </div>',
    ');',
  ].join('\n');
  const report = checkUsage(data, code);
  const lines = report.findings.map((f) => f.line);
  const sorted = [...lines].sort((a, b) => (a ?? 0) - (b ?? 0));
  assert.deepEqual(lines, sorted);
});
