"""Drums vocabulary and user-kit CRUD (/api/drums/...).

Shipped kits live under data/drums/kits/ (read-only). User kits persist
under {config_dir}/drums/ via safepath.safe_join — never under the
shipped tree. INIT-001/SPEC-002.
"""

from __future__ import annotations

import json
import logging
import os
import re
import tempfile
import threading
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request

import appstate
from drums import PIECES, PRESETS, SHIPPED_KITS_DIR, load_kit_file, load_kits
from safepath import safe_join

log = logging.getLogger("feedBack.server")
router = APIRouter()

# INIT-001/SPEC-002: slug ids only; 400 otherwise (unicode / traversal / NUL).
_KIT_ID_RE = re.compile(r"^[a-z0-9-]+$")
_KIT_BODY_MAX = 64 * 1024
_DANGEROUS_KEYS = frozenset({"__proto__", "constructor", "prototype"})
_kit_lock = threading.Lock()


def _user_kits_dir() -> Path:
    return appstate.config_dir / "drums"


def _kit_filename(kit_id: str) -> str:
    return kit_id + ".json"


def _user_kit_path(kit_id: str) -> Path | None:
    return safe_join(_user_kits_dir(), _kit_filename(kit_id))


def _loaded_kits() -> dict[str, dict]:
    return load_kits(SHIPPED_KITS_DIR, _user_kits_dir())


def _user_kit_ids() -> set[str]:
    root = _user_kits_dir()
    if not root.is_dir():
        return set()
    ids: set[str] = set()
    try:
        files = root.glob("*.json")
    except OSError as exc:
        log.warning("drums: cannot list user kits: %s", exc)
        return ids
    for f in files:
        kit = load_kit_file(f)
        if kit is not None:
            ids.add(kit["id"])
    return ids


def _has_dangerous_keys(obj: object) -> bool:
    if isinstance(obj, dict):
        if _DANGEROUS_KEYS.intersection(obj):
            return True
        return any(_has_dangerous_keys(v) for v in obj.values())
    if isinstance(obj, list):
        return any(_has_dangerous_keys(v) for v in obj)
    return False


def _kit_public(kit: dict, source: str) -> dict:
    notes = kit.get("notes") or {}
    notes_out = {str(k): v for k, v in notes.items()}
    return {
        "id": kit["id"],
        "name": kit.get("name") or kit["id"],
        "manufacturer": kit.get("manufacturer"),
        "verified": bool(kit.get("verified")),
        "notes": notes_out,
        "hihat": kit.get("hihat"),
        "source": source,
    }


def _source_for(kit_id: str, user_ids: set[str]) -> str:
    return "user" if kit_id in user_ids else "shipped"


def _require_kit_id(kit_id: str) -> str:
    if not isinstance(kit_id, str) or not _KIT_ID_RE.fullmatch(kit_id):
        raise HTTPException(status_code=400, detail="kit id must match [a-z0-9-]+")
    return kit_id


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


def _persistable_kit(parsed: dict) -> dict:
    notes = parsed.get("notes") or {}
    notes_out = {str(k): v for k, v in notes.items()}
    out = {
        "id": parsed["id"],
        "name": parsed.get("name") or parsed["id"],
        "verified": bool(parsed.get("verified")),
        "notes": notes_out,
        "hihat": parsed.get("hihat"),
    }
    manufacturer = parsed.get("manufacturer")
    if isinstance(manufacturer, str) and manufacturer:
        out["manufacturer"] = manufacturer
    return out


@router.get("/api/drums/vocabulary")
def get_vocabulary():
    """Piece-ids + GM midi + lane presets. No kit required."""
    pieces = {
        pid: {
            "midi": list(meta["midi"]),
            "category": meta["category"],
            "shape": meta["shape"],
            "color": meta["color"],
        }
        for pid, meta in PIECES.items()
    }
    presets = {
        name: [{"pieces": list(lane["pieces"]), "label": lane["label"]} for lane in lanes]
        for name, lanes in PRESETS.items()
    }
    return {"pieces": pieces, "presets": presets}


@router.get("/api/drums/kits")
def list_kits():
    kits = _loaded_kits()
    user_ids = _user_kit_ids()
    return {
        "kits": [
            _kit_public(kit, _source_for(kit_id, user_ids))
            for kit_id, kit in kits.items()
        ]
    }


@router.get("/api/drums/kits/{kit_id:path}")
def get_kit(kit_id: str):
    kit_id = _require_kit_id(kit_id)
    kits = _loaded_kits()
    kit = kits.get(kit_id)
    if kit is None:
        raise HTTPException(status_code=404, detail="unknown kit")
    return _kit_public(kit, _source_for(kit_id, _user_kit_ids()))


def validate_kit_bytes(body: bytes, kit_id: str | None = None) -> tuple[bytes | None, str | None, int]:
    """Validate a kit JSON document. Returns (canonical_bytes, error, http_status).

    Shared by PUT /api/drums/kits and settings import of drums/*.json
    so both write paths enforce the same size, shape, and reserved-key rules.
    """
    if len(body) > _KIT_BODY_MAX:
        return None, "kit body exceeds 64 KiB", 413
    try:
        obj = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError, ValueError):
        return None, "kit body must be JSON", 400
    if not isinstance(obj, dict):
        return None, "kit body must be an object", 400
    if _has_dangerous_keys(obj):
        return None, "kit body contains reserved keys", 400
    notes = obj.get("notes", {})
    if notes is None:
        notes = {}
    if not isinstance(notes, dict):
        return None, "notes must be an object", 400
    for value in notes.values():
        if not isinstance(value, str):
            return None, "notes values must be strings", 400
    obj = dict(obj)
    if kit_id is not None:
        obj["id"] = kit_id
    parsed = load_kit_file(json.dumps(obj))
    if parsed is None:
        return None, "invalid kit", 400
    return json.dumps(_persistable_kit(parsed), indent=2).encode("utf-8"), None, 200


@router.put("/api/drums/kits/{kit_id:path}")
async def put_kit(kit_id: str, request: Request):
    kit_id = _require_kit_id(kit_id)
    dest = _user_kit_path(kit_id)
    if dest is None:
        raise HTTPException(status_code=400, detail="kit id rejected by path containment")
    body = await request.body()
    payload, err, status = validate_kit_bytes(body, kit_id)
    if err is not None or payload is None:
        raise HTTPException(status_code=status, detail=err)
    with _kit_lock:
        _atomic_write(dest, payload)
    log.info("drums kit saved: %s", kit_id)
    parsed = load_kit_file(payload)
    return _kit_public(parsed, "user")


@router.delete("/api/drums/kits/{kit_id:path}")
def delete_kit(kit_id: str):
    kit_id = _require_kit_id(kit_id)
    dest = _user_kit_path(kit_id)
    if dest is None:
        raise HTTPException(status_code=400, detail="kit id rejected by path containment")
    user_file = dest.is_file()
    shipped = kit_id in load_kits(SHIPPED_KITS_DIR, None)
    if user_file:
        try:
            dest.unlink()
        except OSError as exc:
            log.warning("drums: failed to delete kit %s: %s", kit_id, exc)
            raise HTTPException(status_code=500, detail="could not delete kit") from exc
        log.info("drums kit deleted: %s", kit_id)
        return {"ok": True}
    if shipped:
        raise HTTPException(status_code=403, detail="shipped kits cannot be deleted")
    raise HTTPException(status_code=404, detail="unknown kit")
