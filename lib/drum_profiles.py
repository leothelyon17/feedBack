"""Named drum profile documents under {config_dir}/drums/profiles/.

A profile is a session (lanes + highway) that may attach to a MIDI device
via device_id. Notes stay on the device when attached — this module has no
notes writer. INIT-003/SPEC-001, INIT-003/SPEC-008.
"""

from __future__ import annotations

import json
import logging
import os
import re
import tempfile
import threading
from pathlib import Path

from drums import SHIPPED_KITS_DIR, load_kits
from safepath import safe_join

log = logging.getLogger("feedBack.lib.drum_profiles")

# Same slug as kits (lib/routers/drums.py). Traversal / unicode / NUL fail this.
PROFILE_ID_RE = re.compile(r"^[a-z0-9-]+$")
# Logical midi-input id: `web-midi::pad-1` or a bare slug. Empty string allowed.
# Rejects raw port labels (spaces, parentheses, MIDIIN2 (Foo)).
_SOURCE_ID_RE = re.compile(r"^[a-z0-9][a-z0-9._-]*(::[a-z0-9._-]+)*$")

_DANGEROUS_KEYS = frozenset({"__proto__", "constructor", "prototype"})
_PROFILE_BODY_MAX = 64 * 1024
_DEFAULT_PROFILE_ID = "default"
_DEFAULT_PROFILE_NAME = "Default"

_DEFAULT_DEVICE = {"source_id": "", "enabled": False}
_DEFAULT_INPUT = {
    "midi_channel": -1,
    "hit_detection": False,
    "synth_volume": 0.7,
}
_DEFAULT_HIGHWAY = {
    "2d": {"lane_preset": "phase_shift_8", "show_lane_labels": True},
    "3d": {
        "palette": "default",
        "camera_angle": 0.35,
        "theme": "default",
        "fx": {},
        "lanes": [],
        "fallbacks": {},
    },
}

_profile_lock = threading.Lock()


def profiles_dir(config_dir: Path) -> Path:
    """Sibling of the kit glob: {config_dir}/drums/profiles/."""
    return Path(config_dir) / "drums" / "profiles"


def profile_path(config_dir: Path, profile_id: str) -> Path | None:
    """Resolve `{id}.json` under drums/profiles/. None on slug or escape."""
    if not isinstance(profile_id, str) or not PROFILE_ID_RE.fullmatch(profile_id):
        return None
    return safe_join(profiles_dir(config_dir), profile_id + ".json")


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


def _kit_id_ok(raw: object) -> bool:
    """Empty / omitted kit_id is allowed (no kits yet). A set id must be a slug."""
    if raw is None:
        return True
    if not isinstance(raw, str):
        return False
    if raw == "":
        return True
    return PROFILE_ID_RE.fullmatch(raw) is not None


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


def _normalise_device(raw: object) -> dict | None:
    if raw is None:
        return dict(_DEFAULT_DEVICE)
    if not isinstance(raw, dict):
        return None
    source_id = raw.get("source_id", "")
    if source_id is None:
        source_id = ""
    if not _source_id_ok(source_id):
        return None
    return {
        "source_id": source_id,
        "enabled": _as_bool(raw.get("enabled"), False),
    }


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


def _normalise_highway_branch(raw: object, default: dict) -> dict:
    if not isinstance(raw, dict):
        return dict(default)
    out = dict(default)
    out.update(raw)
    return out


def _normalise_highway(raw: object) -> dict | None:
    if raw is None:
        return {
            "2d": dict(_DEFAULT_HIGHWAY["2d"]),
            "3d": dict(_DEFAULT_HIGHWAY["3d"]),
        }
    if not isinstance(raw, dict):
        return None
    two = _normalise_highway_branch(raw.get("2d"), _DEFAULT_HIGHWAY["2d"])
    three = _normalise_highway_branch(raw.get("3d"), _DEFAULT_HIGHWAY["3d"])
    return {"2d": two, "3d": three}


