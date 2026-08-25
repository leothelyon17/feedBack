"""MIDI device-type catalogs and device instance CRUD (/api/midi/...).

Catalogs have no default notes map. Device documents persist via
lib/midi_devices.py. Learn/note and whole-device writes 409 while a
highway scoring session is playing or paused (reuses SPEC-002 flag).
Public DTO includes optional Calibration `timing` when set (omit = Not
set). PUT merge lives in save_device (omit preserves, null clears).
INIT-003/SPEC-009, INIT-004/SPEC-007.
"""

from __future__ import annotations

import json
import logging

from fastapi import APIRouter, HTTPException, Query, Request

import appstate
from appconfig import _load_config
from midi_device_types import (
    DEVICE_TYPE_ID_RE,
    SHIPPED_DEVICE_TYPES_DIR,
    device_types_dir,
    load_device_type,
    load_device_types,
)
from midi_devices import (
    DEVICE_ID_RE,
    device_from_type,
    device_path,
    list_devices,
    load_device,
    migrate_overlay_kit_notes,
    save_device,
)
from routers.drums import scoring_session_blocks_learn

log = logging.getLogger("feedBack.server")
router = APIRouter()

_DEVICE_BODY_MAX = 64 * 1024
_NOTE_BODY_MAX = 4 * 1024
_DANGEROUS_KEYS = frozenset({"__proto__", "constructor", "prototype"})


def _has_dangerous_keys(obj: object) -> bool:
    if isinstance(obj, dict):
        if _DANGEROUS_KEYS.intersection(obj):
            return True
        return any(_has_dangerous_keys(v) for v in obj.values())
    if isinstance(obj, list):
        return any(_has_dangerous_keys(v) for v in obj)
    return False


def _require_device_id(device_id: str) -> str:
    if not isinstance(device_id, str) or not DEVICE_ID_RE.fullmatch(device_id):
        raise HTTPException(status_code=400, detail="device id must match [a-z0-9-]+")
    return device_id


def _require_type_id(type_id: str) -> str:
    if not isinstance(type_id, str) or not DEVICE_TYPE_ID_RE.fullmatch(type_id):
        raise HTTPException(status_code=400, detail="device type id must match [a-z0-9-]+")
    return type_id


def _require_midi_note(raw: str) -> int:
    try:
        note = int(raw)
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="midi_note must be an integer 0-127") from None
    if not 0 <= note <= 127:
        raise HTTPException(status_code=400, detail="midi_note must be an integer 0-127")
    return note


def _reject_if_learn_locked() -> None:
    if scoring_session_blocks_learn():
        raise HTTPException(
            status_code=409,
            detail="device notes cannot be changed while a highway session is playing or paused",
        )


def _device_public(device: dict) -> dict:
    notes = device.get("notes") or {}
    out = {
        "id": device["id"],
        "name": device.get("name") or device["id"],
        "source_id": device.get("source_id") or "",
        "device_type_id": device["device_type_id"],
        "family": device["family"],
        "notes": {str(k): v for k, v in notes.items()},
        "triggers": list(device.get("triggers") or []),
        "input": device.get("input"),
    }
    # INIT-004/SPEC-007: omit when Not set so midiDevices cache stays
    # omit-means-unset. Canonical shape already comes from save_device.
    timing = device.get("timing") if "timing" in device else None
    if isinstance(timing, dict):
        out["timing"] = dict(timing)
    return out


def _type_public(catalog: dict) -> dict:
    out = {
        "id": catalog["id"],
        "name": catalog.get("name") or catalog["id"],
        "family": catalog["family"],
        "triggers": list(catalog.get("triggers") or []),
    }
    manufacturer = catalog.get("manufacturer")
    if isinstance(manufacturer, str) and manufacturer:
        out["manufacturer"] = manufacturer
    out.pop("notes", None)
    return out


def _device_trigger_ids(device: dict) -> set[str]:
    ids: set[str] = set()
    for row in device.get("triggers") or []:
        if isinstance(row, dict) and isinstance(row.get("id"), str):
            ids.add(row["id"])
    return ids


def _active_midi_device_id() -> str | None:
    cfg = _load_config(appstate.config_dir / "config.json")
    if not isinstance(cfg, dict):
        return None
    raw = cfg.get("active_midi_device")
    if isinstance(raw, str) and DEVICE_ID_RE.fullmatch(raw):
        return raw
    return None


