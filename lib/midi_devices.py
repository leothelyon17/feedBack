"""MIDI device instance documents under {config_dir}/midi/devices/.

A device is a detected port + chosen type + user map + input knobs.
Profiles attach via device_id. Notes default to {} — never seeded from
GM or a shipped kit. Triggers copy from the catalog at create-from-type,
then live on the instance. INIT-003/SPEC-008.
"""

from __future__ import annotations

import json
import logging
import math
import os
import re
import tempfile
import threading
from pathlib import Path

from drums import _parse_note_key, load_kits
from midi_device_types import (
    DEVICE_TYPE_ID_RE,
    FAMILIES,
    SHIPPED_DEVICE_TYPES_DIR,
    TRIGGER_ID_RE,
    _parse_trigger,
    device_types_dir,
    load_device_type,
    load_device_types,
)
from safepath import safe_join

log = logging.getLogger("feedBack.lib.midi_devices")

DEVICE_ID_RE = DEVICE_TYPE_ID_RE
# Logical midi-input id: `web-midi::pad-1` or a bare slug. Empty string allowed.
# Rejects raw port labels (spaces, parentheses, MIDIIN2 (Foo)).
_SOURCE_ID_RE = re.compile(r"^[a-z0-9][a-z0-9._-]*(::[a-z0-9._-]+)*$")

_DANGEROUS_KEYS = frozenset({"__proto__", "constructor", "prototype"})
_DEVICE_BODY_MAX = 64 * 1024
_DEVICE_COUNT_MAX = 64
_MIGRATE_SENTINEL_NAME = "overlay-kit-notes-migrated"
# INIT-004/SPEC-006: optional Calibration persist on the device document.
# INIT-006/SPEC-005: optional profiles[] + audio_latency_hint_ms.
_TIMING_OFFSET_MIN_MS = -250.0
_TIMING_OFFSET_MAX_MS = 250.0
_TIMING_BACKENDS = frozenset({"html5", "juce"})
_TIMING_PROFILE_KEYS = ("origin", "audio_backend", "offset_ms")
_TIMING_CANONICAL_KEYS = (
    "offset_ms",
    "measured_at",
    "n",
    "median_abs_error_ms",
    "origin",
    "audio_backend",
    "profiles",
    "audio_latency_hint_ms",
)

_DEFAULT_INPUT = {
    "midi_channel": -1,
    "hit_detection": False,
    "synth_volume": 0.7,
}

_device_lock = threading.Lock()


def devices_dir(config_dir: Path) -> Path:
    """Instance root: {config_dir}/midi/devices/."""
    return Path(config_dir) / "midi" / "devices"


def device_path(config_dir: Path, device_id: str) -> Path | None:
    """Resolve `{id}.json` under midi/devices/. None on slug or escape."""
    if not isinstance(device_id, str) or not DEVICE_ID_RE.fullmatch(device_id):
        return None
    return safe_join(devices_dir(config_dir), device_id + ".json")


def migrate_sentinel_path(config_dir: Path) -> Path:
    """Flag file under {config_dir}/midi/ so overlay-kit migrate runs once."""
    return Path(config_dir) / "midi" / _MIGRATE_SENTINEL_NAME


def _has_dangerous_keys(obj: object) -> bool:
    if isinstance(obj, dict):
        if _DANGEROUS_KEYS.intersection(obj):
            return True
        return any(_has_dangerous_keys(v) for v in obj.values())
    if isinstance(obj, list):
        return any(_has_dangerous_keys(v) for v in obj)
    return False


def _source_id_ok(raw: object) -> bool:
    if not isinstance(raw, str):
        return False
    if raw == "":
        return True
    if any(ch.isspace() for ch in raw) or "(" in raw or ")" in raw:
        return False
    return _SOURCE_ID_RE.fullmatch(raw) is not None


def _as_bool(raw: object, default: bool) -> bool:
    return raw if isinstance(raw, bool) else default


def _as_channel(raw: object) -> int:
    if isinstance(raw, bool) or not isinstance(raw, int):
        return -1
    if raw < -1:
        return -1
    if raw > 15:
        return 15
    return raw


