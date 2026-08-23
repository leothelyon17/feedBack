"""Drums vocabulary, user-kit CRUD, and named profile CRUD (/api/drums/...).

Shipped kits live under data/drums/kits/ (read-only). User kits persist
under {config_dir}/drums/ via safepath.safe_join — never under the
shipped tree. Profiles persist under drums/profiles/ via SPEC-001 helpers.
INIT-001/SPEC-002, INIT-003/SPEC-002.
"""

from __future__ import annotations

import json
import logging
import os
import re
import tempfile
import threading
from pathlib import Path

from fastapi import APIRouter, HTTPException, Query, Request

import appstate
from appconfig import _load_config
from drum_profiles import (
    PROFILE_ID_RE,
    list_profiles,
    load_profile,
    profile_path,
    save_profile,
    validate_profile,
)
from drums import PIECES, PRESETS, SHIPPED_KITS_DIR, load_kit_file, load_kits, midi_to_piece
from safepath import safe_join

log = logging.getLogger("feedBack.server")
router = APIRouter()

# INIT-001/SPEC-002: slug ids only; 400 otherwise (unicode / traversal / NUL).
_KIT_ID_RE = re.compile(r"^[a-z0-9-]+$")
_KIT_BODY_MAX = 64 * 1024
_DANGEROUS_KEYS = frozenset({"__proto__", "constructor", "prototype"})
_kit_lock = threading.Lock()

# INIT-002/SPEC-001: atomic per-note mutation body is just {"piece_id": "..."},
# so it gets a much smaller cap than a whole-kit document.
_NOTE_BODY_MAX = 4 * 1024

# INIT-003/SPEC-002: in-process highway scoring-session flag. Learn/note
# mutations 409 while any session is playing or paused. No WS frame.
_SCORING_LOCKED = frozenset({"playing", "paused"})
_SCORING_STATES = frozenset({"playing", "paused", "stopped", "idle"})
_scoring_lock = threading.Lock()
_scoring_state = "stopped"


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


def _require_profile_id(profile_id: str) -> str:
    if not isinstance(profile_id, str) or not PROFILE_ID_RE.fullmatch(profile_id):
        raise HTTPException(status_code=400, detail="profile id must match [a-z0-9-]+")
    return profile_id


def scoring_session_blocks_learn() -> bool:
    with _scoring_lock:
        return _scoring_state in _SCORING_LOCKED


def scoring_session_state() -> str:
    with _scoring_lock:
        return _scoring_state


def set_scoring_session_state(state: str) -> str:
    if state not in _SCORING_STATES:
        raise HTTPException(
            status_code=400,
            detail="state must be playing, paused, stopped, or idle",
        )
    global _scoring_state
    with _scoring_lock:
        _scoring_state = state
        return _scoring_state


def reset_scoring_session_for_tests() -> None:
    """Test fixture hook — unlock Learn between httpx clients."""
    global _scoring_state
    with _scoring_lock:
        _scoring_state = "stopped"


def _reject_if_learn_locked() -> None:
    if scoring_session_blocks_learn():
        raise HTTPException(
            status_code=409,
            detail="kit notes cannot be changed while a highway session is playing or paused",
        )


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


def _require_midi_note(raw: str) -> int:
    try:
        note = int(raw)
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="midi_note must be an integer 0-127") from None
    if not 0 <= note <= 127:
        raise HTTPException(status_code=400, detail="midi_note must be an integer 0-127")
    return note


def _require_piece_id_body(body: bytes) -> str:
    """Validate the `{"piece_id": "..."}` body for an atomic note mutation."""
    if len(body) > _NOTE_BODY_MAX:
        raise HTTPException(status_code=413, detail="request body too large")
    try:
        obj = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError, ValueError):
        raise HTTPException(status_code=400, detail="request body must be JSON") from None
    if not isinstance(obj, dict):
        raise HTTPException(status_code=400, detail="request body must be an object")
    if _has_dangerous_keys(obj):
        raise HTTPException(status_code=400, detail="request body contains reserved keys")
    piece_id = obj.get("piece_id")
    if not isinstance(piece_id, str) or piece_id not in PIECES:
        raise HTTPException(status_code=400, detail="piece_id must be a known drum piece id")
    return piece_id


