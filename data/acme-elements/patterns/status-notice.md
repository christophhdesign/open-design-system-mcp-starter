---
title: Status notice
description: A dismissible alert calling out the result of an action, in a state that matches its severity.
tags: alert, notice, status, feedback
language: html
---

# Status notice

Pick `state` to match what happened -- `success` for a completed action, `warning` for
something the reader should double check, `danger` for a failure -- and set `dismissible` so
the reader can clear it once read.

```html
<acme-alert state="success" dismissible>
  Your changes have been saved.
</acme-alert>
```

Listen for the `dismiss` event if the surrounding UI needs to know when the reader closed it.