def _as_volume(raw: object) -> float:
    if isinstance(raw, bool) or not isinstance(raw, (int, float)):
        return 0.7
    n = float(raw)
    if n < 0:
        return 0.0
    if n > 1:
        return 1.0
    return n


def _normalise_input(raw: object) -> dict | None:
    if raw is None:
        return dict(_DEFAULT_INPUT)
    if not isinstance(raw, dict):
        return None
    return {
        "midi_channel": _as_channel(raw.get("midi_channel")),
        "hit_detection": _as_bool(raw.get("hit_detection"), False),
        "synth_volume": _as_volume(raw.get("synth_volume")),
    }


def _finite_number(raw: object) -> float | None:
    """True numeric value. Rejects bool, NaN, Inf, and non-numbers."""
    if isinstance(raw, bool) or not isinstance(raw, (int, float)):
        return None
    n = float(raw)
    if not math.isfinite(n):
        return None
    return n


def _clamp_timing_offset(offset: float) -> float:
    if offset < _TIMING_OFFSET_MIN_MS:
        return _TIMING_OFFSET_MIN_MS
    if offset > _TIMING_OFFSET_MAX_MS:
        return _TIMING_OFFSET_MAX_MS
    return offset


def _timing_origin(raw: object) -> str | None:
    if not isinstance(raw, str) or not raw.strip():
        return None
    return raw.strip()


def _profile_row(origin: str, audio_backend: str, offset_ms: float) -> dict:
    return {
        "origin": origin,
        "audio_backend": audio_backend,
        "offset_ms": _clamp_timing_offset(offset_ms),
    }


def _cache_as_profile(timing: dict) -> dict | None:
    """Build a profile row from a pre-INIT-006 offset_ms + tag cache."""
    origin = _timing_origin(timing.get("origin"))
    backend = timing.get("audio_backend")
    offset = _finite_number(timing.get("offset_ms"))
    if origin is None or backend not in _TIMING_BACKENDS or offset is None:
        return None
    return _profile_row(origin, backend, offset)


def _dedupe_profiles(rows: list[dict]) -> list[dict]:
    """Last value wins per {origin, audio_backend}; first-seen order."""
    latest: dict[tuple[str, str], dict] = {}
    order: list[tuple[str, str]] = []
    for row in rows:
        key = (row["origin"], row["audio_backend"])
        if key not in latest:
            order.append(key)
        latest[key] = row
    return [latest[key] for key in order]


def _parse_timing_profile(raw: object) -> dict | None:
    """One {origin, audio_backend, offset_ms} row, or None to skip."""
    if not isinstance(raw, dict) or _has_dangerous_keys(raw):
        return None
    origin = _timing_origin(raw.get("origin"))
    backend = raw.get("audio_backend")
    offset = _finite_number(raw.get("offset_ms"))
    if origin is None or backend not in _TIMING_BACKENDS or offset is None:
        return None
    return _profile_row(origin, backend, offset)


def _parse_timing_profiles(raw: object) -> tuple[list[dict] | None, str | None]:
    """Canonical profile list. None list means the key was omitted."""
    if raw is None:
        return None, None
    if not isinstance(raw, list):
        return None, "timing.profiles must be a list"
    parsed: list[dict] = []
    for item in raw:
        row = _parse_timing_profile(item)
        if row is not None:
            parsed.append(row)
    return _dedupe_profiles(parsed), None


def _lookup_profile(profiles: list[dict], origin: str, audio_backend: str) -> dict | None:
    for row in profiles:
        if row["origin"] == origin and row["audio_backend"] == audio_backend:
            return row
    return None


