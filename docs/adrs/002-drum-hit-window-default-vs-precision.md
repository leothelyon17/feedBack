# ADR-002: Default vs Precision drum hit window

**Status:** Accepted
**Date:** 2026-08-26
**Provenance:** INIT-007/SPEC-001
**Source:** RSCH-002 (`sdd/research/RSCH-002-yarg-precision-mode-hit-windows/RSCH-002-yarg-precision-mode-hit-windows-report.md`)
**Traces:** Option B (forgiving default + opt-in Precision checkbox)

---

## Summary

Drum hit **forgiveness** is a two-state, **fixed** window on the drum profile. Default (Precision off) is YARG Default's width: **140 ms total**, half-window **0.07 s (±70 ms)**. Precision on restores today's shipped feel: **100 ms total**, half-window **0.05 s (±50 ms)**.

This ADR records Option B. It does not replace Calibration, `timing.offset_ms`, or ADR-001's judge plane. The Precision checkbox is **not** YARG's density-scaled 40–130 ms Precision preset. SPEC-002+ implement the flag and apply the constants; they do not invent other milliseconds.

---

## Context

fee[dB]ack ships a single fixed drum window of **±50 ms** (`HIT_TOLERANCE = 0.05` s on the 2D highway, `HIT_TOLERANCE_S = 0.05` s on the 3D highway). The check is symmetric (`Math.abs(delta) <= window`). There is no per-lane override and no player-facing lever.

RSCH-002 compared that window to YARG's engine presets:

| Window (total width) | fee[dB]ack (shipped) | YARG Default | YARG Precision |
| --- | --- | --- | --- |
| Value | 100 ms (±50 ms), fixed | 140 ms (±70 ms), fixed (`MaxWindow = 0.14`) | 40–130 ms (±20–65 ms), **density-scaled** |
| Symmetric? | Yes | Yes (`FrontToBackRatio = 1.0`) | Yes (no ratio override found) |
| Scales with note density? | No | No (`IsDynamic = false`) | Yes (`IsDynamic = true`) |

Our 100 ms window is **40 ms (29%) tighter than YARG Default**. It sits *inside* YARG Precision's 40–130 ms band but never moves, so it is **neither** preset. Players who score well on a tight window have no forgiveness path; players who expect YARG Precision's live scaling will not get it here.

ADR-001 already named the clock the window is measured against (judge plane). This ADR names the **width**. Width is forgiveness. Offset is correctness. Do not collapse them.

---

## Locked numbers

Later specs copy these constants. Do not invent a third width.

| Mode | Total width | Half-window (code) | Source |
| --- | --- | --- | --- |
| **Default** (Precision off) | **140 ms** | **`0.07` s (±70 ms)** | YARG Default `MaxWindow = 0.14` |
| **Precision** on | **100 ms** | **`0.05` s (±50 ms)** | fee[dB]ack shipped `HIT_TOLERANCE` |

Both windows stay **fixed** and **symmetric** (`FrontToBackRatio = 1.0` equivalent: early and late halves equal). Omit-key on a stored profile means Default (forgiving).

---

## Vocabulary

Use these terms in SPEC-002 and later. Do not rename them.

| Term | Meaning |
| --- | --- |
| **Default window** | Precision off (or key omitted). Total 140 ms; half-window `0.07` s (±70 ms). |
| **Precision window** | Precision on. Total 100 ms; half-window `0.05` s (±50 ms). Today's shipped feel. |
| **`scoring.precision_mode`** | Boolean on the **drum profile**. `true` → Precision window. Absent or `false` → Default window. |
| **Hit window** | Forgiveness band around a note on the **judge plane**. Not Calibration. Not `av_offset_ms`. |

---

## Decision

**Option B** (RSCH-002 weighted 4.25/5; owner approved create-initiative 2026-08-26).

1. Ship a more-forgiving **Default** matching YARG Default's **140 ms** (±70 ms / `0.07` s). New profiles and omitted `scoring.precision_mode` use this.
2. Opt-in **Precision** restores the shipped **100 ms** (±50 ms / `0.05` s). Keep today's feel rather than YARG Precision's 40 ms dynamic floor (assumption `aud-1`).
3. Precision in fee[dB]ack is a **fixed** window. It is **not** YARG Precision's dynamic 40–130 ms density-scaled preset. Do not port `HitWindowSettings.CalculateHitWindow()`, `IsDynamic`, min/max scaling, or `Dark_Yarg_Impl`.
4. The checkbox lives on the drum **profile** (`scoring.precision_mode`). Not a global `/api/settings` key. Not on the MIDI device `timing` object (`timing.offset_ms` stays Calibration).
5. Changing the window **must not replace Calibration**. Do not widen (or tighten) the window to hide a bad `timing.offset_ms`. Restates ADR-001 / RSCH-001: hit windows are not calibration. Systematic error stays on the composite offset per `{device, origin, audio_backend}`.
6. **Out of scope:** YARG **Casual**; `FrontToBackRatio` ≠ 1.0 (asymmetric early/late); full dynamic `HitWindowSettings` (RSCH-002 Option D).

