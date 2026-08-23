"""HTTP tests for /api/drums/* and additive player_instrument / active_kit.

INIT-001/SPEC-002. Does not modify tests/test_settings_instrument.py —
that file must keep rejecting instrument=drums.
"""

from __future__ import annotations

import importlib
import json
import sys
import threading
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


# ── Atomic per-note kit mutations (INIT-002/SPEC-001) ────────────────────────
# PUT/DELETE /api/drums/kits/{kit_id}/notes/{midi_note}


def test_put_note_on_shipped_kit_clones_and_leaves_shipped_untouched(client, env):
    """REQ-001: mutating a shipped kit clones its persisted shape into the
    user overlay and never writes shipped data."""
    _srv, tmp = env
    shipped = drums_mod.SHIPPED_KITS_DIR / "alesis-strata-prime.json"
    original = shipped.read_bytes()

    r = client.put("/api/drums/kits/alesis-strata-prime/notes/24", json={"piece_id": "kick"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["kit"]["source"] == "user"
    assert body["kit"]["notes"]["24"] == "kick"
    assert body["mutation"] == {"midi_note": 24, "operation": "set", "piece_id": "kick"}
    assert body["resolution"] == {"piece_id": "kick", "source": "kit"}

    assert shipped.read_bytes() == original
    user_file = tmp / "drums" / "alesis-strata-prime.json"
    assert user_file.is_file()

    # The clone preserved the shipped kit's other existing notes (Finding-2
    # remaps), not just the note we mutated.
    saved = json.loads(user_file.read_text())
    assert saved["notes"]["24"] == "kick"
    assert saved["notes"]["38"] == "tom_hi"


def test_put_note_reload_persists(client, env):
    """REQ-001: setting a note persists across a fresh load (reload parity)."""
    _srv, tmp = env
    r = client.put("/api/drums/kits/alesis-strata-prime/notes/100", json={"piece_id": "ride"})
    assert r.status_code == 200, r.text

    reloaded = client.get("/api/drums/kits/alesis-strata-prime")
    assert reloaded.status_code == 200
    assert reloaded.json()["notes"]["100"] == "ride"


def test_put_note_on_new_user_kit_via_whole_kit_put_still_works(client, env):
    """Existing whole-kit PUT/GET remains compatible alongside the new
    per-note routes (no route-ordering regression)."""
    _srv, tmp = env
    r = client.put("/api/drums/kits/my-ekit", json=_user_kit_body())
    assert r.status_code == 200, r.text

    r = client.put("/api/drums/kits/my-ekit/notes/24", json={"piece_id": "kick"})
    assert r.status_code == 200, r.text
    assert r.json()["kit"]["notes"]["24"] == "kick"
    # The whole-kit note set by the earlier PUT survives the per-note mutation.
    assert r.json()["kit"]["notes"]["38"] == "snare"


def test_put_note_unknown_kit_is_404(client):
    r = client.put("/api/drums/kits/no-such-kit/notes/24", json={"piece_id": "kick"})
    assert r.status_code == 404


def test_put_note_rejects_invalid_piece_id(client):
    r = client.put(
        "/api/drums/kits/alesis-strata-prime/notes/24", json={"piece_id": "not_a_piece"}
    )
    assert r.status_code == 400, r.text
    assert "piece_id" in r.json()["detail"]


@pytest.mark.parametrize("note", [-1, 128, 999, "abc", "24.5"])
def test_put_note_rejects_invalid_midi_note(client, note):
    r = client.put(f"/api/drums/kits/alesis-strata-prime/notes/{note}", json={"piece_id": "kick"})
    assert r.status_code == 400, r.text
    assert "midi_note" in r.json()["detail"]


@pytest.mark.parametrize("note", [0, 127])
def test_put_note_accepts_boundary_midi_notes(client, note):
    r = client.put(
        f"/api/drums/kits/alesis-strata-prime/notes/{note}", json={"piece_id": "kick"}
    )
    assert r.status_code == 200, r.text
    assert str(note) in r.json()["kit"]["notes"]


def test_put_note_rejects_traversal_kit_id(client, env):
    _srv, tmp = env
    marker = tmp / "config.json"
    marker.write_text("{}")
    before = marker.read_bytes()

    r = client.put(
        "/api/drums/kits/%2e%2e%2fconfig.json/notes/24", json={"piece_id": "kick"}
    )
    assert r.status_code == 400, r.text
    assert marker.read_bytes() == before

    r = client.put("/api/drums/kits/foo%2Fbar/notes/24", json={"piece_id": "kick"})
    assert r.status_code == 400, r.text


def test_put_note_rejects_oversized_and_reserved_key_body(client):
    huge = {"piece_id": "kick", "padding": "x" * (4 * 1024 + 1)}
    r = client.put(
        "/api/drums/kits/alesis-strata-prime/notes/24",
        content=json.dumps(huge).encode("utf-8"),
        headers={"Content-Type": "application/json"},
    )
    assert r.status_code == 413, r.text

    r = client.put(
        "/api/drums/kits/alesis-strata-prime/notes/24",
        json={"piece_id": "kick", "__proto__": {"polluted": True}},
    )
    assert r.status_code == 400, r.text

    r = client.put(
        "/api/drums/kits/alesis-strata-prime/notes/24",
        content=b"not-json",
        headers={"Content-Type": "application/json"},
    )
    assert r.status_code == 400, r.text

    r = client.put("/api/drums/kits/alesis-strata-prime/notes/24", json=["kick"])
    assert r.status_code == 400, r.text


def test_delete_note_reports_gm_fallback(client, env):
    """REQ-004: DELETE removes the kit override and reports the GM fallback
    for that MIDI note when one exists."""
    _srv, tmp = env
    r = client.put("/api/drums/kits/alesis-strata-prime/notes/38", json={"piece_id": "tom_hi"})
    assert r.status_code == 200, r.text

    r = client.delete("/api/drums/kits/alesis-strata-prime/notes/38")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["mutation"] == {"midi_note": 38, "operation": "delete", "piece_id": None}
    assert body["resolution"] == {"piece_id": "snare", "source": "gm"}
    assert "38" not in body["kit"]["notes"]

    reloaded = client.get("/api/drums/kits/alesis-strata-prime")
    assert "38" not in reloaded.json()["notes"]


def test_delete_note_reports_unmapped_when_no_gm_fallback(client, env):
    """REQ-004: DELETE reports `unmapped` with a null piece when the raw MIDI
    note has no GM default (e.g. note 24, used by Finding-2 remaps only)."""
    _srv, tmp = env
    r = client.put("/api/drums/kits/alesis-strata-prime/notes/24", json={"piece_id": "kick"})
    assert r.status_code == 200, r.text
    assert drums_mod.midi_to_piece(24) is None  # sanity: no GM default for 24

    r = client.delete("/api/drums/kits/alesis-strata-prime/notes/24")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["mutation"]["piece_id"] is None
    assert body["resolution"] == {"piece_id": None, "source": "unmapped"}


def test_delete_note_is_idempotent(client, env):
    """REQ-004: repeated DELETE of the same (already-absent) note still
    succeeds with the same response schema."""
    _srv, tmp = env
    first = client.delete("/api/drums/kits/alesis-strata-prime/notes/24")
    assert first.status_code == 200, first.text
    second = client.delete("/api/drums/kits/alesis-strata-prime/notes/24")
    assert second.status_code == 200, second.text
    assert first.json()["resolution"] == second.json()["resolution"]
    assert first.json()["mutation"] == second.json()["mutation"]


def test_delete_note_unknown_kit_is_404(client):
    r = client.delete("/api/drums/kits/no-such-kit/notes/24")
    assert r.status_code == 404


@pytest.mark.parametrize("note", [-1, 128, "xyz"])
def test_delete_note_rejects_invalid_midi_note(client, note):
    r = client.delete(f"/api/drums/kits/alesis-strata-prime/notes/{note}")
    assert r.status_code == 400, r.text


def test_note_mutation_response_schemas_match_apart_from_operation_values(client, env):
    """REQ-004 definition-of-done: PUT and DELETE responses share the same
    top-level schema, differing only in operation-specific values."""
    _srv, tmp = env
    put_resp = client.put(
        "/api/drums/kits/alesis-strata-prime/notes/60", json={"piece_id": "ride"}
    ).json()
    delete_resp = client.delete("/api/drums/kits/alesis-strata-prime/notes/60").json()

    assert set(put_resp) == set(delete_resp) == {"kit", "mutation", "resolution"}
    assert set(put_resp["mutation"]) == set(delete_resp["mutation"]) == {
        "midi_note",
        "operation",
        "piece_id",
    }
    assert set(put_resp["resolution"]) == set(delete_resp["resolution"]) == {
        "piece_id",
        "source",
    }


def test_concurrent_note_mutations_do_not_lose_each_other(client, env):
    """REQ-002: two per-note mutations on different notes of the same kit
    cannot lose an unrelated note — the lock spans load/clone/mutate/write."""
    _srv, tmp = env
    # Seed the user overlay so both mutations start from the same base.
    r = client.put("/api/drums/kits/alesis-strata-prime/notes/24", json={"piece_id": "kick"})
    assert r.status_code == 200, r.text

    results: dict[int, int] = {}
    barrier = threading.Barrier(2)

    def _mutate(note: int, piece: str) -> None:
        barrier.wait(timeout=5)
        resp = client.put(f"/api/drums/kits/alesis-strata-prime/notes/{note}", json={"piece_id": piece})
        results[note] = resp.status_code

    t1 = threading.Thread(target=_mutate, args=(60, "ride"))
    t2 = threading.Thread(target=_mutate, args=(61, "crash_l"))
    t1.start()
    t2.start()
    t1.join(timeout=10)
    t2.join(timeout=10)

    assert results == {60: 200, 61: 200}

    final = client.get("/api/drums/kits/alesis-strata-prime").json()
    assert final["notes"]["60"] == "ride"
    assert final["notes"]["61"] == "crash_l"
    # The note set before the concurrent pair also survived.
    assert final["notes"]["24"] == "kick"


# ── Learn lock (INIT-003/SPEC-002 ac-4 / aud-1 / aud-2) ──────────────────────


def test_put_note_conflicts_while_scoring_session_playing(client, env):
    _srv, tmp = env
    seed = client.put(
        "/api/drums/kits/alesis-strata-prime/notes/24", json={"piece_id": "kick"}
    )
    assert seed.status_code == 200, seed.text
    before = json.loads((tmp / "drums" / "alesis-strata-prime.json").read_text())

    lock = client.put("/api/drums/scoring-session", json={"state": "playing"})
    assert lock.status_code == 200, lock.text
    assert lock.json()["learn_locked"] is True

    r = client.put(
        "/api/drums/kits/alesis-strata-prime/notes/60", json={"piece_id": "ride"}
    )
    assert r.status_code == 409
    after = json.loads((tmp / "drums" / "alesis-strata-prime.json").read_text())
    assert after == before
    got = client.get("/api/drums/kits/alesis-strata-prime")
    assert got.status_code == 200
    assert "60" not in got.json()["notes"]


def test_delete_note_conflicts_while_scoring_session_paused(client, env):
    _srv, tmp = env
    seed = client.put(
        "/api/drums/kits/alesis-strata-prime/notes/38", json={"piece_id": "tom_hi"}
    )
    assert seed.status_code == 200, seed.text
    before = json.loads((tmp / "drums" / "alesis-strata-prime.json").read_text())

    lock = client.put("/api/drums/scoring-session", json={"state": "paused"})
    assert lock.status_code == 200
    assert lock.json()["learn_locked"] is True

    r = client.delete("/api/drums/kits/alesis-strata-prime/notes/38")
    assert r.status_code == 409
    after = json.loads((tmp / "drums" / "alesis-strata-prime.json").read_text())
    assert after == before
    got = client.get("/api/drums/kits/alesis-strata-prime")
    assert got.json()["notes"]["38"] == "tom_hi"


def test_note_mutations_succeed_after_scoring_session_stopped(client, env):
    client.put("/api/drums/scoring-session", json={"state": "playing"})
    client.put("/api/drums/scoring-session", json={"state": "stopped"})
    r = client.put(
        "/api/drums/kits/alesis-strata-prime/notes/24", json={"piece_id": "kick"}
    )
    assert r.status_code == 200, r.text
    d = client.delete("/api/drums/kits/alesis-strata-prime/notes/24")
    assert d.status_code == 200, d.text
