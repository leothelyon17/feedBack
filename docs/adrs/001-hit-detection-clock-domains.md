# ADR-001: Hit-detection clock domains (judge plane vs render plane)

**Status:** Accepted
**Date:** 2026-08-25
**Provenance:** INIT-006/SPEC-001
**Source:** RSCH-001 (`sdd/research/RSCH-001-hit-detection-calibration/RSCH-001-hit-detection-calibration-report.md`)
**Traces:** REQ-001, REQ-002, REQ-008, REQ-009

---

## Summary

Drum hits are judged on the **judge plane** (chart-aligned input time). Gems draw on the **render plane**. The guitar A/V slider moves only the render plane. One measured **composite offset** per MIDI device per topology tag absorbs the ritual; an **audio-latency hint** may split at apply time but never silently replaces that composite.

This ADR records Option D. It does not replace INIT-004's Calibration ritual, tap-to-beat math, or device persist. `getJudgeTime()` is named here; SPEC-002 implements it.

---

## Context

Highway already splits two clocks (`static/highway.js`):

- `chartTime` — audio-aligned chart clock. `getTime()` exposes the interpolated value to plugins.
- `currentTime` — render clock. `currentTime = chartTime + avOffsetSec`. `setAvOffset(ms)` / `av_offset_ms` move only this value.

INIT-004 maps MIDI `timeStamp` onto `highway.getTime()` (`static/js/tap-to-beat.js`) and comments that this is the heard/scoring clock, not the visual A/V plane. That mapping is the de-facto judge clock today. It is not a named core accessor, so later specs could still score against `bundle.currentTime` and let the guitar A/V slider move drum verdicts.

`getJudgeTime()` does not exist yet. Do not invent a second clock beside the one below.

---

## Four times

A rhythm game has four times. Calibration maps between them. Each offset moves exactly one mapping.

| Time | Meaning in this app | What moves it |
| --- | --- | --- |
| **Chart time** | Authoritative note positions. `chartTime`; `getTime()` interpolates it. | Audio clock via `setTime()`; per-song `songOffset`. |
| **Audio time** | When sound reaches the ear. `audio.currentTime` or JUCE `jucePlayer.currentTime`. | Output pipeline (`baseLatency` + `outputLatency`, or JUCE device latency). Seeded as the **audio-latency hint**; never a silent merge into the composite. |
| **Display time** | When the gem is seen. Render-plane `currentTime`. | `av_offset_ms` / `avOffsetSec` only. |
| **Input time** | When the pad was struck. MIDI `timeStamp` (`DOMHighResTimeStamp` on the `performance.now()` origin). | **Composite offset** (measured per device per topology tag), subtracted once at apply. |

Signs are opposite across planes: an audio-output delay means the player hears late (judge later); a display delay means the player sees late (draw earlier). One global slider cannot serve both. Hit windows (`±50 ms` today) are not calibration.

---

## Vocabulary

Use these terms in SPEC-002 and later. Do not rename them.

| Term | Meaning |
| --- | --- |
| **Judge plane** | Chart-aligned input time. MIDI `timeStamp` mapped onto chart time; composite offset subtracted once. Never `bundle.currentTime`. |
| **Render plane** | Visual draw time. `currentTime = judge + avOffsetSec`. |
| **Composite offset** | One measured number per `{device, origin, audio_backend}` from INIT-004 Calibration. Speaker latency + perception + MIDI transport, collapsed. Remeasure on tag mismatch; do not split into local + network RTT terms. |
| **Audio-latency hint** | Seeded (not measured) output-latency term. Display it; the player may override it. Split from the composite only at apply time, and only if a hint exists. Never silently replace a measured composite. |

---

## Decision

**Option D** (RSCH-001 weighted 4.20/5; owner approved 2026-08-25).

1. One measured composite per device per topology tag. Split only at apply time if an audio-latency hint exists. Not full YARG split-at-measure (Option B). Not server-authoritative timestamps (Option C).
2. Land INIT-004 first, unchanged. This ADR does not replace Calibration, tap-to-beat, or device persist.
3. Judge on the input-domain clock: MIDI `timeStamp` mapped onto chart time; never `bundle.currentTime`.
4. Observability before more knobs (in-play HUD before auto-trim; auto-trim before any new offset slider).
5. Audio latency is a hint. The player can override it. The app must not silently replace a measured composite.
6. HTTPS/TLS for NAS MIDI is a deploy follow-up. This initiative only warns.
7. INIT-004 locks stay in force (see below).

### Named accessors (REQ-001, REQ-002)

| Accessor | Plane | Contract |
| --- | --- | --- |
| `getJudgeTime()` | **Judge plane** | Chart-aligned input time. Intended named accessor for drum (and other input) verdicts. SPEC-002 implements it. Until then, INIT-004's mapping onto `getTime()` is the de-facto judge clock. |
| `currentTime` | **Render plane** | `= judge + avOffsetSec`. Gems draw here. |

