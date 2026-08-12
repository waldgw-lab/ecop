---
name: Curated prefs sync semantics
description: Durable contract for cross-device preference sync when adding new synced keys.
---

- Rule: When hydrating synced preferences from a server snapshot, a key ABSENT from the snapshot means "no information" and must leave the local value untouched; only an EXPLICIT null is a cross-device reset.
- **Why:** Older server snapshots never contain newly added sync keys; treating absence as a reset erases every existing user's local value on their next hydration.
- **How to apply:** Preserve the absent-vs-null distinction whenever adding a key to the sync list, and serialize concurrent read-merge-write pushes of the same preference so a superseded write cannot land last.