def active_timing_profile(
    timing: dict | None,
    origin: str | None = None,
    audio_backend: str | None = None,
) -> dict | None:
    """Matching profile, or the cached offset_ms + tag as the active one.

    Old files with only offset_ms + tag report that cache as the active
    profile. Lookup is by {origin, audio_backend}. INIT-006/SPEC-005.
    """
    if not isinstance(timing, dict):
        return None
    want_origin = _timing_origin(origin if origin is not None else timing.get("origin"))
    want_backend = audio_backend if audio_backend is not None else timing.get("audio_backend")
    profiles_raw = timing.get("profiles")
    if isinstance(profiles_raw, list) and profiles_raw:
        if want_origin is None or want_backend not in _TIMING_BACKENDS:
            return None
        match = _lookup_profile(profiles_raw, want_origin, want_backend)
        return dict(match) if match is not None else None
    cache = _cache_as_profile(timing)
    if cache is None:
        offset = _finite_number(timing.get("offset_ms"))
        if offset is None:
            return None
        out = {"offset_ms": _clamp_timing_offset(offset)}
        cache_origin = _timing_origin(timing.get("origin"))
        cache_backend = timing.get("audio_backend")
        if origin is not None and cache_origin is not None and cache_origin != origin:
            return None
        if audio_backend is not None and cache_backend in _TIMING_BACKENDS and cache_backend != audio_backend:
            return None
        if cache_origin is not None:
            out["origin"] = cache_origin
        elif want_origin is not None:
            out["origin"] = want_origin
        if cache_backend in _TIMING_BACKENDS:
            out["audio_backend"] = cache_backend
        elif want_backend in _TIMING_BACKENDS:
            out["audio_backend"] = want_backend
        return out
    if origin is not None and cache["origin"] != origin:
        return None
    if audio_backend is not None and cache["audio_backend"] != audio_backend:
        return None
    return dict(cache)


def upsert_timing_profile(
    timing: dict | None,
    *,
    origin: str,
    audio_backend: str,
    offset_ms: float,
) -> tuple[dict | None, str | None]:
    """Save this topology; keep other profiles; cache becomes this offset.

    Does not add audio_latency_hint_ms into offset_ms. INIT-006/SPEC-005.
    """
    base = dict(timing) if isinstance(timing, dict) else {}
    profiles_raw, err = _parse_timing_profiles(base.get("profiles"))
    if err is not None:
        return None, err
    rows = list(profiles_raw) if profiles_raw else []
    prior = _cache_as_profile(base)
    if prior is not None:
        rows.append(prior)
    rows.append(_profile_row(origin, audio_backend, offset_ms))
    base["profiles"] = _dedupe_profiles(rows)
    base["offset_ms"] = offset_ms
    base["origin"] = origin
    base["audio_backend"] = audio_backend
    return _normalise_timing(base)


def select_timing_profile(
    timing: dict,
    origin: str,
    audio_backend: str,
) -> dict | None:
    """Switch the active cache to the matching profile. Others stay.

    None if no match — does not wipe the set. INIT-006/SPEC-005.
    """
    match = active_timing_profile(timing, origin, audio_backend)
    if match is None or "offset_ms" not in match or "origin" not in match:
        return None
    if match.get("audio_backend") not in _TIMING_BACKENDS:
        return None
    next_raw = dict(timing) if isinstance(timing, dict) else {}
    next_raw["offset_ms"] = match["offset_ms"]
    next_raw["origin"] = match["origin"]
    next_raw["audio_backend"] = match["audio_backend"]
    if "profiles" not in next_raw:
        cache = _cache_as_profile(timing) if isinstance(timing, dict) else None
        rows = [cache] if cache is not None else []
        rows.append(dict(match))
        next_raw["profiles"] = _dedupe_profiles([r for r in rows if r is not None])
    canonical, err = _normalise_timing(next_raw)
    return canonical if err is None else None


def _merge_timing_profiles(prior: dict, incoming: dict) -> dict:
    """Keep prior topologies when a second {origin, audio_backend} is saved."""
    rows: list[dict] = []
    prior_rows, _ = _parse_timing_profiles(prior.get("profiles"))
    if prior_rows:
        rows.extend(prior_rows)
    else:
        cache = _cache_as_profile(prior)
        if cache is not None:
            rows.append(cache)
    incoming_rows, _ = _parse_timing_profiles(incoming.get("profiles"))
    if incoming_rows:
        rows.extend(incoming_rows)
    incoming_cache = _cache_as_profile(incoming)
    if incoming_cache is not None:
        rows.append(incoming_cache)
    out = dict(incoming)
    merged = _dedupe_profiles(rows)
    if merged:
        out["profiles"] = merged
    else:
        out.pop("profiles", None)
    return {key: out[key] for key in _TIMING_CANONICAL_KEYS if key in out}


