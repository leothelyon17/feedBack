"""HTTP tests for /api/drums/* and additive player_instrument / active_kit.

INIT-001/SPEC-002. Does not modify tests/test_settings_instrument.py —
that file must keep rejecting instrument=drums.
"""

from __future__ import annotations

import importlib
import json
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

import drums as drums_mod


@pytest.fixture()
def env(tmp_path, monkeypatch, isolate_logging):
    monkeypatch.setenv("CONFIG_DIR", str(tmp_path))
    monkeypatch.setenv("FEEDBACK_SKIP_STARTUP_TASKS", "1")
    sys.modules.pop("server", None)
    srv = importlib.import_module("server")
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


def _user_kit_body(kit_id: str = "my-ekit", name: str = "My e-kit") -> dict:
    return {
        "id": kit_id,
        "name": name,
        "manufacturer": "TestCo",
        "verified": False,
        "notes": {"38": "snare", "36": "kick"},
        "hihat": {"pedal_cc": None, "open": "hh_open", "closed": "hh_closed", "pedal": "hh_pedal"},
    }


# ── Vocabulary (ac-1) ────────────────────────────────────────────────────────

def test_vocabulary_returns_pieces_and_presets_without_a_kit(client):
    r = client.get("/api/drums/vocabulary")
    assert r.status_code == 200, r.text
    body = r.json()
    assert set(body["pieces"]) == set(drums_mod.PIECES)
    assert "kick" in body["pieces"]
    assert body["pieces"]["kick"]["midi"] == list(drums_mod.PIECES["kick"]["midi"])
    assert set(body["presets"]) == set(drums_mod.PRESETS)
    assert "path" not in json.dumps(body)


# ── Kit list / get (ac-2) ────────────────────────────────────────────────────

def test_list_kits_includes_shipped_strata_prime(client):
    r = client.get("/api/drums/kits")
    assert r.status_code == 200, r.text
    kits = {k["id"]: k for k in r.json()["kits"]}
    assert "alesis-strata-prime" in kits
    assert kits["alesis-strata-prime"]["source"] == "shipped"
    assert "/" not in json.dumps(kits["alesis-strata-prime"]) or "data/drums" not in json.dumps(
        kits["alesis-strata-prime"]
    )
    for kit in kits.values():
        assert "source" in kit
        dumped = json.dumps(kit)
        assert "data/drums/kits" not in dumped
        assert str(Path.home()) not in dumped


def test_get_kit_unknown_is_404(client):
    r = client.get("/api/drums/kits/no-such-kit")
    assert r.status_code == 404


def test_get_one_shipped_kit(client):
    r = client.get("/api/drums/kits/alesis-strata-prime")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["id"] == "alesis-strata-prime"
    assert body["source"] == "shipped"
    assert isinstance(body["notes"], dict)


# ── User kit CRUD (ac-2, ac-3, ac-4, ac-8) ───────────────────────────────────

def test_put_round_trip_user_kit(client, env):
    _srv, tmp = env
    body = _user_kit_body()
    r = client.put("/api/drums/kits/my-ekit", json=body)
    assert r.status_code == 200, r.text
    got = r.json()
    assert got["id"] == "my-ekit"
    assert got["source"] == "user"
    assert got["notes"]["38"] == "snare"

    listed = {k["id"]: k for k in client.get("/api/drums/kits").json()["kits"]}
    assert listed["my-ekit"]["source"] == "user"

    on_disk = tmp / "drums" / "my-ekit.json"
    assert on_disk.is_file()
    assert (tmp / "data").exists() is False or "kits" not in {
        p.name for p in (tmp / "data").rglob("*")
    }
    saved = json.loads(on_disk.read_text())
    assert saved["id"] == "my-ekit"

    r = client.delete("/api/drums/kits/my-ekit")
    assert r.status_code == 200, r.text
    assert not on_disk.exists()
    assert client.get("/api/drums/kits/my-ekit").status_code == 404


def test_put_rejects_traversal_and_slash_ids(client, env):
    _srv, tmp = env
    marker = tmp / "config.json"
    marker.write_text("{}")
    before = marker.read_bytes()
    drums_dir = tmp / "drums"

    r = client.put("/api/drums/kits/%2e%2e%2fconfig.json", json=_user_kit_body())
    assert r.status_code == 400, r.text
    assert marker.read_bytes() == before
    assert not (tmp / "config.json.bak").exists()

    r = client.put("/api/drums/kits/foo%2Fbar", json=_user_kit_body())
    assert r.status_code == 400, r.text
    assert marker.read_bytes() == before

    r = client.put("/api/drums/kits/NotValid", json=_user_kit_body())
    assert r.status_code == 400, r.text

    r = client.put("/api/drums/kits/kit_id", json=_user_kit_body())
    assert r.status_code == 400, r.text

    r = client.put("/api/drums/kits/kit%00id", json=_user_kit_body())
    assert r.status_code in (400, 404), r.text
    assert marker.read_bytes() == before
    if drums_dir.exists():
        assert list(drums_dir.rglob("*")) == [] or all(
            p.suffix == ".json" and p.parent == drums_dir for p in drums_dir.rglob("*")
        )


def test_put_does_not_mutate_shipped_tree(client, env):
    _srv, tmp = env
    shipped = drums_mod.SHIPPED_KITS_DIR / "alesis-strata-prime.json"
    original = shipped.read_bytes()
    overlay = _user_kit_body("alesis-strata-prime", "User overlay")
    overlay["notes"] = {"36": "kick"}
    r = client.put("/api/drums/kits/alesis-strata-prime", json=overlay)
    assert r.status_code == 200, r.text
    assert r.json()["source"] == "user"
    assert shipped.read_bytes() == original
    user_file = tmp / "drums" / "alesis-strata-prime.json"
    assert user_file.is_file()

    listed = {k["id"]: k for k in client.get("/api/drums/kits").json()["kits"]}
    assert listed["alesis-strata-prime"]["source"] == "user"

    r = client.delete("/api/drums/kits/alesis-strata-prime")
    assert r.status_code == 200, r.text
    assert shipped.read_bytes() == original
    assert not user_file.exists()
    listed = {k["id"]: k for k in client.get("/api/drums/kits").json()["kits"]}
    assert listed["alesis-strata-prime"]["source"] == "shipped"


