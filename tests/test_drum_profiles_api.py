"""HTTP tests for /api/drums/profiles and active_drum_profile.

INIT-003/SPEC-002. Persist via lib/drum_profiles.py helpers.
INIT-007/SPEC-003: scoring.precision_mode GET/PUT round-trip.
"""

from __future__ import annotations

import importlib
import json
import re
import sys
import threading
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from routers import settings as settings_router


@pytest.fixture()
def env(tmp_path, monkeypatch, isolate_logging):
    monkeypatch.setenv("CONFIG_DIR", str(tmp_path))
    monkeypatch.setenv("FEEDBACK_SKIP_STARTUP_TASKS", "1")
    sys.modules.pop("server", None)
    srv = importlib.import_module("server")
    from routers import drums as drums_router
    drums_router.reset_scoring_session_for_tests()
    try:
        yield srv, tmp_path
    finally:
        conn = getattr(getattr(srv, "meta_db", None), "conn", None)
        if conn is not None:
            getattr(sys.modules.get("server"), "_join_background_db_threads", lambda: None)()
            conn.close()
        sys.modules.pop("server", None)


@pytest.fixture()
def client(env):
    srv, _tmp = env
    c = TestClient(srv.app)
    try:
        yield c
    finally:
        c.close()


def _cfg(tmp_path: Path) -> dict:
    path = tmp_path / "config.json"
    if not path.is_file():
        return {}
    return json.loads(path.read_text())


def _profile_body(
    profile_id: str = "living-room",
    name: str = "Living room",
    kit_id: str = "alesis-strata-prime",
    source_id: str = "web-midi::pad-1",
    **overrides,
) -> dict:
    body = {
        "id": profile_id,
        "name": name,
        "kit_id": kit_id,
        "device": {"source_id": source_id, "enabled": True},
        "input": {"midi_channel": -1, "hit_detection": False, "synth_volume": 0.7},
        "highway": {
            "2d": {"lane_preset": "phase_shift_8", "show_lane_labels": True},
            "3d": {
                "palette": "default",
                "camera_angle": 0.35,
                "theme": "default",
                "fx": {},
                "lanes": [],
                "fallbacks": {},
            },
        },
    }
    body.update(overrides)
    return body


def _user_kit_body(kit_id: str = "my-ekit", name: str = "My e-kit") -> dict:
    return {
        "id": kit_id,
        "name": name,
        "verified": False,
        "notes": {"38": "snare", "36": "kick"},
        "hihat": {"pedal_cc": None, "open": "hh_open", "closed": "hh_closed", "pedal": "hh_pedal"},
    }


# ── ac-1: collection + item CRUD ─────────────────────────────────────────────


def test_list_profiles_empty_on_fresh_install(client):
    r = client.get("/api/drums/profiles")
    assert r.status_code == 200, r.text
    assert r.json() == {"profiles": []}


def test_put_get_delete_profile_round_trip(client, env):
    _srv, tmp = env
    body = _profile_body()
    r = client.put("/api/drums/profiles/living-room", json=body)
    assert r.status_code == 200, r.text
    got = r.json()
    assert got["id"] == "living-room"
    assert got["kit_id"] == "alesis-strata-prime"
    assert got["device"]["source_id"] == "web-midi::pad-1"
    assert "notes" not in got

    dest = tmp / "drums" / "profiles" / "living-room.json"
    assert dest.is_file()
    on_disk = json.loads(dest.read_text())
    assert on_disk["id"] == "living-room"
    assert "notes" not in on_disk

    listed = client.get("/api/drums/profiles")
    assert listed.status_code == 200
    ids = [p["id"] for p in listed.json()["profiles"]]
    assert ids == ["living-room"]

    one = client.get("/api/drums/profiles/living-room")
    assert one.status_code == 200
    assert one.json()["name"] == "Living room"

    deleted = client.delete("/api/drums/profiles/living-room")
    assert deleted.status_code == 200
    assert deleted.json() == {"ok": True}
    assert not dest.exists()
    assert client.get("/api/drums/profiles/living-room").status_code == 404


