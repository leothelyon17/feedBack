"""MIDI device-type catalogs: pad/zone lists with no default MIDI map.

Shipped JSON lives under data/midi/device-types/. A user overlay under
{config_dir}/midi/device-types/{id}.json replaces the shipped document
for the same id. Catalogs never carry notes. INIT-003/SPEC-007.
"""

from __future__ import annotations

import json
import logging
import re
from pathlib import Path

from safepath import safe_join

log = logging.getLogger("feedBack.lib.midi_device_types")

FAMILIES = frozenset({"drums", "keys", "other"})
ZONES = frozenset({"head", "rim", "bell", "edge", "choke"})
DEVICE_TYPE_ID_RE = re.compile(r"^[a-z0-9-]+$")
TRIGGER_ID_RE = re.compile(r"^[a-z0-9_]+$")

_DANGEROUS_KEYS = frozenset({"__proto__", "constructor", "prototype"})
_MIDI_TRIGGER_KEYS = frozenset({"midi", "note", "notes", "midi_note"})
_REFUSE_MIDI = object()
_CATALOG_BODY_MAX = 64 * 1024

SHIPPED_DEVICE_TYPES_DIR = (
    Path(__file__).resolve().parent.parent / "data" / "midi" / "device-types"
)


def device_types_dir(config_dir: Path) -> Path:
    """User overlay root: {config_dir}/midi/device-types/."""
    return Path(config_dir) / "midi" / "device-types"


def device_type_path(config_dir: Path, type_id: str) -> Path | None:
    """Resolve `{id}.json` under midi/device-types/. None on slug or escape."""
    if not isinstance(type_id, str) or not DEVICE_TYPE_ID_RE.fullmatch(type_id):
        return None
    return safe_join(device_types_dir(config_dir), type_id + ".json")


def _has_dangerous_keys(obj: object) -> bool:
    if isinstance(obj, dict):
        if _DANGEROUS_KEYS.intersection(obj):
            return True
        return any(_has_dangerous_keys(v) for v in obj.values())
    if isinstance(obj, list):
        return any(_has_dangerous_keys(v) for v in obj)
    return False


def _parse_trigger(raw: object):
    """Return a canonical trigger row, None to skip, or _REFUSE_MIDI."""
    if not isinstance(raw, dict):
        return None
    if _MIDI_TRIGGER_KEYS.intersection(raw):
        return _REFUSE_MIDI
    tid = raw.get("id")
    if not isinstance(tid, str) or not TRIGGER_ID_RE.fullmatch(tid):
        return None
    name = raw.get("name")
    if not isinstance(name, str) or not name.strip():
        name = tid
    else:
        name = name.strip()
    zone = raw.get("zone")
    out = {"id": tid, "name": name}
    if zone is None:
        return out
    if not isinstance(zone, str) or zone not in ZONES:
        return None
    out["zone"] = zone
    return out


def validate_device_type(obj: object) -> dict | None:
    """Return a canonical catalog, or None if the document is unusable.

    Refuses notes, prototype-pollution keys, missing/unknown family, and
    any trigger that carries MIDI integers. Empty triggers are allowed.
    """
    if not isinstance(obj, dict):
        return None
    if _has_dangerous_keys(obj):
        log.warning("device-type: refusing document with reserved keys")
        return None
    if "notes" in obj:
        log.warning("device-type: refusing document with notes")
        return None
    type_id = obj.get("id")
    if not isinstance(type_id, str) or not DEVICE_TYPE_ID_RE.fullmatch(type_id):
        log.warning("device-type: rejecting unsafe or missing id %r", type_id)
        return None
    family = obj.get("family")
    if family not in FAMILIES:
        log.warning("device-type %s: family must be drums|keys|other", type_id)
        return None
    name = obj.get("name")
    if not isinstance(name, str) or not name.strip():
        name = type_id
    manufacturer = obj.get("manufacturer")
    if not isinstance(manufacturer, str) or not manufacturer.strip():
        manufacturer = None
    else:
        manufacturer = manufacturer.strip()
    triggers_raw = obj.get("triggers", [])
    if triggers_raw is None:
        triggers_raw = []
    if not isinstance(triggers_raw, list):
        log.warning("device-type %s: triggers is not a list — skipping", type_id)
        return None
    triggers: list[dict] = []
    for raw in triggers_raw:
        parsed = _parse_trigger(raw)
        if parsed is _REFUSE_MIDI:
            log.warning("device-type %s: refusing MIDI defaults on a trigger", type_id)
            return None
        if parsed is None:
            continue
        triggers.append(parsed)
    canonical = {
        "id": type_id,
        "name": name.strip(),
        "family": family,
        "triggers": triggers,
    }
    if manufacturer is not None:
        canonical["manufacturer"] = manufacturer
    return canonical


def load_device_type_file(data: bytes | str | Path) -> dict | None:
    """Parse one catalog JSON document. None on malformed or refused records."""
    if isinstance(data, Path):
        try:
            payload = data.read_bytes()
        except OSError as exc:
            log.warning("device-type: failed to read %s: %s", data, exc)
            return None
    else:
        payload = data
    if isinstance(payload, str):
        payload = payload.encode("utf-8")
    if len(payload) > _CATALOG_BODY_MAX:
        log.warning("device-type: body exceeds 64 KiB")
        return None
    try:
        obj = json.loads(payload)
    except (TypeError, ValueError, json.JSONDecodeError) as exc:
        log.warning("device-type: invalid JSON (%s)", exc)
        return None
    return validate_device_type(obj)


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
        log.warning("device-type: cannot list %s: %s", path, exc)
        return
    for f in files:
        contained = safe_join(path, f.name)
        if contained is None or not contained.is_file():
            continue
        parsed = load_device_type_file(contained)
        if parsed is None:
            continue
        into[parsed["id"]] = parsed


def load_device_types(
    shipped_dir: Path | None,
    user_dir: Path | None = None,
) -> dict[str, dict]:
    """Load shipped catalogs, then overlay user catalogs keyed by ``id``.

    A user document with the same id replaces the shipped one (including
    its trigger list). Each malformed file is skipped (warning) so one
    corrupt overlay cannot hide the rest or the shipped set.
    """
    out: dict[str, dict] = {}
    _load_dir(shipped_dir, out)
    _load_dir(user_dir, out)
    return out


def load_device_type(
    type_id: str,
    *,
    config_dir: Path | None = None,
    shipped_dir: Path | None = SHIPPED_DEVICE_TYPES_DIR,
) -> dict | None:
    """Load one catalog by id. Overlay wins; corrupt overlay falls through."""
    if not isinstance(type_id, str) or not DEVICE_TYPE_ID_RE.fullmatch(type_id):
        return None
    if config_dir is not None:
        overlay = device_type_path(config_dir, type_id)
        if overlay is not None and overlay.is_file():
            parsed = load_device_type_file(overlay)
            if parsed is not None:
                return parsed
            log.warning("device-type: skipping corrupt overlay for %s", type_id)
    if shipped_dir is None:
        return None
    shipped = safe_join(Path(shipped_dir), type_id + ".json")
    if shipped is None or not shipped.is_file():
        return None
    return load_device_type_file(shipped)
