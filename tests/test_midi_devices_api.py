"""HTTP tests for /api/midi/devices, device-types, and active_midi_device.

INIT-003/SPEC-009. Persist via lib/midi_devices.py helpers. Reuses the
SPEC-002 scoring-session Learn lock.
"""

from __future__ import annotations

import importlib
import json
import sys
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


def _device_body(
    device_id: str = "living-room-ekit",
    name: str = "Living room e-kit",
    source_id: str = "web-midi::pad-1",
    **overrides,
) -> dict:
    body = {
        "id": device_id,
        "name": name,
        "source_id": source_id,
        "device_type_id": "alesis-strata-prime",
        "family": "drums",
        "notes": {},
        "input": {"midi_channel": -1, "hit_detection": False, "synth_volume": 0.7},
    }
    body.update(overrides)
    return body


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


def _create_device(client, **overrides) -> dict:
    body = _device_body(**overrides)
    r = client.put(f"/api/midi/devices/{body['id']}", json=body)
    assert r.status_code == 200, r.text
    return r.json()


# ── ac-1: device-type catalogs, no notes map ─────────────────────────────────


def test_list_device_types_has_prime_and_no_notes(client):
    r = client.get("/api/midi/device-types")
    assert r.status_code == 200, r.text
    types = r.json()["device_types"]
    ids = [t["id"] for t in types]
    assert "alesis-strata-prime" in ids
    assert "generic" in ids
    for catalog in types:
        assert "notes" not in catalog
        assert "triggers" in catalog
        blob = json.dumps(catalog)
        assert '"24"' not in blob
        assert '"38"' not in blob


def test_get_device_type_prime_has_triggers_no_notes(client):
    r = client.get("/api/midi/device-types/alesis-strata-prime")
    assert r.status_code == 200, r.text
    catalog = r.json()
    assert catalog["id"] == "alesis-strata-prime"
    assert catalog["family"] == "drums"
    assert "notes" not in catalog
    trigger_ids = [t["id"] for t in catalog["triggers"]]
    assert "kick" in trigger_ids
    assert "snare" in trigger_ids


def test_get_device_type_generic_has_empty_triggers(client):
    r = client.get("/api/midi/device-types/generic")
    assert r.status_code == 200, r.text
    catalog = r.json()
    assert catalog["id"] == "generic"
    assert catalog["name"] == "Generic"
    assert catalog["family"] == "drums"
    assert catalog["triggers"] == []
    assert "notes" not in catalog


def test_get_unknown_device_type_is_404(client):
    assert client.get("/api/midi/device-types/no-such-type").status_code == 404


def test_get_device_type_traversal_is_400(client):
    r = client.get("/api/midi/device-types/../config")
    # Starlette may collapse `../` before the handler (404) or pass it through (400).
    assert r.status_code in (400, 404)
    r2 = client.get("/api/midi/device-types/%2e%2e%2fconfig")
    assert r2.status_code == 400


# ── ac-2: device CRUD + create-from-type empty notes ─────────────────────────


def test_list_devices_empty_on_fresh_install(client):
    r = client.get("/api/midi/devices")
    assert r.status_code == 200, r.text
    assert r.json() == {"devices": []}


def test_put_get_delete_device_round_trip(client, env):
    _srv, tmp = env
    body = _device_body(notes={"36": "kick"})
    r = client.put("/api/midi/devices/living-room-ekit", json=body)
    assert r.status_code == 200, r.text
    got = r.json()
    assert got["id"] == "living-room-ekit"
    assert got["notes"] == {"36": "kick"}
    assert got["source_id"] == "web-midi::pad-1"
    dest = tmp / "midi" / "devices" / "living-room-ekit.json"
    assert dest.is_file()
    listed = client.get("/api/midi/devices")
    assert listed.status_code == 200
    ids = [d["id"] for d in listed.json()["devices"]]
    assert ids == ["living-room-ekit"]
    one = client.get("/api/midi/devices/living-room-ekit")
    assert one.status_code == 200
    assert one.json()["name"] == "Living room e-kit"
    trigger_ids = [t["id"] for t in one.json()["triggers"]]
    assert "kick" in trigger_ids
    assert "snare" in trigger_ids
    deleted = client.delete("/api/midi/devices/living-room-ekit")
    assert deleted.status_code == 200
    assert deleted.json() == {"ok": True}
    assert not dest.exists()
    assert client.get("/api/midi/devices/living-room-ekit").status_code == 404