def test_collection_put_uses_body_id(client, env):
    _srv, tmp = env
    r = client.put("/api/drums/profiles", json=_profile_body(profile_id="studio"))
    assert r.status_code == 200, r.text
    assert r.json()["id"] == "studio"
    assert (tmp / "drums" / "profiles" / "studio.json").is_file()


def test_collection_delete_requires_id_query(client, env):
    client.put("/api/drums/profiles/living-room", json=_profile_body())
    missing = client.delete("/api/drums/profiles")
    assert missing.status_code == 400
    gone = client.delete("/api/drums/profiles", params={"id": "living-room"})
    assert gone.status_code == 200
    assert client.get("/api/drums/profiles/living-room").status_code == 404


def test_get_unknown_profile_is_404(client):
    assert client.get("/api/drums/profiles/no-such").status_code == 404


# ── ac-2: kit_id must be a loaded kit ────────────────────────────────────────


def test_put_unknown_kit_id_is_400(client, env):
    r = client.put(
        "/api/drums/profiles/living-room",
        json=_profile_body(kit_id="not-a-real-kit"),
    )
    assert r.status_code == 400
    assert "kit" in r.json()["detail"]
    _srv, tmp = env
    assert not (tmp / "drums" / "profiles" / "living-room.json").exists()


def test_put_empty_kit_id_is_allowed(client):
    r = client.put(
        "/api/drums/profiles/unassigned",
        json=_profile_body(profile_id="unassigned", kit_id=""),
    )
    assert r.status_code == 200, r.text
    assert r.json()["kit_id"] == ""


# ── notes rejected ───────────────────────────────────────────────────────────


def test_put_rejects_notes_in_profile_body(client, env):
    body = _profile_body(notes={"24": "kick"})
    r = client.put("/api/drums/profiles/living-room", json=body)
    assert r.status_code in (400, 422)
    _srv, tmp = env
    assert not (tmp / "drums" / "profiles" / "living-room.json").exists()


def test_put_rejects_dangerous_keys(client):
    body = _profile_body()
    body["__proto__"] = {"x": 1}
    r = client.put("/api/drums/profiles/living-room", json=body)
    assert r.status_code == 400


def test_put_rejects_oversized_body(client):
    body = _profile_body(name="x" * (65 * 1024))
    r = client.put("/api/drums/profiles/living-room", json=body)
    assert r.status_code == 413


# ── ac-5: path containment ───────────────────────────────────────────────────


def test_traversal_profile_id_is_400(client, env):
    _srv, tmp = env
    r = client.put("/api/drums/profiles/%2e%2e%2fconfig", json=_profile_body())
    assert r.status_code == 400
    r2 = client.put("/api/drums/profiles/foo%2Fbar", json=_profile_body())
    assert r2.status_code == 400
    r3 = client.get("/api/drums/profiles/../config")
    # Starlette collapses `../` before the handler; 404 (no such route) is
    # also contained — the write checks above are the load-bearing ones.
    assert r3.status_code in (400, 404)
    assert not (tmp / "config.json").exists() or "living-room" not in (
        (tmp / "config.json").read_text() if (tmp / "config.json").is_file() else ""
    )
    profiles_root = tmp / "drums" / "profiles"
    if profiles_root.exists():
        assert list(profiles_root.glob("*.json")) == []
    assert not (tmp / "config").exists()


# ── ac-6: source_id is logical ───────────────────────────────────────────────


def test_put_rejects_raw_port_label_source_id(client):
    r = client.put(
        "/api/drums/profiles/living-room",
        json=_profile_body(source_id="MIDIIN2 (Alesis)"),
    )
    assert r.status_code == 400
    assert "source" in r.json()["detail"] or "midi" in r.json()["detail"]