def _normalise_timing(raw: object) -> tuple[dict | None, str | None]:
    """Canonical timing or None (Not set). Error string on reject.

    None / {} → Not set (not +0). offset_ms is clamped to [-250, 250].
    Extra keys are dropped. Optional profiles[] and audio_latency_hint_ms
    (INIT-006/SPEC-005). The hint never folds into offset_ms. INIT-004/SPEC-006.
    """
    if raw is None:
        return None, None
    if not isinstance(raw, dict):
        return None, "timing must be an object"
    if _has_dangerous_keys(raw):
        return None, "timing contains reserved keys"
    if not raw:
        return None, None
    profiles, profiles_err = _parse_timing_profiles(raw.get("profiles"))
    if profiles_err is not None:
        return None, profiles_err
    hint_present = "audio_latency_hint_ms" in raw and raw.get("audio_latency_hint_ms") is not None
    hint = None
    if hint_present:
        hint = _finite_number(raw.get("audio_latency_hint_ms"))
        if hint is None:
            return None, "timing.audio_latency_hint_ms must be a finite number"
    offset = _finite_number(raw.get("offset_ms"))
    backend = raw.get("audio_backend")
    origin = raw.get("origin")
    if origin is not None:
        if not isinstance(origin, str) or not origin.strip():
            return None, "timing.origin must be a non-empty string"
        origin = origin.strip()
    if offset is None and profiles:
        match = None
        if origin is not None and backend in _TIMING_BACKENDS:
            match = _lookup_profile(profiles, origin, backend)
        if match is None:
            match = profiles[0]
        offset = match["offset_ms"]
        if origin is None:
            origin = match["origin"]
        if backend not in _TIMING_BACKENDS:
            backend = match["audio_backend"]
    if offset is None:
        return None, "timing.offset_ms must be a finite number"
    offset = _clamp_timing_offset(offset)
    if backend not in _TIMING_BACKENDS:
        return None, "timing.audio_backend must be html5 or juce"
    out: dict = {
        "offset_ms": offset,
        "audio_backend": backend,
    }
    measured_at = raw.get("measured_at")
    if measured_at is not None:
        if not isinstance(measured_at, str):
            return None, "timing.measured_at must be a string"
        out["measured_at"] = measured_at
    n_raw = raw.get("n")
    if n_raw is not None:
        if isinstance(n_raw, bool) or not isinstance(n_raw, int) or n_raw < 0:
            return None, "timing.n must be a non-negative integer"
        out["n"] = n_raw
    if "median_abs_error_ms" in raw and raw.get("median_abs_error_ms") is not None:
        mae = _finite_number(raw.get("median_abs_error_ms"))
        if mae is None:
            return None, "timing.median_abs_error_ms must be a finite number"
        out["median_abs_error_ms"] = mae
    if origin is not None:
        out["origin"] = origin
    if profiles:
        if origin is not None:
            profiles = _dedupe_profiles(profiles + [_profile_row(origin, backend, offset)])
        out["profiles"] = profiles
    if hint is not None:
        # Stored beside the composite; never added into offset_ms.
        out["audio_latency_hint_ms"] = hint
    return {key: out[key] for key in _TIMING_CANONICAL_KEYS if key in out}, None


def _copy_trigger_rows(rows: object) -> list[dict]:
    """Canonical trigger rows via the catalog parser. Skip bad rows."""
    out: list[dict] = []
    if not isinstance(rows, list):
        return out
    for raw in rows:
        parsed = _parse_trigger(raw)
        if not isinstance(parsed, dict):
            continue
        out.append(dict(parsed))
    return out


def _canonical_triggers(raw: object, catalog: dict) -> tuple[list[dict] | None, str | None]:
    """Omitted/null → catalog copy. Present list → parse; empty allowed."""
    if raw is None:
        return [dict(row) for row in catalog.get("triggers") or []], None
    if not isinstance(raw, list):
        return None, "triggers must be a list"
    return _copy_trigger_rows(raw), None