def _clone_kit_for_mutation(kit_id: str) -> dict:
    """Load the kit's current effective (user-overlaid) shape for mutation.

    Callers must hold ``_kit_lock`` — the clone-then-write must be atomic with
    respect to other note mutations, or a concurrent PUT on a different note
    could lose this one (REQ-002).
    """
    kit = _loaded_kits().get(kit_id)
    if kit is None:
        raise HTTPException(status_code=404, detail="unknown kit")
    out = {
        "id": kit_id,
        "name": kit.get("name") or kit_id,
        "verified": bool(kit.get("verified")),
        "notes": dict(kit.get("notes") or {}),
        "hihat": kit.get("hihat"),
    }
    manufacturer = kit.get("manufacturer")
    if isinstance(manufacturer, str) and manufacturer:
        out["manufacturer"] = manufacturer
    return out


def _mutate_kit_note(kit_id: str, dest: Path, note: int, piece_id: str | None) -> dict:
    """Load, clone-if-needed, mutate one note, validate, and atomically write.

    The entire load → clone → mutate → validate → write sequence runs under
    ``_kit_lock`` so a concurrent mutation of a different note on the same
    kit can never observe or persist a stale snapshot (REQ-002). ``piece_id
    None`` removes the note (DELETE); otherwise it is set (PUT).
    """
    with _kit_lock:
        cloned = _clone_kit_for_mutation(kit_id)
        if piece_id is None:
            cloned["notes"].pop(note, None)
        else:
            cloned["notes"][note] = piece_id
        payload = json.dumps(_persistable_kit(cloned), indent=2).encode("utf-8")
        _atomic_write(dest, payload)
    parsed = load_kit_file(payload)
    if parsed is None:
        # Unreachable in practice — _persistable_kit's output always
        # round-trips through load_kit_file — but never respond with a
        # dict that wasn't actually validated by re-parsing what was written.
        raise HTTPException(status_code=500, detail="could not persist kit note")
    return parsed


@router.put("/api/drums/kits/{kit_id:path}/notes/{midi_note}")
async def put_kit_note(kit_id: str, midi_note: str, request: Request):
    """Atomically set one MIDI-note-to-piece mapping in a kit's user overlay.

    Never touches the shipped kit tree: a shipped kit's current persisted
    shape is cloned into the user overlay on first mutation (REQ-001).
    """
    kit_id = _require_kit_id(kit_id)
    note = _require_midi_note(midi_note)
    dest = _user_kit_path(kit_id)
    if dest is None:
        raise HTTPException(status_code=400, detail="kit id rejected by path containment")
    _reject_if_learn_locked()
    body = await request.body()
    piece_id = _require_piece_id_body(body)
    parsed = _mutate_kit_note(kit_id, dest, note, piece_id)
    log.info("drums kit note set: kit=%s note=%s piece=%s", kit_id, note, piece_id)
    return {
        "kit": _kit_public(parsed, "user"),
        "mutation": {"midi_note": note, "operation": "set", "piece_id": piece_id},
        "resolution": {"piece_id": piece_id, "source": "kit"},
    }


@router.delete("/api/drums/kits/{kit_id:path}/notes/{midi_note}")
def delete_kit_note(kit_id: str, midi_note: str):
    """Atomically remove one MIDI-note-to-piece mapping from a kit's user
    overlay. Idempotent — deleting an already-absent note still succeeds and
    reports the same resolution (REQ-004)."""
    kit_id = _require_kit_id(kit_id)
    note = _require_midi_note(midi_note)
    dest = _user_kit_path(kit_id)
    if dest is None:
        raise HTTPException(status_code=400, detail="kit id rejected by path containment")
    _reject_if_learn_locked()
    parsed = _mutate_kit_note(kit_id, dest, note, None)
    gm_fallback = midi_to_piece(note)
    log.info("drums kit note removed: kit=%s note=%s", kit_id, note)
    return {
        "kit": _kit_public(parsed, "user"),
        "mutation": {"midi_note": note, "operation": "delete", "piece_id": None},
        "resolution": {
            "piece_id": gm_fallback,
            "source": "gm" if gm_fallback else "unmapped",
        },
    }


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


# ── Scoring session (INIT-003/SPEC-002 aud-1) ───────────────────────────────


@router.put("/api/drums/scoring-session")
def put_scoring_session(data: dict):
    """Set the in-process highway play-state flag. playing/paused lock Learn."""
    if not isinstance(data, dict):
        raise HTTPException(status_code=400, detail="request body must be an object")
    if _has_dangerous_keys(data):
        raise HTTPException(status_code=400, detail="request body contains reserved keys")
    state = set_scoring_session_state(data.get("state"))
    log.info("drums scoring session: %s", state)
    return {"state": state, "learn_locked": state in _SCORING_LOCKED}


@router.get("/api/drums/scoring-session")
def get_scoring_session():
    state = scoring_session_state()
    return {"state": state, "learn_locked": state in _SCORING_LOCKED}


# ── Drum profiles (INIT-003/SPEC-002) ───────────────────────────────────────