def test_get_response_source_id_is_logical(client):
    client.put("/api/drums/profiles/living-room", json=_profile_body())
    got = client.get("/api/drums/profiles/living-room").json()
    assert got["device"]["source_id"] == "web-midi::pad-1"
    assert " " not in got["device"]["source_id"]
    assert "(" not in got["device"]["source_id"]


# ── ac-3 / ac-8: active_drum_profile dual-write + A then B ───────────────────


def test_active_drum_profile_dual_writes_active_kit(client, env):
    _srv, tmp = env
    assert client.put("/api/drums/profiles/living-room", json=_profile_body()).status_code == 200
    r = client.post("/api/settings", json={"active_drum_profile": "living-room"})
    assert r.status_code == 200, r.text
    assert "error" not in r.json()
    cfg = _cfg(tmp)
    assert cfg["active_drum_profile"] == "living-room"
    assert cfg["active_kit"] == "alesis-strata-prime"
    got = client.get("/api/settings").json()
    assert got["active_drum_profile"] == "living-room"
    assert got["active_kit"] == "alesis-strata-prime"


def test_activate_a_then_b_active_kit_matches_b(client, env):
    """Parity fixture for REQ-016 / ac-8."""
    _srv, tmp = env
    kit_b = client.put("/api/drums/kits/my-ekit", json=_user_kit_body())
    assert kit_b.status_code == 200, kit_b.text
    assert client.put(
        "/api/drums/profiles/profile-a",
        json=_profile_body(profile_id="profile-a", name="A", kit_id="alesis-strata-prime"),
    ).status_code == 200
    assert client.put(
        "/api/drums/profiles/profile-b",
        json=_profile_body(profile_id="profile-b", name="B", kit_id="my-ekit"),
    ).status_code == 200

    first = client.post("/api/settings", json={"active_drum_profile": "profile-a"})
    assert first.status_code == 200, first.text
    assert client.get("/api/settings").json()["active_kit"] == "alesis-strata-prime"

    second = client.post("/api/settings", json={"active_drum_profile": "profile-b"})
    assert second.status_code == 200, second.text
    settings = client.get("/api/settings").json()
    assert settings["active_drum_profile"] == "profile-b"
    assert settings["active_kit"] == "my-ekit"
    assert _cfg(tmp)["active_kit"] == "my-ekit"


def test_active_drum_profile_unknown_is_400(client, env):
    r = client.post("/api/settings", json={"active_drum_profile": "missing"})
    assert r.status_code == 400
    assert "active_drum_profile" not in _cfg(env[1])


def test_active_drum_profile_absent_on_fresh_install(client):
    got = client.get("/api/settings").json()
    assert "active_drum_profile" not in got


def test_active_drum_profile_null_unsets(client, env):
    client.put("/api/drums/profiles/living-room", json=_profile_body())
    client.post("/api/settings", json={"active_drum_profile": "living-room"})
    r = client.post("/api/settings", json={"active_drum_profile": None})
    assert r.status_code == 200, r.text
    assert "active_drum_profile" not in _cfg(env[1])
    assert "active_drum_profile" not in client.get("/api/settings").json()


# ── delete-active rule: 400 ──────────────────────────────────────────────────


def test_delete_active_profile_is_400(client, env):
    _srv, tmp = env
    client.put("/api/drums/profiles/living-room", json=_profile_body())
    client.put(
        "/api/drums/profiles/spare",
        json=_profile_body(profile_id="spare", name="Spare"),
    )
    client.post("/api/settings", json={"active_drum_profile": "living-room"})
    r = client.delete("/api/drums/profiles/living-room")
    assert r.status_code == 400
    assert (tmp / "drums" / "profiles" / "living-room.json").is_file()
    # Non-active sibling still deletes.
    assert client.delete("/api/drums/profiles/spare").status_code == 200