### Placement (REQ from INIT-007)

| Surface | Owns | Does not own |
| --- | --- | --- |
| Drum **profile** JSON | `scoring.precision_mode` (omit = false / Default) | Clock domain, device offset |
| MIDI device `timing` | `offset_ms` (INIT-004 / INIT-006 Calibration) | Hit-window width |
| Guitar `/api/settings` | `av_offset_ms` (render plane only) | Drum verdicts or drum window |

**Invariant:** toggling Precision changes only `HIT_TOLERANCE` / `HIT_TOLERANCE_S`. It must not write `timing.offset_ms` or `av_offset_ms`.

---

## Options considered

Recorded from RSCH-002; not re-evaluated. **Source:** RSCH-002 options matrix.

| Option | What it is | Why not (or why B) | Weighted |
| --- | --- | --- | --- |
| **A** (baseline) | Keep shipped ±50 ms only | Fair and small. No forgiveness lever. Window is 29% tighter than YARG Default with no player choice. | 3.65 |
| **B** (chosen) | YARG-like forgiving default (140 ms) + opt-in fixed Precision (100 ms) on the drum profile | Mirrors YARG's Default / opt-in Precision *split* without a multi-domain engine port. Exact Precision milliseconds stay today's shipped feel (`aud-1`). | **4.25** |
| **C** | Invert: Precision default, forgiving opt-in | YARG ships Default out of the box; Precision is opt-in. Inverting fights prior art and the player's request. | 3.15 |
| **D** | Full `HitWindowSettings` port (dynamic 40–130 ms, density curve, `FrontToBackRatio`) | Highest fidelity, oversized (engine math + UI sliders + persist across two plugin repos). Deferred as a later initiative if B is not enough. | 4.00 |

Weight sensitivity in RSCH-002: B still wins at player-feel 0.20 and 0.40.

---

## INIT-004 / ADR-001 locks this initiative must not reopen

- **Windows ≠ calibration.** Do not use window width to hide a bad `timing.offset_ms`. Remeasure the composite; do not "fix timing" by opening the window.
- **Judge plane stays ADR-001.** Width is measured on `getJudgeTime()` / chart-aligned input time. `av_offset_ms` still must not change a drum verdict.
- **No `/api/settings` drum field** for this flag. Drum timing offset stays on the MIDI device document; the window flag stays on the **drum profile**.
- **No `/ws` clock.** Unchanged from ADR-001.
- **Do not re-implement** tap-to-beat, the Calibration ritual, or device-document persist.

---

## Out of scope (explicit)

These are **not** what this checkbox ships. Later specs must not sneak them in as "the same flag."

| Deferred | What it would be | Why not now |
| --- | --- | --- |
| **YARG Casual** | A third, looser preset | Option B is two states only. A third width is a new initiative. |
| **YARG Precision dynamic 40–130 ms** | Density-scaled min/max (`IsDynamic = true`) | fee[dB]ack Precision is **fixed ±50 ms**. Name collision with YARG is intentional for the *opt-in tighter* idea, not for the curve. |
| **`FrontToBackRatio` ≠ 1.0** | Asymmetric early vs late halves | Both shipped windows stay symmetric, matching YARG Default's ratio 1.0 and fee[dB]ack's `Math.abs` check. |

---

## Consequences

**SPEC-002** (data) adds optional `scoring.precision_mode` on drum profile JSON. Omit = Default (forgiving). Old files keep loading.

**SPEC-003** (API) round-trips the key on existing `/api/drums/profiles` GET/PUT. Garbage non-bool coerces to false (Default). Does not widen past the ADR caps.

**SPEC-004** (2D plugin + Profiles UI) reads the flag, sets `HIT_TOLERANCE` to `0.07` or `0.05`, and puts the checkbox on the Profiles editor. UI copy: Precision is **fixed ±50 ms**, not density-scaled.

**SPEC-005** (3D highway) applies the same two constants to `HIT_TOLERANCE_S`. 2D and 3D must not diverge.

**Rollback:** delete this file. No runtime behavior changes until SPEC-002+. Reverting the branch restores the single shipped ±50 ms window.

---

## References

- RSCH-002 — Option B recommendation, Default 140 ms / Precision 40–130 ms dynamic, calibration-independence note.
- ADR-001 — judge vs render planes; "Hit windows (`±50 ms` today) are not calibration."
- INIT-007 initiative — locked numbers table (Default `0.07` s / Precision `0.05` s).
- INIT-004 / INIT-006 — Calibration, tap-to-beat, device `timing.offset_ms`.
- YARG.Core `HitWindowPreset` — `MaxWindow = 0.14`, `IsDynamic = false`, `FrontToBackRatio = 1.0` (Default).
- `feedBack-plugin-drums/screen.js` — `HIT_TOLERANCE = 0.05`.
- `feedBack/plugins/drum_highway_3d/screen.js` — `HIT_TOLERANCE_S = 0.05`.