def test_collection_put_uses_body_id(client, env):
    _srv, tmp = env
    r = client.put("/api/midi/devices", json=_device_body(device_id="studio"))
    assert r.status_code == 200, r.text
    assert r.json()["id"] == "studio"
    assert (tmp / "midi" / "devices" / "studio.json").is_file()


def test_collection_delete_requires_id_query(client):
    _create_device(client)
    missing = client.delete("/api/midi/devices")
    assert missing.status_code == 400
    gone = client.delete("/api/midi/devices", params={"id": "living-room-ekit"})
    assert gone.status_code == 200
    assert client.get("/api/midi/devices/living-room-ekit").status_code == 404


def test_create_from_type_empty_notes_despite_shipped_kit(client, env):
    _srv, tmp = env
    r = client.post("/api/midi/devices", json={
        "id": "from-prime",
        "device_type_id": "alesis-strata-prime",
        "name": "From Prime",
        "notes": {"24": "kick"},
    })
    assert r.status_code == 200, r.text
    got = r.json()
    assert got["notes"] == {}
    on_disk = json.loads((tmp / "midi" / "devices" / "from-prime.json").read_text())
    assert on_disk["notes"] == {}
    kit_notes = json.loads(
        Path(__file__).resolve().parents[1].joinpath(
            "data", "drums", "kits", "alesis-strata-prime.json"
        ).read_text()
    )["notes"]
    assert kit_notes
    assert got["notes"] != kit_notes


def test_put_without_notes_creates_from_type_empty_map(client, env):
    _srv, tmp = env
    body = {
        "id": "blank-map",
        "name": "Blank",
        "device_type_id": "alesis-strata-prime",
        "family": "drums",
        "source_id": "web-midi::pad-1",
    }
    r = client.put("/api/midi/devices/blank-map", json=body)
    assert r.status_code == 200, r.text
    assert r.json()["notes"] == {}
    on_disk = json.loads((tmp / "midi" / "devices" / "blank-map.json").read_text())
    assert on_disk["notes"] == {}


def test_put_unknown_type_is_400(client, env):
    r = client.put(
        "/api/midi/devices/x",
        json=_device_body(device_id="x", device_type_id="no-such-type"),
    )
    assert r.status_code == 400
    _srv, tmp = env
    assert not (tmp / "midi" / "devices" / "x.json").exists()


def test_get_unknown_device_is_404(client):
    assert client.get("/api/midi/devices/no-such").status_code == 404


# ── ac-3: atomic note mutations + Learn lock 409 ─────────────────────────────


def test_put_delete_device_note_round_trip(client, env):
    _create_device(client)
    r = client.put(
        "/api/midi/devices/living-room-ekit/notes/36",
        json={"piece_id": "kick"},
    )
    assert r.status_code == 200, r.text
    assert r.json()["device"]["notes"]["36"] == "kick"
    assert r.json()["mutation"] == {
        "midi_note": 36, "operation": "set", "piece_id": "kick",
    }
    _srv, tmp = env
    on_disk = json.loads((tmp / "midi" / "devices" / "living-room-ekit.json").read_text())
    assert on_disk["notes"]["36"] == "kick"
    d = client.delete("/api/midi/devices/living-room-ekit/notes/36")
    assert d.status_code == 200, d.text
    assert "36" not in d.json()["device"]["notes"]
    after = json.loads((tmp / "midi" / "devices" / "living-room-ekit.json").read_text())
    assert after["notes"] == {}


def test_put_note_piece_not_in_catalog_is_400(client, env):
    _create_device(client)
    r = client.put(
        "/api/midi/devices/living-room-ekit/notes/60",
        json={"piece_id": "stack"},
    )
    assert r.status_code == 400
    _srv, tmp = env
    on_disk = json.loads((tmp / "midi" / "devices" / "living-room-ekit.json").read_text())
    assert on_disk["notes"] == {}