# ── ac-7: import does not ingest profiles as kits ────────────────────────────


def test_settings_import_profile_is_not_written_as_kit(client, env):
    _srv, tmp = env
    profile = _profile_body()
    r = client.post("/api/settings/import", json={
        "schema": settings_router.SETTINGS_BUNDLE_SCHEMA,
        "server_config": {},
        "core_server_files": {
            "drums/profiles/living-room.json": {"encoding": "json", "data": profile},
        },
    })
    assert r.status_code == 200, r.json()
    assert (tmp / "drums" / "profiles" / "living-room.json").is_file()
    assert not (tmp / "drums" / "living-room.json").exists()
    on_disk = json.loads((tmp / "drums" / "profiles" / "living-room.json").read_text())
    assert "notes" not in on_disk
    assert on_disk["id"] == "living-room"
    kits = {k["id"] for k in client.get("/api/drums/kits").json()["kits"]}
    assert "living-room" not in kits


def test_settings_import_rejects_notes_on_profile_path(client, env):
    _srv, tmp = env
    body = _profile_body(notes={"24": "kick"})
    r = client.post("/api/settings/import", json={
        "schema": settings_router.SETTINGS_BUNDLE_SCHEMA,
        "server_config": {},
        "core_server_files": {
            "drums/profiles/evil.json": {"encoding": "json", "data": body},
        },
    })
    assert r.status_code == 400, r.json()
    assert not (tmp / "drums" / "profiles" / "evil.json").exists()
    assert not (tmp / "drums" / "evil.json").exists()


def test_settings_export_redacts_raw_port_label_profile(client, env):
    _srv, tmp = env
    dest = tmp / "drums" / "profiles"
    dest.mkdir(parents=True)
    planted = _profile_body()
    planted["device"]["source_id"] = "MIDIIN2 (Alesis)"
    (dest / "planted.json").write_text(json.dumps(planted), encoding="utf-8")
    client.put("/api/drums/profiles/living-room", json=_profile_body())

    r = client.get("/api/settings/export")
    assert r.status_code == 200, r.text
    core = r.json().get("core_server_files") or {}
    assert "drums/profiles/planted.json" not in core
    exported = core["drums/profiles/living-room.json"]["data"]
    assert exported["device"]["source_id"] == "web-midi::pad-1"
    dumped = json.dumps(core)
    assert "MIDIIN2" not in dumped
    assert "(" not in exported["device"]["source_id"]


def test_scoring_session_get_and_invalid_state(client):
    got = client.get("/api/drums/scoring-session")
    assert got.status_code == 200
    assert got.json()["state"] == "stopped"
    assert got.json()["learn_locked"] is False
    bad = client.put("/api/drums/scoring-session", json={"state": "rewinding"})
    assert bad.status_code == 400
    reserved = client.put(
        "/api/drums/scoring-session", json={"state": "stopped", "__proto__": {"x": 1}}
    )
    assert reserved.status_code == 400


def test_put_profile_rejects_non_json_and_non_object(client):
    r = client.put(
        "/api/drums/profiles/living-room",
        content=b"not-json",
        headers={"content-type": "application/json"},
    )
    assert r.status_code == 400
    r2 = client.put(
        "/api/drums/profiles/living-room",
        content=b'["nope"]',
        headers={"content-type": "application/json"},
    )
    assert r2.status_code == 400


def test_delete_unknown_profile_is_404(client):
    assert client.delete("/api/drums/profiles/no-such").status_code == 404


# ── concurrent PUTs to different ids ─────────────────────────────────────────


