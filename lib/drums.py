"""Drum kit vocabulary, presets, and drum_tab.json helpers.

The canonical drum payload in a sloppak is a top-level `drum_tab.json` file
referenced from `manifest.yaml` via the `drum_tab:` key (see
`docs/sloppak-spec.md` §5.3). This module is the source of truth for:

- the closed list of drum piece-ids that a `drum_tab.json` may reference,
- their default GM percussion MIDI notes and visual category,
- preset lane configurations for the drums plugin,
- a permissive validator + short-key wire helper used by both the writer
  side (importers) and the reader side (sloppak loader + highway WS),
- device kit records (`note_to_piece`, `load_kits`) that overlay GM
  (INIT-001/SPEC-001).

The schema is intentionally extensible: unknown piece-ids round-trip through
the loader so a newer sloppak can still play on an older client that just
doesn't have visuals for the new piece. Validation is strict only on the
top-level shape (`version`, `kit`, `hits` types).
"""

from __future__ import annotations

import json
import logging
import math
from pathlib import Path

log = logging.getLogger("feedBack.lib.drums")


# ── Piece vocabulary ──────────────────────────────────────────────────────────
#
# Each entry pins a closed piece-id to its default General MIDI percussion
# note(s), a category (kick/drum/cymbal — drives default shape rendering), and
# a default colour. The drums plugin reads this map on startup and uses the
# defaults to seed the user's lane configuration; users can override colours
# and shapes per lane in localStorage.

PIECES: dict[str, dict] = {
    # Kick — full-width bar across all non-kick lanes.
    "kick":          {"midi": [35, 36],        "category": "kick",   "shape": "bar",            "color": "#f59e0b"},

    # Drums proper — rectangles. Toms ordered hi→floor.
    "snare":         {"midi": [38, 40],        "category": "drum",   "shape": "rect",           "color": "#ef4444"},
    "snare_xstick":  {"midi": [37],            "category": "drum",   "shape": "rect_hatched",   "color": "#dc2626"},
    "tom_hi":        {"midi": [50, 48],        "category": "drum",   "shape": "rect",           "color": "#eab308"},
    "tom_mid":       {"midi": [47, 45],        "category": "drum",   "shape": "rect",           "color": "#ca8a04"},
    "tom_low":       {"midi": [43],             "category": "drum",   "shape": "rect",           "color": "#a16207"},
    "tom_floor":     {"midi": [41],            "category": "drum",   "shape": "rect",           "color": "#854d0e"},

    # Cymbals — circles. Open/closed hi-hat are distinct piece-ids, not a
    # per-hit articulation flag, because hit detection must reject a
    # closed-hat strike on an open-hat note (and vice versa).
    "hh_closed":     {"midi": [42],            "category": "cymbal", "shape": "circle_filled",  "color": "#22d3ee"},
    "hh_open":       {"midi": [46],            "category": "cymbal", "shape": "circle_ring",    "color": "#06b6d4"},
    "hh_pedal":      {"midi": [44],            "category": "cymbal", "shape": "circle_small_x", "color": "#0891b2"},
    # Stack — two cymbals stacked for a trashy/choked effect. GM has no
    # standard for it; we reuse 30 (in GM's extended-percussion range,
    # unused by real drum-kit MIDIs).
    "stack":         {"midi": [30],            "category": "cymbal", "shape": "circle_jagged",  "color": "#94a3b8"},
    "crash_l":       {"midi": [49],            "category": "cymbal", "shape": "circle",         "color": "#84cc16"},
    "crash_r":       {"midi": [57],            "category": "cymbal", "shape": "circle",         "color": "#65a30d"},
    "splash":        {"midi": [55],            "category": "cymbal", "shape": "circle_small",   "color": "#a3e635"},
    "china":         {"midi": [52],            "category": "cymbal", "shape": "circle_jagged",  "color": "#4d7c0f"},
    "ride":          {"midi": [51, 59],        "category": "cymbal", "shape": "circle",         "color": "#3b82f6"},
    "ride_bell":     {"midi": [53],            "category": "cymbal", "shape": "circle_dot",     "color": "#1d4ed8"},
    # Bell cymbal — a small mounted bell, distinct from the ride's bell.
    # No GM standard; we reuse 80 ("Mute Triangle"), unused in real
    # drum-kit MIDIs.
    "bell":          {"midi": [80],            "category": "cymbal", "shape": "circle_dot",     "color": "#fde047"},
}