def _trigger_ids(triggers: list[dict]) -> set[str]:
    return {row["id"] for row in triggers if isinstance(row.get("id"), str)}


def _normalise_notes(raw: object, allowed_ids: set[str] | None = None) -> dict | None:
    """User map only. Missing/None → {}. Never fills GM or kit defaults.

    Piece ids must match TRIGGER_ID_RE and, when allowed_ids is given, sit
    on this device's trigger list — not drums.PIECES.
    """
    if raw is None:
        return {}
    if not isinstance(raw, dict):
        return None
    out: dict[str, str] = {}
    for key, piece in raw.items():
        note = _parse_note_key(key)
        if note is None:
            continue
        if not isinstance(piece, str) or not TRIGGER_ID_RE.fullmatch(piece):
            continue
        if allowed_ids is not None and piece not in allowed_ids:
            continue
        out[str(note)] = piece
    return out


def _notes_from_kit(kit_notes: object) -> dict[str, str]:
    """Copy overlay-kit notes (int or str keys) into the device map shape."""
    normalised = _normalise_notes(kit_notes if isinstance(kit_notes, dict) else {})
    return normalised if normalised is not None else {}


def validate_device(
    obj: object,
    device_id: str | None = None,
    *,
    config_dir: Path | None = None,
) -> tuple[dict | None, str | None]:
    """Validate a device document. Returns (canonical, error).

    Refuses raw MIDI port labels on source_id, unknown device_type_id,
    family mismatch vs the catalog, reserved keys, and a notes seed.
    Empty notes is valid. Omitted triggers default to a catalog copy so
    old on-disk devices keep loading. Optional timing is omitted when
    unset (not +0). INIT-003/SPEC-008, INIT-004/SPEC-006, INIT-006/SPEC-005.
    """
    if not isinstance(obj, dict):
        return None, "device body must be an object"
    if _has_dangerous_keys(obj):
        return None, "device body contains reserved keys"
    did = obj.get("id")
    if device_id is not None:
        did = device_id
    if not isinstance(did, str) or not DEVICE_ID_RE.fullmatch(did):
        return None, "device id must match [a-z0-9-]+"
    name = obj.get("name")
    if not isinstance(name, str) or not name.strip():
        return None, "name must be a non-empty string"
    source_id = obj.get("source_id", "")
    if source_id is None:
        source_id = ""
    if not _source_id_ok(source_id):
        return None, "source_id must be a logical midi-input id"
    type_id = obj.get("device_type_id")
    if not isinstance(type_id, str) or not DEVICE_TYPE_ID_RE.fullmatch(type_id):
        return None, "device_type_id must match [a-z0-9-]+"
    catalog = load_device_type(type_id, config_dir=config_dir)
    if catalog is None:
        return None, "device_type_id must name a catalog type"
    family = obj.get("family")
    if family not in FAMILIES:
        return None, "family must be drums|keys|other"
    if family != catalog["family"]:
        return None, "family must match the catalog type"
    triggers, trigger_err = _canonical_triggers(obj.get("triggers"), catalog)
    if triggers is None:
        return None, trigger_err
    notes = _normalise_notes(obj.get("notes"), _trigger_ids(triggers))
    if notes is None:
        return None, "notes must be an object"
    inp = _normalise_input(obj.get("input"))
    if inp is None:
        return None, "input must be an object"
    timing = None
    if "timing" in obj:
        timing, timing_err = _normalise_timing(obj.get("timing"))
        if timing_err is not None:
            return None, timing_err
    canonical = {
        "id": did,
        "name": name.strip(),
        "source_id": source_id,
        "device_type_id": catalog["id"],
        "family": family,
        "notes": notes,
        "triggers": triggers,
        "input": inp,
    }
    if timing is not None:
        canonical["timing"] = timing
    return canonical, None