def test_put_note_piece_not_on_device_triggers_is_400(client, env):
    _create_device(client, triggers=[{"id": "kick", "name": "Kick"}], notes={})
    r = client.put(
        "/api/midi/devices/living-room-ekit/notes/38",
        json={"piece_id": "snare"},
    )
    assert r.status_code == 400
    _srv, tmp = env
    on_disk = json.loads((tmp / "midi" / "devices" / "living-room-ekit.json").read_text())
    assert on_disk["notes"] == {}


def test_put_note_custom_trigger_after_put_triggers(client, env):
    _create_device(
        client,
        triggers=[{"id": "cowbell", "name": "Cowbell"}],
        notes={},
    )
    r = client.put(
        "/api/midi/devices/living-room-ekit/notes/56",
        json={"piece_id": "cowbell"},
    )
    assert r.status_code == 200, r.text
    assert r.json()["device"]["notes"]["56"] == "cowbell"
    assert r.json()["device"]["triggers"] == [{"id": "cowbell", "name": "Cowbell"}]
    _srv, tmp = env
    on_disk = json.loads((tmp / "midi" / "devices" / "living-room-ekit.json").read_text())
    assert on_disk["notes"]["56"] == "cowbell"


def test_type_change_put_without_notes_resets_triggers(client, env):
    created = client.post("/api/midi/devices", json={
        "id": "kit-1",
        "device_type_id": "alesis-strata-prime",
        "name": "Kit",
    })
    assert created.status_code == 200, created.text
    assert "kick" in [t["id"] for t in created.json()["triggers"]]
    custom = _device_body(
        device_id="kit-1",
        name="Kit",
        notes={"36": "kick"},
        triggers=[{"id": "cowbell", "name": "Cowbell"}],
    )
    assert client.put("/api/midi/devices/kit-1", json=custom).status_code == 200
    r = client.put("/api/midi/devices/kit-1", json={
        "id": "kit-1",
        "name": "Kit",
        "device_type_id": "generic",
        "family": "drums",
        "source_id": "web-midi::pad-1",
    })
    assert r.status_code == 200, r.text
    assert r.json()["device_type_id"] == "generic"
    assert r.json()["notes"] == {}
    assert r.json()["triggers"] == []
    _srv, tmp = env
    on_disk = json.loads((tmp / "midi" / "devices" / "kit-1.json").read_text())
    assert on_disk["notes"] == {}
    assert on_disk["triggers"] == []


def test_put_note_conflicts_while_scoring_session_playing(client, env):
    _create_device(client)
    seed = client.put(
        "/api/midi/devices/living-room-ekit/notes/36",
        json={"piece_id": "kick"},
    )
    assert seed.status_code == 200, seed.text
    _srv, tmp = env
    dest = tmp / "midi" / "devices" / "living-room-ekit.json"
    before = json.loads(dest.read_text())

    lock = client.put("/api/drums/scoring-session", json={"state": "playing"})
    assert lock.status_code == 200
    assert lock.json()["learn_locked"] is True

    r = client.put(
        "/api/midi/devices/living-room-ekit/notes/38",
        json={"piece_id": "snare"},
    )
    assert r.status_code == 409
    assert "device notes" in r.json()["detail"]
    after = json.loads(dest.read_text())
    assert after == before
    got = client.get("/api/midi/devices/living-room-ekit")
    assert "38" not in got.json()["notes"]


def test_delete_note_conflicts_while_scoring_session_paused(client, env):
    _create_device(client)
    client.put(
        "/api/midi/devices/living-room-ekit/notes/38",
        json={"piece_id": "snare"},
    )
    _srv, tmp = env
    dest = tmp / "midi" / "devices" / "living-room-ekit.json"
    before = json.loads(dest.read_text())
    client.put("/api/drums/scoring-session", json={"state": "paused"})
    r = client.delete("/api/midi/devices/living-room-ekit/notes/38")
    assert r.status_code == 409
    after = json.loads(dest.read_text())
    assert after == before
    assert client.get("/api/midi/devices/living-room-ekit").json()["notes"]["38"] == "snare"


