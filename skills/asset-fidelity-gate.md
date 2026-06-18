---
name: asset-fidelity-gate
description: "Guides agents through the asset usability checks that gate mockup generation. Use when adding media intake logic, modifying the compositor gate, or debugging logo rejection or silent low-res acceptance."
---

## Overview

Asset usability is not stored as a settled boolean — it is derived at read time from stored inputs (`width_px`, `height_px`, `is_vector`, `role`, `role_source`). The live gate is `coarseUsable()`: a placement-agnostic floor (`PRINT_FLOOR_PX = 1500`) called in both the host (blocks `request_mockup`) and the compositor (blocks render). `fidelityVerdict()` is **[BUILT]** — exported from asset-store.ts, designed for placement-aware checks against a specific print box — but has no call site in the live path yet. Do not treat it as operative until it is wired.

Source: flock-asset-store.md §"Usability is derived at read time, never stored"; src/store/asset-store.ts:coarseUsable() L58, fidelityVerdict() L474; src/brain/action-applier.ts:onRequestMockup() L224; src/integrations/sharp-compositor.ts L408.

## When to Use

- Adding a new media intake path
- Modifying the mockup gate in `action-applier.ts`
- Debugging why a logo is being rejected or silently accepted at low resolution
- Adding a new print placement to the compositor

## Process

1. On media receipt, `host.ts` calls `assetStore.writeAsset()`. This runs `inspectAsset()` (magic-byte vector detection for PDF/SVG, then Sharp for raster dimensions) and stores `width_px`, `height_px`, `is_vector`, `resolution_hint`. src/store/asset-store.ts:writeAsset() + inspectAsset(). Asset starts as `role='unknown', role_source='proposed_unconfirmed', is_current=0, version=0`.
2. Brain emits `confirm_asset` after the client identifies the image. Host calls `assetStore.confirmAssetRole(asset_id, 'logo', 'fidelity', promote=true)`. src/brain/action-applier.ts:onConfirmAsset(). This sets `role='fidelity', role_source='client_stated'` and promotes to `is_current=1` with version allocated.
3. Version-swap ordering: clear old `is_current=0` **before** setting new `is_current=1` in one transaction. SQLite checks the partial unique index per statement, not deferred — wrong order trips the constraint mid-transaction. flock-asset-store.md §"Version-swap ordering (clear-then-set, one transaction)"; src/store/asset-store.ts:confirmAssetRole().
4. Brain emits `request_mockup`. Host calls `assetStore.resolveLogo(jid, 'current')`. src/brain/action-applier.ts:onRequestMockup().
5. Host applies `coarseUsable(logo)`: returns `true` if `is_vector || min(width_px, height_px) >= 1500`. src/store/asset-store.ts:coarseUsable() L58. If false, reject with "ask client for higher resolution" and return — mockup generation never starts. src/brain/action-applier.ts:onRequestMockup() L224.
6. Compositor also calls `coarseUsable(asset)` before compositing. src/integrations/sharp-compositor.ts L408. This is the live secondary gate — same function, placement-agnostic.
7. **[BUILT, not wired]** `fidelityVerdict(asset, targetMinPx)` is exported from asset-store.ts L474 for future placement-aware checks (shortest edge of the print box at target DPI). It has no call site in the live path. Do not cite it as an active gate until wired. flock-asset-store.md §"fidelity_usable — placement-dependent".
8. Never silently return a whatsapp-res logo to the compositor. flock-asset-store.md §"Silently returning a whatsapp-res logo here is exactly the pixelated-banner failure the spike eliminated — do not do this."

## Rationalizations

| Excuse | Rebuttal |
|---|---|
| "The client said it's their logo — trust it." | `role_source='client_stated'` records intent; it does not measure resolution. A WhatsApp-compressed logo can be `role='fidelity'` and still fail `coarseUsable`. Source: flock-asset-store.md §"Operational Contracts — Usability is derived at read time". |
| "Store a `usable` boolean to avoid recomputing it." | The usability threshold is designed to be placement-dependent (hence `fidelityVerdict`). Storing a boolean now locks in the wrong threshold before the placement-aware gate is wired. Source: flock-asset-store.md §"print_min_px is placement-dependent". |
| "Skip `coarseUsable` — the compositor will catch it." | The compositor's `coarseUsable` call (L408) is the same floor, not a stricter gate. Skipping the host check wastes a generation round-trip on an unusable asset. Source: action-applier.ts:onRequestMockup() L224. |
| "`fidelityVerdict` is in the codebase — it must be running." | It is exported but has no call site. `git grep fidelityVerdict -- src/` returns only the definition and a comment. It is [BUILT], not wired. |

## Red Flags

- `role_source='proposed_unconfirmed'` asset passed to the compositor
- `coarseUsable` check removed or bypassed in `onRequestMockup()`
- `is_current=1` set on new asset before clearing old current (trips `idx_assets_current` unique index)
- `width_px`/`height_px` stored as `null` for a raster image (Sharp inspection failed; treat as unusable, not as vector)
- `fidelityVerdict` cited as an active gate in code review or documentation before it has a call site (`git grep fidelityVerdict -- src/` returns only the definition)

## Verification

- `SELECT role, role_source, is_current, width_px, height_px, is_vector FROM assets WHERE jid=? AND asset_type='logo' AND is_current=1` — expect `role='fidelity'`, `role_source='client_stated'`, `is_current=1`, with valid dimensions or `is_vector=1`
- `SELECT COUNT(*) FROM assets WHERE jid=? AND asset_type='logo' AND is_current=1` = exactly 1 (unique index enforces this; more than 1 is a bug)
- `npm test` — test/3-asset-store-version-at-confirm.test.ts, test/compositor-smoke.test.ts