def test_delete_shipped_without_overlay_is_forbidden(client):
    r = client.delete("/api/drums/kits/alesis-strata-prime")
    assert r.status_code == 403
    r = client.get("/api/drums/kits/alesis-strata-prime")
    assert r.status_code == 200


def test_delete_unknown_kit_is_404(client):
    r = client.delete("/api/drums/kits/no-such-kit")
    assert r.status_code == 404


def test_put_rejects_oversize_and_bad_notes(client, env):
    _srv, tmp = env
    huge = _user_kit_body()
    huge["name"] = "x" * (64 * 1024)
    r = client.put("/api/drums/kits/my-ekit", json=huge)
    assert r.status_code == 413, r.text
    assert not (tmp / "drums" / "my-ekit.json").exists()

    r = client.put("/api/drums/kits/my-ekit", json=[1, 2, 3])
    assert r.status_code == 400, r.text

    bad_notes = _user_kit_body()
    bad_notes["notes"] = {"38": 12}
    r = client.put("/api/drums/kits/my-ekit", json=bad_notes)
    assert r.status_code == 400, r.text
    assert "notes" in r.json()["detail"]

    array_map = _user_kit_body()
    array_map["notes"] = ["snare"]
    r = client.put("/api/drums/kits/my-ekit", json=array_map)
    assert r.status_code == 400, r.text

    proto = _user_kit_body()
    proto["__proto__"] = {"polluted": True}
    r = client.put("/api/drums/kits/my-ekit", json=proto)
    assert r.status_code == 400, r.text
    assert not (tmp / "drums" / "my-ekit.json").exists()

    nested = _user_kit_body()
    nested["extra"] = [{"constructor": "x"}]
    r = client.put("/api/drums/kits/my-ekit", json=nested)
    assert r.status_code == 400, r.text

    r = client.put(
        "/api/drums/kits/my-ekit",
        content=b"not-json",
        headers={"Content-Type": "application/json"},
    )
    assert r.status_code == 400, r.text

    null_notes = _user_kit_body()
    null_notes["notes"] = None
    r = client.put("/api/drums/kits/my-ekit", json=null_notes)
    assert r.status_code == 200, r.text
    assert r.json()["manufacturer"] == "TestCo"


# ── Settings keys (ac-5, ac-6) ───────────────────────────────────────────────

@pytest.mark.parametrize("value", ["guitar", "bass", "drums", "keys", "vocals"])
def test_player_instrument_accepts_enum(client, env, value):
    _srv, tmp = env
    r = client.post("/api/settings", json={"player_instrument": value})
    assert r.status_code == 200, r.text
    assert "error" not in r.json()
    assert _cfg(tmp)["player_instrument"] == value
    got = client.get("/api/settings").json()
    assert got["player_instrument"] == value


def test_player_instrument_null_unsets_and_omits_key(client, env):
    _srv, tmp = env
    client.post("/api/settings", json={"player_instrument": "drums"})
    r = client.post("/api/settings", json={"player_instrument": None})
    assert r.status_code == 200, r.text
    assert "player_instrument" not in _cfg(tmp)
    got = client.get("/api/settings").json()
    assert "player_instrument" not in got


def test_player_instrument_absent_is_omitted_on_fresh_install(client):
    got = client.get("/api/settings").json()
    assert "player_instrument" not in got
    assert "active_kit" not in got


def test_player_instrument_rejects_other_strings_with_400(client, env):
    _srv, tmp = env
    r = client.post("/api/settings", json={"player_instrument": "theremin"})
    assert r.status_code == 400, r.text
    assert "error" in r.json()
    assert "player_instrument" not in _cfg(tmp)


def test_active_kit_accepts_known_id_and_rejects_unknown(client, env):
    _srv, tmp = env
    before = client.get("/api/settings").json().get("instrument")
    r = client.post("/api/settings", json={"active_kit": "alesis-strata-prime"})
    assert r.status_code == 200, r.text
    assert _cfg(tmp)["active_kit"] == "alesis-strata-prime"
    got = client.get("/api/settings").json()
    assert got["active_kit"] == "alesis-strata-prime"
    assert got.get("instrument") == before

    r = client.post("/api/settings", json={"active_kit": "no-such-kit"})
    assert r.status_code == 400, r.text
    assert _cfg(tmp)["active_kit"] == "alesis-strata-prime"

    r = client.post("/api/settings", json={"active_kit": None})
    assert r.status_code == 200, r.text
    assert "active_kit" not in _cfg(tmp)
    assert "active_kit" not in client.get("/api/settings").json()


def test_player_instrument_drums_does_not_change_instrument(client, env):
    _srv, tmp = env
    client.post("/api/settings", json={"instrument": "guitar"})
    r = client.post("/api/settings", json={"player_instrument": "drums"})
    assert r.status_code == 200, r.text
    cfg = _cfg(tmp)
    assert cfg["player_instrument"] == "drums"
    assert cfg["instrument"] == "guitar"


def test_instrument_drums_still_rejected_via_existing_shape(client):
    """Sanity: the unmodified instrument key still refuses drums (ac-7)."""
    r = client.post("/api/settings", json={"instrument": "drums"})
    assert r.status_code == 200
    assert "error" in r.json()