def test_put_device_conflicts_while_scoring_session_playing(client, env):
    _create_device(client, notes={"36": "kick"})
    _srv, tmp = env
    dest = tmp / "midi" / "devices" / "living-room-ekit.json"
    before = json.loads(dest.read_text())
    client.put("/api/drums/scoring-session", json={"state": "playing"})
    r = client.put(
        "/api/midi/devices/living-room-ekit",
        json=_device_body(notes={"60": "ride"}),
    )
    assert r.status_code == 409
    after = json.loads(dest.read_text())
    assert after == before


def test_delete_device_conflicts_while_scoring_session_playing(client, env):
    _create_device(client)
    _srv, tmp = env
    dest = tmp / "midi" / "devices" / "living-room-ekit.json"
    client.put("/api/drums/scoring-session", json={"state": "playing"})
    r = client.delete("/api/midi/devices/living-room-ekit")
    assert r.status_code == 409
    assert dest.is_file()


def test_note_mutations_succeed_after_scoring_session_stopped(client):
    _create_device(client)
    client.put("/api/drums/scoring-session", json={"state": "playing"})
    client.put("/api/drums/scoring-session", json={"state": "stopped"})
    r = client.put(
        "/api/midi/devices/living-room-ekit/notes/36",
        json={"piece_id": "kick"},
    )
    assert r.status_code == 200, r.text
    d = client.delete("/api/midi/devices/living-room-ekit/notes/36")
    assert d.status_code == 200, d.text


# ── ac-4: active_midi_device pointer + profile dual-write ────────────────────


def test_active_midi_device_persists(client, env):
    _create_device(client)
    r = client.post("/api/settings", json={"active_midi_device": "living-room-ekit"})
    assert r.status_code == 200, r.text
    assert "error" not in r.json()
    cfg = _cfg(env[1])
    assert cfg["active_midi_device"] == "living-room-ekit"
    got = client.get("/api/settings").json()
    assert got["active_midi_device"] == "living-room-ekit"


def test_activate_profile_with_device_id_dual_writes_pointer(client, env):
    _create_device(client)
    body = _profile_body(device_id="living-room-ekit")
    assert client.put("/api/drums/profiles/living-room", json=body).status_code == 200
    r = client.post("/api/settings", json={"active_drum_profile": "living-room"})
    assert r.status_code == 200, r.text
    cfg = _cfg(env[1])
    assert cfg["active_drum_profile"] == "living-room"
    assert cfg["active_midi_device"] == "living-room-ekit"
    got = client.get("/api/settings").json()
    assert got["active_midi_device"] == "living-room-ekit"


def test_active_midi_device_unknown_is_400(client, env):
    r = client.post("/api/settings", json={"active_midi_device": "missing"})
    assert r.status_code == 400
    assert "active_midi_device" not in _cfg(env[1])


def test_active_midi_device_absent_on_fresh_install(client):
    got = client.get("/api/settings").json()
    assert "active_midi_device" not in got


def test_active_midi_device_null_unsets(client, env):
    _create_device(client)
    client.post("/api/settings", json={"active_midi_device": "living-room-ekit"})
    r = client.post("/api/settings", json={"active_midi_device": None})
    assert r.status_code == 200, r.text
    assert "active_midi_device" not in _cfg(env[1])
    assert "active_midi_device" not in client.get("/api/settings").json()


# ── ac-5: profile notes still 400; unknown device_id 400 ─────────────────────


def test_put_profile_unknown_device_id_is_400(client, env):
    r = client.put(
        "/api/drums/profiles/living-room",
        json=_profile_body(device_id="no-such-device"),
    )
    assert r.status_code == 400
    assert "device_id" in r.json()["detail"]
    _srv, tmp = env
    assert not (tmp / "drums" / "profiles" / "living-room.json").exists()


def test_put_profile_notes_still_400(client, env):
    _create_device(client)
    r = client.put(
        "/api/drums/profiles/living-room",
        json=_profile_body(device_id="living-room-ekit", notes={"24": "kick"}),
    )
    assert r.status_code == 400
    _srv, tmp = env
    assert not (tmp / "drums" / "profiles" / "living-room.json").exists()