# Reverse map MIDI note → piece-id. First piece-id whose `midi` list contains
# the note wins (PIECES is iteration-ordered so the "preferred" piece-id for a
# shared MIDI is the one declared earlier). Built once at import time.
_MIDI_TO_PIECE: dict[int, str] = {}
for _pid, _meta in PIECES.items():
    for _m in _meta["midi"]:
        _MIDI_TO_PIECE.setdefault(_m, _pid)


def midi_to_piece(midi: int) -> str | None:
    """Return the canonical piece-id for a GM percussion MIDI note, or None
    if the note isn't mapped (e.g. cowbell, tambourine — extensible later)."""
    return _MIDI_TO_PIECE.get(int(midi))


def piece_to_default_midi(piece: str) -> list[int]:
    """Return the GM MIDI notes that map to `piece` by default. Empty list for
    unknown piece-ids — callers should treat that as "unmapped" rather than
    crashing, so a newer sloppak's unknown piece round-trips silently."""
    entry = PIECES.get(piece)
    return list(entry["midi"]) if entry else []


def piece_default_shape(piece: str) -> str:
    """Default rendering shape for a piece-id. `"rect"` fallback so an
    unknown piece still draws something the user can see."""
    entry = PIECES.get(piece)
    return entry["shape"] if entry else "rect"


def piece_default_color(piece: str) -> str:
    """Default colour for a piece-id. Neutral grey fallback for unknown."""
    entry = PIECES.get(piece)
    return entry["color"] if entry else "#9ca3af"


def piece_category(piece: str) -> str:
    """Category (`kick`/`drum`/`cymbal`) — `"drum"` fallback for unknown."""
    entry = PIECES.get(piece)
    return entry["category"] if entry else "drum"


# ── Preset lane configurations ────────────────────────────────────────────────
#
# Each preset is a list of `lane` dicts. A lane carries:
#   - `pieces`: list of piece-ids that route to this lane (multiple → shared)
#   - `label`:  short header text
# Visual fields (color, shape, weight) are optional; the renderer falls back
# to the per-piece defaults above. The drums plugin layers user customisation
# on top of these.

PRESET_RB4 = [
    {"pieces": ["kick"],                                        "label": "Ki"},
    {"pieces": ["snare", "snare_xstick"],                       "label": "Sn"},
    {"pieces": ["hh_closed", "hh_open", "hh_pedal"],            "label": "HH"},
    {"pieces": ["tom_hi", "tom_mid"],                           "label": "T"},
    {"pieces": ["tom_low", "tom_floor"],                        "label": "FT"},
    {"pieces": ["crash_l", "crash_r", "splash", "china", "stack"], "label": "Cr"},
    {"pieces": ["ride", "ride_bell", "bell"],                   "label": "Ri"},
]

# 8-lane layout matching the legacy drums plugin v3 (HH / Sn / T1 / T2 / T3 /
# Cr / Ri / Ki) so existing sloppaks keep their familiar lane order when the
# rewrite ships.
PRESET_PHASESHIFT8 = [
    {"pieces": ["hh_closed", "hh_open", "hh_pedal"],            "label": "HH"},
    {"pieces": ["snare", "snare_xstick"],                       "label": "Sn"},
    {"pieces": ["tom_hi"],                                      "label": "T1"},
    {"pieces": ["tom_mid"],                                     "label": "T2"},
    {"pieces": ["tom_low", "tom_floor"],                        "label": "T3"},
    {"pieces": ["crash_l", "crash_r", "splash", "china", "stack"], "label": "Cr"},
    {"pieces": ["ride", "ride_bell", "bell"],                   "label": "Ri"},
    {"pieces": ["kick"],                                        "label": "Ki"},
]