def load_device_file(
    data: bytes | str | Path,
    *,
    config_dir: Path | None = None,
) -> dict | None:
    """Parse one device JSON document. None on malformed / rejected records."""
    if isinstance(data, Path):
        try:
            payload = data.read_bytes()
        except OSError as exc:
            log.warning("device: failed to read %s: %s", data, exc)
            return None
    else:
        payload = data
    if isinstance(payload, str):
        payload = payload.encode("utf-8")
    if len(payload) > _DEVICE_BODY_MAX:
        log.warning("device: body exceeds 64 KiB")
        return None
    try:
        obj = json.loads(payload)
    except (TypeError, ValueError, json.JSONDecodeError) as exc:
        log.warning("device: invalid JSON (%s)", exc)
        return None
    canonical, err = validate_device(obj, config_dir=config_dir)
    if canonical is None:
        log.warning("device: rejected (%s)", err)
        return None
    return canonical


def _atomic_write(path: Path, payload: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(
        dir=str(path.parent), prefix=path.name + ".", suffix=".tmp",
    )
    tmp = Path(tmp_name)
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(payload)
        os.replace(tmp, path)
    except Exception:
        try:
            tmp.unlink()
        except OSError:
            pass
        raise


def _json_file_count(root: Path) -> int:
    try:
        return sum(1 for f in root.glob("*.json") if f.is_file())
    except OSError as exc:
        log.warning("device: cannot list %s: %s", root, exc)
        return 0


def list_devices(config_dir: Path) -> list[dict]:
    """Load every valid device under midi/devices/. Skip corrupt files."""
    root = devices_dir(config_dir)
    if not root.is_dir():
        return []
    out: list[dict] = []
    try:
        files = sorted(root.glob("*.json"))
    except OSError as exc:
        log.warning("device: cannot list %s: %s", root, exc)
        return []
    for f in files:
        contained = safe_join(root, f.name)
        if contained is None or not contained.is_file():
            continue
        parsed = load_device_file(contained, config_dir=config_dir)
        if parsed is None:
            continue
        out.append(parsed)
    return out


def load_device(config_dir: Path, device_id: str) -> dict | None:
    dest = device_path(config_dir, device_id)
    if dest is None or not dest.is_file():
        return None
    return load_device_file(dest, config_dir=config_dir)


def save_device(
    config_dir: Path,
    obj: dict,
    device_id: str | None = None,
) -> tuple[dict | None, str | None]:
    """Validate and atomically write a device. Notes default to {}.

    Omitted `timing` on an existing file preserves on-disk timing.
    Explicit `timing: null` (or `{}`) clears. Create-with-omit writes
    no key. A second {origin, audio_backend} merges into profiles and
    keeps the first. INIT-004/SPEC-006, INIT-006/SPEC-005.
    """
    incoming_omits_timing = isinstance(obj, dict) and "timing" not in obj
    canonical, err = validate_device(obj, device_id, config_dir=config_dir)
    if canonical is None:
        return None, err
    dest = device_path(config_dir, canonical["id"])
    if dest is None:
        return None, "device id rejected by path containment"
    with _device_lock:
        root = devices_dir(config_dir)
        exists = dest.is_file()
        if not exists and root.is_dir() and _json_file_count(root) >= _DEVICE_COUNT_MAX:
            return None, "device count cap reached"
        prior = None
        if exists:
            prior = load_device_file(dest, config_dir=config_dir)
        if incoming_omits_timing and prior is not None and "timing" in prior:
            canonical = dict(canonical)
            canonical["timing"] = prior["timing"]
        elif (
            not incoming_omits_timing
            and "timing" in canonical
            and prior is not None
            and "timing" in prior
        ):
            canonical = dict(canonical)
            canonical["timing"] = _merge_timing_profiles(
                prior["timing"], canonical["timing"],
            )
        payload = json.dumps(canonical, indent=2).encode("utf-8")
        if len(payload) > _DEVICE_BODY_MAX:
            return None, "device body exceeds 64 KiB"
        try:
            _atomic_write(dest, payload)
        except OSError as exc:
            log.warning("device: failed to write %s: %s", canonical["id"], exc)
            return None, "could not persist device"
    return canonical, None


def device_from_type(
    config_dir: Path,
    type_id: str,
    *,
    device_id: str,
    name: str | None = None,
    source_id: str = "",
) -> tuple[dict | None, str | None]:
    """Create a device from a catalog type with empty notes.

    Copies catalog trigger rows (id/name/zone) onto the instance. Never
    copies shipped-kit notes, even when the type slug matches a kit
    under data/drums/kits/. INIT-003/SPEC-008 ac-3.
    """
    catalog = load_device_type(type_id, config_dir=config_dir)
    if catalog is None:
        return None, "device_type_id must name a catalog type"
    draft = {
        "id": device_id,
        "name": name.strip() if isinstance(name, str) and name.strip() else catalog["name"],
        "source_id": source_id,
        "device_type_id": catalog["id"],
        "family": catalog["family"],
        "notes": {},
        "triggers": [dict(row) for row in catalog.get("triggers") or []],
        "input": dict(_DEFAULT_INPUT),
    }
    return save_device(config_dir, draft)


def _touch_migrate_sentinel(config_dir: Path) -> None:
    sentinel = migrate_sentinel_path(config_dir)
    try:
        sentinel.parent.mkdir(parents=True, exist_ok=True)
        sentinel.write_text("INIT-003/SPEC-008\n", encoding="utf-8")
    except OSError as exc:
        log.warning("device: could not write migrate sentinel: %s", exc)


def _any_device_file(config_dir: Path) -> bool:
    root = devices_dir(config_dir)
    if not root.is_dir():
        return False
    try:
        return any(f.is_file() for f in root.glob("*.json"))
    except OSError:
        return False


def _overlay_kit_with_notes(config_dir: Path) -> dict | None:
    """First user overlay kit that has notes. Never reads shipped kits."""
    user_dir = Path(config_dir) / "drums"
    overlay = load_kits(None, user_dir)
    for kit_id in sorted(overlay):
        kit = overlay[kit_id]
        notes = kit.get("notes") if isinstance(kit, dict) else None
        if isinstance(notes, dict) and notes:
            return kit
    return None


def _catalog_type_for_overlay(config_dir: Path, kit_id: str) -> dict | None:
    catalog = load_device_type(kit_id, config_dir=config_dir)
    if catalog is not None:
        return catalog
    types = load_device_types(
        SHIPPED_DEVICE_TYPES_DIR,
        device_types_dir(config_dir),
    )
    drums_types = [t for t in types.values() if t.get("family") == "drums"]
    drums_types.sort(key=lambda t: t["id"])
    return drums_types[0] if drums_types else None


def migrate_overlay_kit_notes(config_dir: Path) -> dict | None:
    """Copy notes from one user overlay kit into one new device, at most once.

    Sentinel: `{config_dir}/midi/overlay-kit-notes-migrated`. Also skips
    once any `midi/devices/*.json` exists. Never copies shipped
    `data/drums/kits/` notes (including alesis-strata-prime.json).
    INIT-003/SPEC-008 ac-6.
    """
    sentinel = migrate_sentinel_path(config_dir)
    if sentinel.is_file():
        return None
    if _any_device_file(config_dir):
        _touch_migrate_sentinel(config_dir)
        return None
    kit = _overlay_kit_with_notes(config_dir)
    if kit is None:
        _touch_migrate_sentinel(config_dir)
        return None
    catalog = _catalog_type_for_overlay(config_dir, kit["id"])
    if catalog is None:
        log.warning("device: overlay migrate skipped — no catalog type")
        _touch_migrate_sentinel(config_dir)
        return None
    kit_id = kit["id"]
    device_id = kit_id if DEVICE_ID_RE.fullmatch(kit_id) else "migrated-overlay"
    name = kit.get("name")
    draft = {
        "id": device_id,
        "name": name if isinstance(name, str) and name.strip() else device_id,
        "source_id": "",
        "device_type_id": catalog["id"],
        "family": catalog["family"],
        "notes": _notes_from_kit(kit.get("notes")),
        "input": dict(_DEFAULT_INPUT),
    }
    saved, err = save_device(config_dir, draft)
    _touch_migrate_sentinel(config_dir)
    if saved is None:
        log.warning("device: overlay migrate failed (%s)", err)
        return None
    return saved