def test_concurrent_puts_to_different_profile_ids(client, env):
    results: dict[str, int] = {}
    barrier = threading.Barrier(2)

    def _write(pid: str) -> None:
        barrier.wait(timeout=5)
        resp = client.put(
            f"/api/drums/profiles/{pid}",
            json=_profile_body(profile_id=pid, name=pid),
        )
        results[pid] = resp.status_code

    t1 = threading.Thread(target=_write, args=("alpha",))
    t2 = threading.Thread(target=_write, args=("beta",))
    t1.start()
    t2.start()
    t1.join(timeout=10)
    t2.join(timeout=10)
    assert results == {"alpha": 200, "beta": 200}
    listed = {p["id"] for p in client.get("/api/drums/profiles").json()["profiles"]}
    assert listed == {"alpha", "beta"}


# ── INIT-007/SPEC-003: scoring.precision_mode HTTP round-trip ─────────────────


def test_get_and_list_include_precision_mode_boolean(client):
    r = client.put("/api/drums/profiles/living-room", json=_profile_body())
    assert r.status_code == 200, r.text
    assert r.json()["scoring"]["precision_mode"] is False

    one = client.get("/api/drums/profiles/living-room")
    assert one.status_code == 200
    scoring = one.json()["scoring"]
    assert scoring == {"precision_mode": False}
    assert isinstance(scoring["precision_mode"], bool)

    listed = client.get("/api/drums/profiles")
    assert listed.status_code == 200
    assert listed.json()["profiles"][0]["scoring"]["precision_mode"] is False


def test_put_without_scoring_preserves_stored_precision_mode(client, env):
    seeded = client.put(
        "/api/drums/profiles/living-room",
        json=_profile_body(scoring={"precision_mode": True}),
    )
    assert seeded.status_code == 200, seeded.text
    assert seeded.json()["scoring"]["precision_mode"] is True

    update = _profile_body(name="Renamed room")
    update["highway"] = {
        "2d": {"lane_preset": "rb4", "show_lane_labels": False},
        "3d": {
            "palette": "default",
            "camera_angle": 0.4,
            "theme": "default",
            "fx": {},
            "lanes": [],
            "fallbacks": {},
        },
    }
    assert "scoring" not in update
    r = client.put("/api/drums/profiles/living-room", json=update)
    assert r.status_code == 200, r.text
    assert r.json()["name"] == "Renamed room"
    assert r.json()["scoring"]["precision_mode"] is True
    assert r.json()["highway"]["2d"]["lane_preset"] == "rb4"

    got = client.get("/api/drums/profiles/living-room")
    assert got.status_code == 200
    assert got.json()["scoring"]["precision_mode"] is True

    _srv, tmp = env
    on_disk = json.loads(
        (tmp / "drums" / "profiles" / "living-room.json").read_text(encoding="utf-8")
    )
    assert on_disk["scoring"]["precision_mode"] is True


def test_put_precision_mode_true_persists(client, env):
    body = _profile_body(scoring={"precision_mode": True})
    r = client.put("/api/drums/profiles/living-room", json=body)
    assert r.status_code == 200, r.text
    assert r.json()["scoring"]["precision_mode"] is True

    one = client.get("/api/drums/profiles/living-room")
    assert one.status_code == 200
    assert one.json()["scoring"]["precision_mode"] is True

    listed = client.get("/api/drums/profiles")
    assert listed.status_code == 200
    assert listed.json()["profiles"][0]["scoring"]["precision_mode"] is True

    _srv, tmp = env
    dest = tmp / "drums" / "profiles" / "living-room.json"
    on_disk = json.loads(dest.read_text(encoding="utf-8"))
    assert on_disk["scoring"] == {"precision_mode": True}


def test_drum_profile_routers_have_no_print():
    routers = Path(__file__).resolve().parents[1] / "lib" / "routers"
    banned = re.compile(r"(^|[^A-Za-z0-9_])(print|traceback\.print_exc)\s*\(")
    offenders = []
    for path in sorted(routers.rglob("*.py")):
        text = path.read_text(encoding="utf-8")
        for i, line in enumerate(text.splitlines(), 1):
            if banned.search(line):
                offenders.append(f"{path.name}:{i}:{line.strip()}")
    assert offenders == []