# One lane per piece-id — for users with a full e-kit who want every piece on
# its own column. Order roughly mirrors a physical kit left→right.
PRESET_EKIT_FULL = [
    {"pieces": ["hh_pedal"],     "label": "HH-p"},
    {"pieces": ["hh_closed"],    "label": "HH-c"},
    {"pieces": ["hh_open"],      "label": "HH-o"},
    {"pieces": ["snare_xstick"], "label": "Sn-x"},
    {"pieces": ["snare"],        "label": "Sn"},
    {"pieces": ["tom_hi"],       "label": "T1"},
    {"pieces": ["tom_mid"],      "label": "T2"},
    {"pieces": ["tom_low"],      "label": "T3"},
    {"pieces": ["tom_floor"],    "label": "FT"},
    {"pieces": ["stack"],        "label": "Stk"},
    {"pieces": ["crash_l"],      "label": "Cr-L"},
    {"pieces": ["splash"],       "label": "Sp"},
    {"pieces": ["china"],        "label": "Ch"},
    {"pieces": ["ride"],         "label": "Ri"},
    {"pieces": ["ride_bell"],    "label": "Ri-B"},
    {"pieces": ["bell"],         "label": "Bl"},
    {"pieces": ["crash_r"],      "label": "Cr-R"},
    {"pieces": ["kick"],         "label": "Ki"},
]

PRESETS: dict[str, list[dict]] = {
    "rb4":            PRESET_RB4,
    "phase_shift_8":  PRESET_PHASESHIFT8,
    "ekit_full":      PRESET_EKIT_FULL,
}


# ── drum_tab.json schema helpers ──────────────────────────────────────────────

# Default velocity when a hit omits `v`. Matches spec §5.3 ("v is optional,
# defaults to 100 — keeps simple charts terse").
DEFAULT_VELOCITY = 100

# Current `version` written by importers. Readers MUST accept any version they
# recognise; an unknown version is logged at DEBUG level on every call to
# validate_drum_tab() and the payload is still passed
# through (per Principle IV, additive evolution).
SCHEMA_VERSION = 1


def validate_drum_tab(data: object) -> tuple[bool, str]:
    """Light schema check for a parsed `drum_tab.json` payload.

    Returns `(ok, reason)`. Accepts both `version: 1` (current) and absent
    `version` (treat as 1) for forward-compat with hand-edited tabs.
    `hits[]` is required and must be a list; individual hits are NOT
    validated here — per-hit filtering happens in `hit_to_wire()` /
    `hits_to_wire()` at WS-stream time, so a single malformed hit cannot
    disqualify the whole tab.
    """
    if not isinstance(data, dict):
        return False, "drum_tab payload must be a JSON object"
    hits = data.get("hits")
    if not isinstance(hits, list):
        return False, "drum_tab.hits must be a list"
    kit = data.get("kit", [])
    if kit is not None and not isinstance(kit, list):
        return False, "drum_tab.kit must be a list (or omitted)"
    ver = data.get("version", SCHEMA_VERSION)
    if isinstance(ver, bool) or not isinstance(ver, int):
        return False, "drum_tab.version must be an integer"
    if ver != SCHEMA_VERSION:
        log.debug("drum_tab: unknown schema version %r — passing through", ver)
    return True, ""