def test_put_profile_known_device_id_round_trips(client):
    _create_device(client)
    r = client.put(
        "/api/drums/profiles/living-room",
        json=_profile_body(device_id="living-room-ekit"),
    )
    assert r.status_code == 200, r.text
    assert r.json()["device_id"] == "living-room-ekit"
    got = client.get("/api/drums/profiles/living-room")
    assert got.json()["device_id"] == "living-room-ekit"
    assert "notes" not in got.json()


def test_put_profile_unknown_kit_id_still_400(client):
    r = client.put(
        "/api/drums/profiles/living-room",
        json=_profile_body(kit_id="not-a-real-kit"),
    )
    assert r.status_code == 400
    assert "kit" in r.json()["detail"]


# ── ac-6: delete-active-device is 400 ────────────────────────────────────────


def test_delete_active_device_is_400(client, env):
    _create_device(client)
    _create_device(client, device_id="spare", name="Spare")
    client.post("/api/settings", json={"active_midi_device": "living-room-ekit"})
    r = client.delete("/api/midi/devices/living-room-ekit")
    assert r.status_code == 400
    _srv, tmp = env
    assert (tmp / "midi" / "devices" / "living-room-ekit.json").is_file()
    assert client.delete("/api/midi/devices/spare").status_code == 200
    client.post("/api/settings", json={"active_midi_device": None})
    assert client.delete("/api/midi/devices/living-room-ekit").status_code == 200


def test_delete_active_then_activate_other_allows_delete(client, env):
    _create_device(client)
    _create_device(client, device_id="other", name="Other")
    client.post("/api/settings", json={"active_midi_device": "living-room-ekit"})
    assert client.delete("/api/midi/devices/living-room-ekit").status_code == 400
    client.post("/api/settings", json={"active_midi_device": "other"})
    r = client.delete("/api/midi/devices/living-room-ekit")
    assert r.status_code == 200, r.text
    assert client.get("/api/midi/devices/living-room-ekit").status_code == 404


# ── Security / edge: proto keys, traversal, midi range, export ───────────────


def test_put_device_rejects_proto_keys(client, env):
    body = _device_body()
    body["__proto__"] = {"x": 1}
    r = client.put("/api/midi/devices/living-room-ekit", json=body)
    assert r.status_code == 400
    assert not (env[1] / "midi" / "devices" / "living-room-ekit.json").exists()


def test_put_note_rejects_proto_keys(client, env):
    _create_device(client)
    r = client.put(
        "/api/midi/devices/living-room-ekit/notes/36",
        json={"piece_id": "kick", "__proto__": {"x": 1}},
    )
    assert r.status_code == 400
    on_disk = json.loads(
        (env[1] / "midi" / "devices" / "living-room-ekit.json").read_text()
    )
    assert on_disk["notes"] == {}


def test_device_id_traversal_is_400(client, env):
    r = client.put("/api/midi/devices/%2e%2e%2fconfig", json=_device_body())
    assert r.status_code == 400
    r2 = client.put("/api/midi/devices/foo%2Fbar", json=_device_body())
    assert r2.status_code == 400
    r3 = client.get("/api/midi/devices/../config")
    # Starlette collapses `../` before the handler; 404 is also contained.
    assert r3.status_code in (400, 404)
    devices_dir = env[1] / "midi" / "devices"
    if devices_dir.exists():
        assert not list(devices_dir.glob("*.json"))


def test_midi_note_out_of_range_is_400(client):
    _create_device(client)
    assert client.put(
        "/api/midi/devices/living-room-ekit/notes/128",
        json={"piece_id": "kick"},
    ).status_code == 400
    assert client.put(
        "/api/midi/devices/living-room-ekit/notes/-1",
        json={"piece_id": "kick"},
    ).status_code == 400
    assert client.delete("/api/midi/devices/living-room-ekit/notes/foo").status_code == 400


