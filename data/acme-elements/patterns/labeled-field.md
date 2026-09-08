---
title: Labeled field with error
description: A single-line text field with its own label, ready to show a validation error.
tags: form, validation, error
language: html
---

# Labeled field with error

`acme-text-field` carries its own `label`; do not wrap it in a separate `<label>` element. Set
`invalid` and `error-text` together once validation fails, and clear both once the field is
valid again.

```html
<acme-text-field
  label="Email"
  placeholder="you@example.com"
  invalid
  error-text="Enter a valid email address."
></acme-text-field>
```

Listen for the `change` event to re-validate and clear `invalid`/`error-text` once the value is
acceptable.