def _device_id_ok(raw: object) -> bool:
    """Empty / omitted device_id is allowed. A set id must be a slug."""
    if raw is None:
        return True
    if not isinstance(raw, str):
        return False
    if raw == "":
        return True
    return PROFILE_ID_RE.fullmatch(raw) is not None


def validate_profile(
    obj: object,
    profile_id: str | None = None,
    *,
    config_dir: Path | None = None,
) -> tuple[dict | None, str | None]:
    """Validate a profile document. Returns (canonical, error).

    Rejects notes, owner_id, dangerous keys, bad slugs, and raw MIDI port
    labels on device.source_id. Optional device_id must name an existing
    MIDI device when config_dir is given. INIT-003/SPEC-001, INIT-003/SPEC-008.
    """
    if not isinstance(obj, dict):
        return None, "profile body must be an object"
    if _has_dangerous_keys(obj):
        return None, "profile body contains reserved keys"
    if "notes" in obj:
        return None, "notes are not allowed on a profile"
    if "owner_id" in obj:
        return None, "owner_id is not allowed on a profile"
    pid = obj.get("id")
    if profile_id is not None:
        pid = profile_id
    if not isinstance(pid, str) or not PROFILE_ID_RE.fullmatch(pid):
        return None, "profile id must match [a-z0-9-]+"
    name = obj.get("name")
    if not isinstance(name, str) or not name.strip():
        return None, "name must be a non-empty string"
    kit_id = obj.get("kit_id", "")
    if kit_id is None:
        kit_id = ""
    if not _kit_id_ok(kit_id):
        return None, "kit_id must match [a-z0-9-]+ or be empty"
    device_id = obj.get("device_id", "")
    if device_id is None:
        device_id = ""
    if not _device_id_ok(device_id):
        return None, "device_id must match [a-z0-9-]+ or be empty"
    if device_id and config_dir is not None:
        from midi_devices import load_device
        if load_device(config_dir, device_id) is None:
            return None, "device_id does not name an existing device"
    device = _normalise_device(obj.get("device"))
    if device is None:
        return None, "device.source_id must be a logical midi-input id"
    inp = _normalise_input(obj.get("input"))
    if inp is None:
        return None, "input must be an object"
    highway = _normalise_highway(obj.get("highway"))
    if highway is None:
        return None, "highway must be an object"
    canonical = {
        "id": pid,
        "name": name.strip(),
        "kit_id": kit_id,
        "device": device,
        "input": inp,
        "highway": highway,
    }
    if device_id:
        canonical["device_id"] = device_id
    return canonical, None


def load_profile_file(
    data: bytes | str | Path,
    *,
    config_dir: Path | None = None,
) -> dict | None:
    """Parse one profile JSON document. None on malformed / rejected records."""
    if isinstance(data, Path):
        try:
            payload = data.read_bytes()
        except OSError as exc:
            log.warning("profile: failed to read %s: %s", data, exc)
            return None
    else:
        payload = data
    if isinstance(payload, str):
        payload = payload.encode("utf-8")
    if len(payload) > _PROFILE_BODY_MAX:
        log.warning("profile: body exceeds 64 KiB")
        return None
    try:
        obj = json.loads(payload)
    except (TypeError, ValueError, json.JSONDecodeError) as exc:
        log.warning("profile: invalid JSON (%s)", exc)
        return None
    canonical, err = validate_profile(obj, config_dir=config_dir)
    if canonical is None:
        log.warning("profile: rejected (%s)", err)
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


def list_profiles(config_dir: Path) -> list[dict]:
    """Load every valid profile under drums/profiles/. Skip corrupt files."""
    root = profiles_dir(config_dir)
    if not root.is_dir():
        return []
    out: list[dict] = []
    try:
        files = sorted(root.glob("*.json"))
    except OSError as exc:
        log.warning("profile: cannot list %s: %s", root, exc)
        return []
    for f in files:
        parsed = load_profile_file(f, config_dir=config_dir)
        if parsed is None:
            continue
        out.append(parsed)
    return out


