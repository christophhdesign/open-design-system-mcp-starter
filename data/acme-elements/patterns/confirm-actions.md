---
title: Confirm dialog actions
description: A primary and secondary action laid out side by side, for a confirm dialog or any two-choice prompt.
tags: dialog, confirm, actions
language: html
---

# Confirm dialog actions

Lay the two actions out in a row with `acme-stack`, primary action last so it lands under the
reader's thumb / cursor. Give the destructive or affirming choice `variant="primary"`, and the
escape hatch `variant="secondary"`.

```html
<acme-stack direction="row" gap="sm">
  <acme-button variant="secondary">Cancel</acme-button>
  <acme-button variant="primary">Delete project</acme-button>
</acme-stack>
```

Never use `acme-badge` or `acme-alert` for action buttons; they aren't interactive.