def _parse_json_object(body: bytes, *, max_bytes: int, label: str) -> dict:
    if len(body) > max_bytes:
        raise HTTPException(status_code=413, detail=f"{label} body exceeds {max_bytes} bytes")
    try:
        obj = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError, ValueError):
        raise HTTPException(status_code=400, detail=f"{label} body must be JSON") from None
    if not isinstance(obj, dict):
        raise HTTPException(status_code=400, detail=f"{label} body must be an object")
    if _has_dangerous_keys(obj):
        raise HTTPException(status_code=400, detail=f"{label} body contains reserved keys")
    return obj


def _require_piece_id_for_device(device: dict, body: bytes) -> str:
    obj = _parse_json_object(body, max_bytes=_NOTE_BODY_MAX, label="request")
    piece_id = obj.get("piece_id")
    if not isinstance(piece_id, str) or not piece_id:
        raise HTTPException(status_code=400, detail="piece_id must be a catalog trigger id")
    if piece_id not in _device_trigger_ids(device):
        raise HTTPException(
            status_code=400,
            detail="piece_id must be a trigger on this device type",
        )
    return piece_id


def _persist_device_from_obj(obj: dict, device_id: str | None) -> dict:
    if device_id is not None:
        obj = dict(obj)
        obj["id"] = device_id
    did = obj.get("id")
    if not isinstance(did, str) or not DEVICE_ID_RE.fullmatch(did):
        raise HTTPException(status_code=400, detail="device id must match [a-z0-9-]+")
    dest = device_path(appstate.config_dir, did)
    if dest is None:
        raise HTTPException(status_code=400, detail="device id rejected by path containment")
    if "notes" not in obj:
        type_id = obj.get("device_type_id")
        if not isinstance(type_id, str):
            raise HTTPException(status_code=400, detail="device_type_id must match [a-z0-9-]+")
        saved, err = device_from_type(
            appstate.config_dir,
            type_id,
            device_id=did,
            name=obj.get("name"),
            source_id=obj.get("source_id", ""),
        )
    else:
        saved, err = save_device(appstate.config_dir, obj, did)
    if saved is None:
        raise HTTPException(status_code=400, detail=err or "invalid device")
    return saved


def _delete_device_by_id(device_id: str) -> dict:
    device_id = _require_device_id(device_id)
    dest = device_path(appstate.config_dir, device_id)
    if dest is None:
        raise HTTPException(status_code=400, detail="device id rejected by path containment")
    _reject_if_learn_locked()
    if _active_midi_device_id() == device_id:
        raise HTTPException(
            status_code=400,
            detail="cannot delete the active MIDI device; activate another device first",
        )
    if not dest.is_file():
        raise HTTPException(status_code=404, detail="unknown device")
    try:
        dest.unlink()
    except OSError as exc:
        log.warning("midi: failed to delete device %s: %s", device_id, exc)
        raise HTTPException(status_code=500, detail="could not delete device") from exc
    log.info("midi device deleted: %s", device_id)
    return {"ok": True}


def _maybe_migrate() -> None:
    migrate_overlay_kit_notes(appstate.config_dir)


@router.get("/api/midi/device-types")
def get_device_types():
    types = load_device_types(
        SHIPPED_DEVICE_TYPES_DIR,
        device_types_dir(appstate.config_dir),
    )
    return {"device_types": [_type_public(t) for t in types.values()]}


@router.get("/api/midi/device-types/{type_id:path}")
def get_device_type(type_id: str):
    type_id = _require_type_id(type_id)
    catalog = load_device_type(type_id, config_dir=appstate.config_dir)
    if catalog is None:
        raise HTTPException(status_code=404, detail="unknown device type")
    return _type_public(catalog)


@router.get("/api/midi/devices")
def get_devices():
    _maybe_migrate()
    return {"devices": [_device_public(d) for d in list_devices(appstate.config_dir)]}


@router.post("/api/midi/devices")
async def post_device(request: Request):
    """Create a device from a catalog type with empty notes."""
    _reject_if_learn_locked()
    obj = _parse_json_object(await request.body(), max_bytes=_DEVICE_BODY_MAX, label="device")
    did = obj.get("id")
    if not isinstance(did, str) or not DEVICE_ID_RE.fullmatch(did):
        raise HTTPException(status_code=400, detail="device id must match [a-z0-9-]+")
    type_id = obj.get("device_type_id")
    if not isinstance(type_id, str) or not DEVICE_TYPE_ID_RE.fullmatch(type_id):
        raise HTTPException(status_code=400, detail="device_type_id must match [a-z0-9-]+")
    saved, err = device_from_type(
        appstate.config_dir,
        type_id,
        device_id=did,
        name=obj.get("name"),
        source_id=obj.get("source_id", ""),
    )
    if saved is None:
        raise HTTPException(status_code=400, detail=err or "invalid device")
    log.info("midi device created from type: %s type=%s", saved["id"], type_id)
    return _device_public(saved)