def load_profile(config_dir: Path, profile_id: str) -> dict | None:
    dest = profile_path(config_dir, profile_id)
    if dest is None or not dest.is_file():
        return None
    return load_profile_file(dest, config_dir=config_dir)


def save_profile(config_dir: Path, obj: dict, profile_id: str | None = None) -> tuple[dict | None, str | None]:
    """Validate and atomically write a profile. Does not write notes."""
    canonical, err = validate_profile(obj, profile_id, config_dir=config_dir)
    if canonical is None:
        return None, err
    dest = profile_path(config_dir, canonical["id"])
    if dest is None:
        return None, "profile id rejected by path containment"
    payload = json.dumps(canonical, indent=2).encode("utf-8")
    if len(payload) > _PROFILE_BODY_MAX:
        return None, "profile body exceeds 64 KiB"
    with _profile_lock:
        try:
            _atomic_write(dest, payload)
        except OSError as exc:
            log.warning("profile: failed to write %s: %s", canonical["id"], exc)
            return None, "could not persist profile"
    return canonical, None


def apply_active_profile(settings: dict, profile: dict) -> dict:
    """Dual-write active_kit = profile.kit_id onto a settings dict.

    Mutates and returns `settings`. Unset kit_id clears active_kit.
    A set device_id dual-writes active_midi_device (INIT-003/SPEC-009).
    INIT-003/SPEC-001.
    """
    pid = profile.get("id")
    if isinstance(pid, str) and pid:
        settings["active_drum_profile"] = pid
    kit_id = profile.get("kit_id")
    if isinstance(kit_id, str) and kit_id:
        settings["active_kit"] = kit_id
    else:
        settings.pop("active_kit", None)
    device_id = profile.get("device_id")
    if isinstance(device_id, str) and device_id:
        settings["active_midi_device"] = device_id
    return settings


def activate_profile(config_dir: Path, profile_id: str, settings: dict) -> tuple[dict | None, str | None]:
    """Load a profile and dual-write its kit_id onto settings."""
    parsed = load_profile(config_dir, profile_id)
    if parsed is None:
        return None, "unknown profile"
    apply_active_profile(settings, parsed)
    return parsed, None


def scoring_notes(config_dir: Path, profile: dict) -> dict:
    """Scoring map SoT: device.notes when device_id is set, else {}.

    Kit notes are not the source of truth in these helpers. Highways
    switch in INIT-003/SPEC-012 and SPEC-013. INIT-003/SPEC-008.
    """
    device_id = profile.get("device_id") if isinstance(profile, dict) else None
    if not isinstance(device_id, str) or not device_id:
        return {}
    from midi_devices import load_device
    device = load_device(config_dir, device_id)
    if device is None:
        return {}
    notes = device.get("notes")
    return dict(notes) if isinstance(notes, dict) else {}


def _first_shipped_kit_id(shipped_dir: Path | None, user_dir: Path | None) -> str:
    kits = load_kits(shipped_dir, user_dir)
    if not kits:
        return ""
    if "alesis-strata-prime" in kits:
        return "alesis-strata-prime"
    return sorted(kits)[0]


def _kit_display_name(kit_id: str, shipped_dir: Path | None, user_dir: Path | None) -> str:
    if not kit_id:
        return _DEFAULT_PROFILE_NAME
    kits = load_kits(shipped_dir, user_dir)
    kit = kits.get(kit_id)
    if isinstance(kit, dict):
        name = kit.get("name")
        if isinstance(name, str) and name:
            return name
    return _DEFAULT_PROFILE_NAME


def _parse_legacy_json(raw: object) -> dict | None:
    if raw is None:
        return None
    if isinstance(raw, dict):
        return raw
    if isinstance(raw, (bytes, str)):
        try:
            obj = json.loads(raw)
        except (TypeError, ValueError, json.JSONDecodeError):
            return None
        return obj if isinstance(obj, dict) else None
    return None