def hit_to_wire(hit: dict) -> dict | None:
    """Normalise one hit dict into the short-key wire form streamed by
    `/ws/highway/{filename}`. Returns None on a malformed hit (missing `t`
    or `p`) so the loader can drop just that entry without aborting the
    whole tab.

    Wire keys (all optional except `t`, `p`):
        t  float seconds      required, monotonic
        p  string piece-id    required, free-form (validated against PIECES
                              by the client; unknown ids render as `"rect"`)
        v  int 1-127          velocity (omitted when absent; client defaults
                              to DEFAULT_VELOCITY)
        g  bool               ghost note
        f  bool               flam
        k  float seconds      cymbal-choke tail duration
    """
    if not isinstance(hit, dict):
        return None
    t_raw = hit.get("t")
    if isinstance(t_raw, bool):
        return None
    try:
        t = float(t_raw)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None
    if not math.isfinite(t):
        return None
    p = hit.get("p")
    if not isinstance(p, str) or not p:
        return None
    out: dict = {"t": round(t, 3), "p": p}
    v = hit.get("v")
    if not isinstance(v, bool) and isinstance(v, (int, float)) and math.isfinite(v) and 1 <= int(v) <= 127:
        out["v"] = int(v)
    if bool(hit.get("g")):
        out["g"] = True
    if bool(hit.get("f")):
        out["f"] = True
    k = hit.get("k")
    if not isinstance(k, bool) and isinstance(k, (int, float)) and math.isfinite(k) and k > 0:
        out["k"] = round(float(k), 3)
    return out


def hits_to_wire(hits: list[dict]) -> list[dict]:
    """Vectorised `hit_to_wire` — drops malformed entries, sorts by time."""
    out: list[dict] = []
    for h in hits:
        w = hit_to_wire(h)
        if w is not None:
            out.append(w)
    out.sort(key=lambda h: h["t"])
    return out


def normalise_kit(kit: list | None) -> list[dict]:
    """Normalise the `kit[]` legend: each entry becomes `{"id": str, "name":
    str}`. Unknown piece-ids are kept (forward-compat) with a title-cased
    fallback name. Returns an empty list for missing/empty kit (the client
    will derive the kit from the union of `hits[].p` in that case)."""
    if not isinstance(kit, list):
        return []
    out: list[dict] = []
    seen: set[str] = set()
    for entry in kit:
        if not isinstance(entry, dict):
            continue
        pid = entry.get("id")
        if not isinstance(pid, str) or not pid or pid in seen:
            continue
        seen.add(pid)
        name = entry.get("name")
        if not isinstance(name, str) or not name:
            name = pid.replace("_", " ").title()
        out.append({"id": pid, "name": name})
    return out


# ── Device kit records (INIT-001/SPEC-001) ────────────────────────────────────
#
# Additive overlay on midi_to_piece(). A kit remaps device MIDI notes onto
# PIECES ids. kit=None is byte-identical to today's GM table. User kits later
# live under {config_dir}/drums/ (SPEC-002); this module only reads directories
# it is handed.

# Bundled presets. Callers that want the shipped set pass this path as
# shipped_dir — this module does not scan it at import time.
SHIPPED_KITS_DIR = Path(__file__).resolve().parent.parent / "data" / "drums" / "kits"

# Prototype-pollution keys. json.loads will happily create them as ordinary
# dict keys; if that dict is later serialized to a JS client they become
# setters. Strip on every load, never raise.
_DANGEROUS_KIT_KEYS = frozenset({"__proto__", "constructor", "prototype"})

# Closed hi-hat when CC value is at or above this. MIDI midpoint; a kit may
# later carry its own threshold, but the shipped schema has no such field.
_HH_CC_CLOSED_AT = 64

_HH_STRIKE_IDS = frozenset({"hh_open", "hh_closed"})


def _strip_dangerous_keys(obj: object) -> object:
    """Drop __proto__/constructor/prototype keys at every dict level."""
    if not isinstance(obj, dict):
        return obj
    return {
        k: _strip_dangerous_keys(v)
        for k, v in obj.items()
        if k not in _DANGEROUS_KIT_KEYS
    }


