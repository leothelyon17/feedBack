"""MIDI device instance documents under {config_dir}/midi/devices/.

A device is a detected port + chosen type + user map + input knobs.
Profiles attach via device_id. Notes default to {} — never seeded from
GM or a shipped kit. INIT-003/SPEC-008.
"""

from __future__ import annotations

import json
import logging
import os
import re
import tempfile
import threading
from pathlib import Path

from drums import PIECES, _parse_note_key, load_kits
from midi_device_types import (
    DEVICE_TYPE_ID_RE,
    FAMILIES,
    SHIPPED_DEVICE_TYPES_DIR,
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


def _normalise_notes(raw: object) -> dict | None:
    """User map only. Missing/None → {}. Never fills GM or kit defaults."""
    if raw is None:
        return {}
    if not isinstance(raw, dict):
        return None
    out: dict[str, str] = {}
    for key, piece in raw.items():
        note = _parse_note_key(key)
        if note is None:
            continue
        if not isinstance(piece, str) or piece not in PIECES:
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
    Empty notes is valid. INIT-003/SPEC-008.
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
    notes = _normalise_notes(obj.get("notes"))
    if notes is None:
        return None, "notes must be an object"
    inp = _normalise_input(obj.get("input"))
    if inp is None:
        return None, "input must be an object"
    canonical = {
        "id": did,
        "name": name.strip(),
        "source_id": source_id,
        "device_type_id": catalog["id"],
        "family": family,
        "notes": notes,
        "input": inp,
    }
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
    """Validate and atomically write a device. Notes default to {}."""
    canonical, err = validate_device(obj, device_id, config_dir=config_dir)
    if canonical is None:
        return None, err
    dest = device_path(config_dir, canonical["id"])
    if dest is None:
        return None, "device id rejected by path containment"
    payload = json.dumps(canonical, indent=2).encode("utf-8")
    if len(payload) > _DEVICE_BODY_MAX:
        return None, "device body exceeds 64 KiB"
    with _device_lock:
        root = devices_dir(config_dir)
        exists = dest.is_file()
        if not exists and root.is_dir() and _json_file_count(root) >= _DEVICE_COUNT_MAX:
            return None, "device count cap reached"
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

    Never copies shipped-kit notes, even when the type slug matches a
    kit under data/drums/kits/. INIT-003/SPEC-008 ac-3.
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