def _profile_public(profile: dict) -> dict:
    """Wire form — canonical store document; source_id already logical."""
    return {
        "id": profile["id"],
        "name": profile.get("name") or profile["id"],
        "kit_id": profile.get("kit_id") or "",
        "device": profile.get("device") or {"source_id": "", "enabled": False},
        "input": profile.get("input"),
        "highway": profile.get("highway"),
    }


def _active_profile_id() -> str | None:
    cfg = _load_config(appstate.config_dir / "config.json")
    if not isinstance(cfg, dict):
        return None
    raw = cfg.get("active_drum_profile")
    if isinstance(raw, str) and PROFILE_ID_RE.fullmatch(raw):
        return raw
    return None


def _require_known_kit_id(kit_id: str) -> None:
    if not kit_id:
        return
    if kit_id not in _loaded_kits():
        raise HTTPException(status_code=400, detail="kit_id must reference a loaded kit")


def _persist_profile_from_body(body: bytes, profile_id: str | None) -> dict:
    if len(body) > _KIT_BODY_MAX:
        raise HTTPException(status_code=413, detail="profile body exceeds 64 KiB")
    try:
        obj = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError, ValueError):
        raise HTTPException(status_code=400, detail="profile body must be JSON") from None
    if not isinstance(obj, dict):
        raise HTTPException(status_code=400, detail="profile body must be an object")
    if _has_dangerous_keys(obj):
        raise HTTPException(status_code=400, detail="profile body contains reserved keys")
    if "notes" in obj:
        raise HTTPException(status_code=400, detail="notes are not allowed on a profile")
    canonical, err = validate_profile(obj, profile_id)
    if canonical is None:
        raise HTTPException(status_code=400, detail=err or "invalid profile")
    _require_known_kit_id(canonical.get("kit_id") or "")
    saved, save_err = save_profile(appstate.config_dir, canonical, canonical["id"])
    if saved is None:
        raise HTTPException(status_code=400, detail=save_err or "could not persist profile")
    return saved


def _delete_profile_by_id(profile_id: str) -> dict:
    profile_id = _require_profile_id(profile_id)
    dest = profile_path(appstate.config_dir, profile_id)
    if dest is None:
        raise HTTPException(status_code=400, detail="profile id rejected by path containment")
    if _active_profile_id() == profile_id:
        # Delete-active rule (INIT-003/SPEC-002): refuse. Client must
        # activate another profile (or unset active_drum_profile) first.
        raise HTTPException(
            status_code=400,
            detail="cannot delete the active drum profile; activate another profile first",
        )
    if not dest.is_file():
        raise HTTPException(status_code=404, detail="unknown profile")
    try:
        dest.unlink()
    except OSError as exc:
        log.warning("drums: failed to delete profile %s: %s", profile_id, exc)
        raise HTTPException(status_code=500, detail="could not delete profile") from exc
    log.info("drums profile deleted: %s", profile_id)
    return {"ok": True}


@router.get("/api/drums/profiles")
def get_profiles():
    return {
        "profiles": [
            _profile_public(p) for p in list_profiles(appstate.config_dir)
        ]
    }


@router.put("/api/drums/profiles")
async def put_profiles_collection(request: Request):
    """Upsert one profile; id comes from the body (kit-collection PUT)."""
    body = await request.body()
    saved = _persist_profile_from_body(body, None)
    log.info("drums profile saved: %s", saved["id"])
    return _profile_public(saved)


@router.delete("/api/drums/profiles")
def delete_profiles_collection(profile_id: str | None = Query(None, alias="id")):
    if not profile_id:
        raise HTTPException(status_code=400, detail="id query parameter is required")
    return _delete_profile_by_id(profile_id)


@router.get("/api/drums/profiles/{profile_id:path}")
def get_profile(profile_id: str):
    profile_id = _require_profile_id(profile_id)
    parsed = load_profile(appstate.config_dir, profile_id)
    if parsed is None:
        raise HTTPException(status_code=404, detail="unknown profile")
    return _profile_public(parsed)


@router.put("/api/drums/profiles/{profile_id:path}")
async def put_profile(profile_id: str, request: Request):
    profile_id = _require_profile_id(profile_id)
    dest = profile_path(appstate.config_dir, profile_id)
    if dest is None:
        raise HTTPException(status_code=400, detail="profile id rejected by path containment")
    body = await request.body()
    saved = _persist_profile_from_body(body, profile_id)
    log.info("drums profile saved: %s", saved["id"])
    return _profile_public(saved)


@router.delete("/api/drums/profiles/{profile_id:path}")
def delete_profile(profile_id: str):
    return _delete_profile_by_id(profile_id)