def _kit_id_ok(kit_id: object) -> bool:
    """Reject ids that cannot be used as a filename (SPEC-002 consumes them)."""
    if not isinstance(kit_id, str) or not kit_id:
        return False
    if "\x00" in kit_id:
        return False
    if "/" in kit_id or "\\" in kit_id:
        return False
    if ".." in kit_id:
        return False
    return True


def _parse_note_key(raw) -> int | None:
    if isinstance(raw, bool):
        return None
    try:
        note = int(raw)
    except (TypeError, ValueError):
        return None
    if not 0 <= note <= 127:
        return None
    return note


def _normalise_hihat(raw: object) -> dict:
    if not isinstance(raw, dict):
        return {
            "pedal_cc": None,
            "open": "hh_open",
            "closed": "hh_closed",
            "pedal": "hh_pedal",
        }
    out = {
        "pedal_cc": None,
        "open": "hh_open",
        "closed": "hh_closed",
        "pedal": "hh_pedal",
    }
    cc = raw.get("pedal_cc")
    if not isinstance(cc, bool) and isinstance(cc, int):
        out["pedal_cc"] = cc
    for field in ("open", "closed", "pedal"):
        val = raw.get(field)
        if isinstance(val, str) and val in PIECES:
            out[field] = val
    return out


def _parse_kit(obj: object) -> dict | None:
    """Turn a parsed JSON object into a kit record, or None if unusable."""
    if not isinstance(obj, dict):
        return None
    cleaned = _strip_dangerous_keys(obj)
    if not isinstance(cleaned, dict):
        return None
    kit_id = cleaned.get("id")
    if not _kit_id_ok(kit_id):
        log.warning("kit: rejecting record with unsafe or missing id %r", kit_id)
        return None
    name = cleaned.get("name")
    if not isinstance(name, str) or not name:
        name = kit_id
    notes_raw = cleaned.get("notes", {})
    if notes_raw is None:
        notes_raw = {}
    if not isinstance(notes_raw, dict):
        log.warning("kit %s: notes is not an object — skipping", kit_id)
        return None
    notes: dict[int, str] = {}
    for key, piece in notes_raw.items():
        note = _parse_note_key(key)
        if note is None:
            continue
        if not isinstance(piece, str) or piece not in PIECES:
            log.debug("kit %s: ignoring unmapped piece-id %r for note %s", kit_id, piece, note)
            continue
        notes[note] = piece
    verified = cleaned.get("verified")
    if not isinstance(verified, bool):
        verified = False
    manufacturer = cleaned.get("manufacturer")
    if not isinstance(manufacturer, str) or not manufacturer:
        manufacturer = None
    source = cleaned.get("source")
    if not isinstance(source, str) or not source:
        source = None
    return {
        "id": kit_id,
        "name": name,
        "manufacturer": manufacturer,
        "verified": verified,
        "notes": notes,
        "hihat": _normalise_hihat(cleaned.get("hihat")),
        "source": source,
    }


def load_kit_file(data: bytes | str | Path) -> dict | None:
    """Parse one kit JSON document. Returns None on a malformed or unsafe record.

    Accepts the bytes (or text) of the file, or a Path to read. Path
    containment of *which* file is SPEC-002's job; this function still
    ignores a non-dict root and strips prototype-pollution keys.
    """
    if isinstance(data, Path):
        try:
            payload = data.read_bytes()
        except OSError as exc:
            log.warning("kit: failed to read %s: %s", data, exc)
            return None
    else:
        payload = data
    try:
        obj = json.loads(payload)
    except (TypeError, ValueError, json.JSONDecodeError) as exc:
        log.warning("kit: invalid JSON (%s)", exc)
        return None
    return _parse_kit(obj)