def test_settings_export_device_source_id_logical_only(client, env):
    _create_device(client)
    dest = env[1] / "midi" / "devices"
    dest.mkdir(parents=True, exist_ok=True)
    planted = _device_body(device_id="planted", name="Planted")
    planted["source_id"] = "MIDIIN2 (Alesis)"
    (dest / "planted.json").write_text(json.dumps(planted), encoding="utf-8")

    r = client.get("/api/settings/export")
    assert r.status_code == 200, r.text
    core = r.json().get("core_server_files") or {}
    assert "midi/devices/planted.json" not in core
    exported = core["midi/devices/living-room-ekit.json"]["data"]
    assert exported["source_id"] == "web-midi::pad-1"
    dumped = json.dumps(core)
    assert "MIDIIN2" not in dumped
    assert "(" not in exported["source_id"]


def test_settings_import_device_is_not_written_as_kit(client, env):
    device = _device_body(notes={"36": "kick"})
    r = client.post("/api/settings/import", json={
        "schema": settings_router.SETTINGS_BUNDLE_SCHEMA,
        "server_config": {},
        "core_server_files": {
            "midi/devices/living-room-ekit.json": {"encoding": "json", "data": device},
        },
    })
    assert r.status_code == 200, r.json()
    tmp = env[1]
    assert (tmp / "midi" / "devices" / "living-room-ekit.json").is_file()
    assert not (tmp / "drums" / "living-room-ekit.json").exists()
    kits = {k["id"] for k in client.get("/api/drums/kits").json()["kits"]}
    assert "living-room-ekit" not in kits
    got = client.get("/api/midi/devices/living-room-ekit")
    assert got.status_code == 200
    assert got.json()["notes"] == {"36": "kick"}


def test_settings_import_rejects_dangling_profile_device_id(client, env):
    r = client.post("/api/settings/import", json={
        "schema": settings_router.SETTINGS_BUNDLE_SCHEMA,
        "server_config": {},
        "core_server_files": {
            "drums/profiles/living-room.json": {
                "encoding": "json",
                "data": _profile_body(device_id="ghost-device"),
            },
        },
    })
    assert r.status_code == 400, r.json()
    assert not (env[1] / "drums" / "profiles" / "living-room.json").exists()


def test_settings_import_profile_with_bundled_device(client, env):
    r = client.post("/api/settings/import", json={
        "schema": settings_router.SETTINGS_BUNDLE_SCHEMA,
        "server_config": {},
        "core_server_files": {
            "midi/devices/living-room-ekit.json": {
                "encoding": "json",
                "data": _device_body(),
            },
            "drums/profiles/living-room.json": {
                "encoding": "json",
                "data": _profile_body(device_id="living-room-ekit"),
            },
        },
    })
    assert r.status_code == 200, r.json()
    tmp = env[1]
    assert (tmp / "midi" / "devices" / "living-room-ekit.json").is_file()
    assert (tmp / "drums" / "profiles" / "living-room.json").is_file()
    on_disk = json.loads((tmp / "drums" / "profiles" / "living-room.json").read_text())
    assert on_disk["device_id"] == "living-room-ekit"
    assert "notes" not in on_disk


def test_kit_note_routes_remain(client):
    r = client.put(
        "/api/drums/kits/alesis-strata-prime/notes/24",
        json={"piece_id": "kick"},
    )
    assert r.status_code == 200, r.text
    assert r.json()["kit"]["notes"]["24"] == "kick"


def test_list_devices_runs_overlay_kit_migrate(client, env):
    tmp = env[1]
    drums = tmp / "drums"
    drums.mkdir(parents=True)
    (drums / "user-kit.json").write_text(json.dumps({
        "id": "user-kit",
        "name": "User overlay",
        "notes": {"24": "kick", "38": "snare"},
    }), encoding="utf-8")
    r = client.get("/api/midi/devices")
    assert r.status_code == 200, r.text
    ids = [d["id"] for d in r.json()["devices"]]
    assert "user-kit" in ids
    got = client.get("/api/midi/devices/user-kit")
    assert got.status_code == 200
    assert got.json()["notes"]["24"] == "kick"
    assert (tmp / "midi" / "overlay-kit-notes-migrated").is_file()