def _input_from_legacy(feedback_drums_input_v1: object) -> tuple[dict, dict]:
    """Map feedback_drums_input_v1 onto device + input. source_id stays empty."""
    device = dict(_DEFAULT_DEVICE)
    inp = dict(_DEFAULT_INPUT)
    blob = _parse_legacy_json(feedback_drums_input_v1)
    if blob is None:
        return device, inp
    if "deviceEnabled" in blob:
        device["enabled"] = _as_bool(blob.get("deviceEnabled"), False)
    elif "enabled" in blob:
        device["enabled"] = _as_bool(blob.get("enabled"), False)
    channel = blob.get("midiChannel", blob.get("midi_channel"))
    if channel is not None:
        try:
            inp["midi_channel"] = _as_channel(int(channel))
        except (TypeError, ValueError):
            pass
    if "hitDetection" in blob or "hit_detection" in blob:
        inp["hit_detection"] = _as_bool(
            blob.get("hitDetection", blob.get("hit_detection")), False
        )
    vol = blob.get("synthVolume", blob.get("synth_volume"))
    if vol is not None:
        try:
            inp["synth_volume"] = _as_volume(float(vol))
        except (TypeError, ValueError):
            pass
    return device, inp


def _highway_from_legacy(drum_h3d_kit_v1: object) -> dict:
    """Copy visual leftovers from drum_h3d_kit_v1. Never copies notes."""
    highway = {
        "2d": dict(_DEFAULT_HIGHWAY["2d"]),
        "3d": dict(_DEFAULT_HIGHWAY["3d"]),
    }
    blob = _parse_legacy_json(drum_h3d_kit_v1)
    if blob is None:
        return highway
    three = highway["3d"]
    lanes = blob.get("lanes")
    if isinstance(lanes, list):
        three["lanes"] = [ln for ln in lanes if isinstance(ln, dict)]
    fallbacks = blob.get("fallbacks")
    if isinstance(fallbacks, dict) and "notes" not in fallbacks:
        three["fallbacks"] = {
            k: v for k, v in fallbacks.items()
            if isinstance(k, str) and isinstance(v, str)
        }
    return highway


def seed_default_profile(
    config_dir: Path,
    settings: dict | None = None,
    *,
    shipped_dir: Path | None = None,
    user_dir: Path | None = None,
    feedback_drums_input_v1: object = None,
    drums_custom_map: object = None,
    drum_h3d_kit_v1: object = None,
) -> dict | None:
    """Create one default profile from active_kit + legacy stores.

    `drums_custom_map` is dual-read (accepted) but never becomes profile notes.
    Empty active_kit falls back to a shipped kit, or leaves kit_id unset if
    no kits exist. Idempotent: existing profiles are left alone.
    INIT-003/SPEC-001.
    """
    existing = list_profiles(config_dir)
    if existing:
        chosen = next(
            (p for p in existing if p["id"] == _DEFAULT_PROFILE_ID), existing[0]
        )
        if settings is not None:
            apply_active_profile(settings, chosen)
        return chosen

    if shipped_dir is None:
        shipped_dir = SHIPPED_KITS_DIR
    if user_dir is None:
        user_dir = Path(config_dir) / "drums"

    settings = settings if settings is not None else {}
    raw_kit = settings.get("active_kit")
    if isinstance(raw_kit, str) and PROFILE_ID_RE.fullmatch(raw_kit):
        kit_id = raw_kit
    else:
        kit_id = _first_shipped_kit_id(shipped_dir, user_dir)

    device, inp = _input_from_legacy(feedback_drums_input_v1)
    highway = _highway_from_legacy(drum_h3d_kit_v1)
    # Dual-read only — never copy midi→piece onto the profile.
    _parse_legacy_json(drums_custom_map)

    draft = {
        "id": _DEFAULT_PROFILE_ID,
        "name": _kit_display_name(kit_id, shipped_dir, user_dir),
        "kit_id": kit_id,
        "device": device,
        "input": inp,
        "highway": highway,
    }
    saved, err = save_profile(config_dir, draft)
    if saved is None:
        log.warning("profile: seed failed (%s)", err)
        return None
    apply_active_profile(settings, saved)
    return saved