**Invariant:** `av_offset_ms` must not change a drum verdict. A non-zero A/V slider shifts gems only.

Do not add other clock getters in this initiative.

---

## Options considered

Recorded from RSCH-001; not re-evaluated. **Source:** RSCH-001 options matrix.

| Option | What it is | Why not (or why D) | Weighted |
| --- | --- | --- | --- |
| **A** (baseline) | INIT-004 as built: one composite per device, judge via `getTime()` mapping | Necessary prerequisite. No named judge plane, no audio-latency hint, no in-play observability. D extends A; it does not reopen it. | 3.55 |
| **B** | Full YARG split: audio + video + input offsets on an input-authoritative clock, plus drift-resync | Accuracy is a clock-domain problem here, not a knob-count problem. Clone Hero collapses measurements to one number. YARG already has three knobs and players still cannot tell early from late. Core-wide clock replacement is out of scope. | 3.45 |
| **C** | Server-authoritative hit timestamps over WebSocket | Taps never leave the browser. INIT-004 already rejected a `/ws` clock and server timestamps. Extra RTT, no MIDI on plain HTTP. | 1.65 |
| **D** (chosen) | Input-plane judgment + one measured composite per device/topology + seeded audio-latency hint + in-play observability | Removes A/V coupling without a YARG rebuild. Degrades cleanly across the three topologies below. Hint is display-only until the player accepts it. | **4.20** |

Weight sensitivity in RSCH-001: D wins at accuracy 0.20–0.40. A/B crossover is irrelevant because D is the staging path off landed INIT-004.

---

## INIT-004 locks this initiative must not reopen

Traces REQ-008.

- **Composite + remeasure**, not a split local + network RTT term. Taps never leave the browser, so network RTT is not a timing term.
- **No `/ws` clock.** No `/ws/highway` or `/ws/sync` timestamp for hits.
- **No `/api/settings` drum field.** Drum timing lives on the MIDI device document, not the guitar A/V settings key.
- **One offset per MIDI device**, not per-lane.
- **Do not re-implement** tap-to-beat, the Calibration ritual, or device-document persist.

---

## Topology

Traces REQ-009. The container is never on the audio or input timing path.

| Topology | Clock domains | Decisive constraint |
| --- | --- | --- |
| **Same-host Docker** (`http://localhost:8000`) | Browser only. Audio plays in the host browser; the container serves files and WebSocket frames. | Secure context (`localhost`), so Web MIDI is available. **Container is the byte path** — no audio crosses the container boundary. |
| **Network HTTP** (`http://<host>:8000`) | Same byte path plus network transport for chart/WS. | **No Web MIDI.** The API is secure-context-only; tracked Compose files publish plain HTTP on 8000 with no TLS terminator. `navigator.requestMIDIAccess` is absent. MIDI drums cannot run until TLS or a tunnel is in front. This initiative warns; it does not add TLS. Network RTT is still not a timing term. |
| **Local desktop** | Browser clock plus native JUCE audio (`audio_backend`). Position is polled (`jucePlayer`), not a Web Audio sample clock. | JUCE `audio_backend` is a different topology tag from HTML5 `<audio>`. `AudioContext.outputLatency` does not apply; seed the audio-latency hint from the JUCE device instead. |

INIT-004's `{origin, audio_backend}` remeasure tag is the right shape: `origin` captures the secure-context/topology change; `audio_backend` captures HTML5 vs JUCE. INIT-006 stores a small profile *set* under that key (SPEC-005); it does not change the tag.

---

## Consequences

**SPEC-002** implements `getJudgeTime()`, the A/V-independence invariant (non-zero `av_offset_ms` does not move a drum verdict), and the secure-context MIDI warning. Copy this vocabulary; do not invent a second clock model.

**SPEC-004** seeds the audio-latency hint. It is not the judge clock.

**SPEC-005 / SPEC-006** persist `{origin, audio_backend}` profiles plus an optional hint field. Omitted keys keep today's single `offset_ms` + tag loading.

**SPEC-003 / SPEC-007** add in-play observability then damped auto-trim. Auto-trim writes the same INIT-004 `offset_ms`; it does not invent a second scoring offset.

**Rollback:** delete this file. No runtime behavior changes until SPEC-002+.

---

## References

- RSCH-001 — Option D recommendation, four-times table, topology table, INIT-004 lock list.
- INIT-006 initiative — locked decisions 1–7 (2026-08-25).
- INIT-004 — Calibration, tap-to-beat, device `timing.offset_ms` (feedBack#3 / `2fee397`).
- `static/highway.js` — `chartTime` vs `currentTime` (`= chartTime + avOffsetSec`).
- `static/js/tap-to-beat.js` — MIDI `timeStamp` mapped onto `highway.getTime()`.
- `static/js/settings.js` — `av_offset_ms` drives `setAvOffset`; `getTime()` stays chart-aligned.
- `docker-compose.yml`, `docker-compose.nas.yml` — `"8000:8000"`, no TLS terminator.
