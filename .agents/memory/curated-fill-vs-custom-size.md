---
name: Curated fill-column vs custom sizing
description: Why user-set pane heights must exit the social bloc's abspos fill layout
---

**Rule:** On Curated, the right social bloc's "fill column" mode absolutely positions the bloc (removing it from intrinsic sizing) so the grid row is sized by other columns. Any user-adjustable height (e.g. the row-height drag handle) must disable that fill/abspos layout while a custom value is set — an inline max-height inside the abspos wrapper can never grow the section or keep the handle under the panes.

**Why:** First implementation only capped the inner scroll divs; code review rejected it because 480→900px was a no-op whenever nothing rendered below the bloc (the common case that enables fill mode).

**How to apply:** Gate every fill-mode class (wrapper abspos, grid flex-1, section h-full, pane max-h-none) on `fill && customHeight == null`; clearing the custom value (null) restores fill behaviour.