@router.put("/api/midi/devices")
async def put_devices_collection(request: Request):
    _reject_if_learn_locked()
    obj = _parse_json_object(await request.body(), max_bytes=_DEVICE_BODY_MAX, label="device")
    saved = _persist_device_from_obj(obj, None)
    log.info("midi device saved: %s", saved["id"])
    return _device_public(saved)


@router.delete("/api/midi/devices")
def delete_devices_collection(device_id: str | None = Query(None, alias="id")):
    if not device_id:
        raise HTTPException(status_code=400, detail="id query parameter is required")
    return _delete_device_by_id(device_id)


@router.put("/api/midi/devices/{device_id:path}/notes/{midi_note}")
async def put_device_note(device_id: str, midi_note: str, request: Request):
    device_id = _require_device_id(device_id)
    note = _require_midi_note(midi_note)
    dest = device_path(appstate.config_dir, device_id)
    if dest is None:
        raise HTTPException(status_code=400, detail="device id rejected by path containment")
    _reject_if_learn_locked()
    current = load_device(appstate.config_dir, device_id)
    if current is None:
        raise HTTPException(status_code=404, detail="unknown device")
    piece_id = _require_piece_id_for_device(current, await request.body())
    draft = dict(current)
    notes = dict(current.get("notes") or {})
    notes[str(note)] = piece_id
    draft["notes"] = notes
    saved, err = save_device(appstate.config_dir, draft, device_id)
    if saved is None:
        raise HTTPException(status_code=400, detail=err or "could not persist device note")
    if saved["notes"].get(str(note)) != piece_id:
        raise HTTPException(status_code=400, detail="piece_id could not be stored on this device")
    log.info("midi device note set: device=%s note=%s piece=%s", device_id, note, piece_id)
    return {
        "device": _device_public(saved),
        "mutation": {"midi_note": note, "operation": "set", "piece_id": piece_id},
    }


@router.delete("/api/midi/devices/{device_id:path}/notes/{midi_note}")
def delete_device_note(device_id: str, midi_note: str):
    device_id = _require_device_id(device_id)
    note = _require_midi_note(midi_note)
    dest = device_path(appstate.config_dir, device_id)
    if dest is None:
        raise HTTPException(status_code=400, detail="device id rejected by path containment")
    _reject_if_learn_locked()
    current = load_device(appstate.config_dir, device_id)
    if current is None:
        raise HTTPException(status_code=404, detail="unknown device")
    draft = dict(current)
    notes = dict(current.get("notes") or {})
    notes.pop(str(note), None)
    draft["notes"] = notes
    saved, err = save_device(appstate.config_dir, draft, device_id)
    if saved is None:
        raise HTTPException(status_code=400, detail=err or "could not persist device note")
    log.info("midi device note removed: device=%s note=%s", device_id, note)
    return {
        "device": _device_public(saved),
        "mutation": {"midi_note": note, "operation": "delete", "piece_id": None},
    }


@router.get("/api/midi/devices/{device_id:path}")
def get_device(device_id: str):
    device_id = _require_device_id(device_id)
    parsed = load_device(appstate.config_dir, device_id)
    if parsed is None:
        raise HTTPException(status_code=404, detail="unknown device")
    return _device_public(parsed)


@router.put("/api/midi/devices/{device_id:path}")
async def put_device(device_id: str, request: Request):
    device_id = _require_device_id(device_id)
    dest = device_path(appstate.config_dir, device_id)
    if dest is None:
        raise HTTPException(status_code=400, detail="device id rejected by path containment")
    _reject_if_learn_locked()
    obj = _parse_json_object(await request.body(), max_bytes=_DEVICE_BODY_MAX, label="device")
    saved = _persist_device_from_obj(obj, device_id)
    log.info("midi device saved: %s", saved["id"])
    return _device_public(saved)


@router.delete("/api/midi/devices/{device_id:path}")
def delete_device(device_id: str):
    return _delete_device_by_id(device_id)
