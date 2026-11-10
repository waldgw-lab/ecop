---
name: Mirrored service listener isolation
description: Diagnose inconsistent endpoints caused by orphaned servers sharing the same financial-service port.
---

If an endpoint randomly returns the old financial-mirror 404 despite correct current routes, check for multiple listening processes before changing the API or its query parameters.

**Why:** Several pre-existing copies of this mirror remained bound after a workflow restart. Shared-port listening let old and new versions handle different connections and let multiple collectors race shared provider cursors.

**How to apply:** Keep one financial listener/collector. Identify listener ownership and working directories before stopping orphaned mirror processes; use the artifact's managed workflow afterward. Do not enable shared-port binding to conceal an address-in-use error or broadly kill unrelated browser/relay processes.