def _load_dir(directory: Path | None, into: dict[str, dict]) -> None:
    if directory is None:
        return
    try:
        path = Path(directory)
    except TypeError:
        return
    if not path.is_dir():
        return
    try:
        files = sorted(path.glob("*.json"))
    except OSError as exc:
        log.warning("kit: cannot list %s: %s", path, exc)
        return
    for f in files:
        kit = load_kit_file(f)
        if kit is None:
            continue
        into[kit["id"]] = kit


def load_kits(shipped_dir: Path | None, user_dir: Path | None = None) -> dict[str, dict]:
    """Load shipped kits, then overlay user kits keyed by ``id``.

    A user kit with the same id replaces the shipped one. Each malformed
    file is skipped (warning) so one bad JSON cannot hide the rest.
    """
    out: dict[str, dict] = {}
    _load_dir(shipped_dir, out)
    _load_dir(user_dir, out)
    return out


def _hh_piece_ids(kit: dict | None) -> tuple[str, str, str]:
    hihat = kit.get("hihat") if isinstance(kit, dict) else None
    if not isinstance(hihat, dict):
        return "hh_open", "hh_closed", "hh_pedal"
    open_id = hihat.get("open") if hihat.get("open") in PIECES else "hh_open"
    closed_id = hihat.get("closed") if hihat.get("closed") in PIECES else "hh_closed"
    pedal_id = hihat.get("pedal") if hihat.get("pedal") in PIECES else "hh_pedal"
    return open_id, closed_id, pedal_id


def _lookup_kit_note(kit: dict | None, note: int) -> str | None:
    if not isinstance(kit, dict):
        return None
    notes = kit.get("notes")
    if not isinstance(notes, dict):
        return None
    piece = notes.get(note)
    if piece is None:
        piece = notes.get(str(note))
    if isinstance(piece, str) and piece in PIECES:
        return piece
    return None


def _apply_hh_pedal(note: int, mapped: str | None, kit: dict | None, hh_pedal: object) -> str | None:
    """Resolve a hat strike against live pedal state. Omitted state is a no-op."""
    if not isinstance(hh_pedal, dict):
        return mapped
    open_id, closed_id, pedal_id = _hh_piece_ids(kit)
    strike_ids = _HH_STRIKE_IDS | {open_id, closed_id}
    kind = hh_pedal.get("kind")
    if kind == "note":
        try:
            pedal_note = int(hh_pedal.get("midi"))
        except (TypeError, ValueError):
            return mapped
        if note == pedal_note:
            return pedal_id
        return mapped
    if kind == "cc":
        if mapped not in strike_ids:
            return mapped
        try:
            value = int(hh_pedal.get("value"))
        except (TypeError, ValueError):
            return mapped
        hihat = kit.get("hihat") if isinstance(kit, dict) else None
        want_cc = hihat.get("pedal_cc") if isinstance(hihat, dict) else None
        got_cc = hh_pedal.get("controller")
        if want_cc is not None and got_cc is not None:
            try:
                if int(got_cc) != int(want_cc):
                    return mapped
            except (TypeError, ValueError):
                pass
        return closed_id if value >= _HH_CC_CLOSED_AT else open_id
    return mapped


def note_to_piece(midi, *, kit=None, hh_pedal=None) -> str | None:
    """Resolve a device MIDI note to a canonical PIECES id.

    With ``kit=None`` this is identical to ``midi_to_piece``. A kit's
    ``notes`` map wins for listed notes; anything else falls through to GM.
    ``hh_pedal`` is either ``{kind: "cc", controller, value}`` or
    ``{kind: "note", midi}``. When it is omitted, a hat strike still returns
    whatever piece the note already mapped to.
    """
    if isinstance(midi, bool):
        return None
    try:
        note = int(midi)
    except (TypeError, ValueError):
        return None
    mapped = _lookup_kit_note(kit, note)
    if mapped is None:
        mapped = midi_to_piece(note)
    return _apply_hh_pedal(note, mapped, kit, hh_pedal)
