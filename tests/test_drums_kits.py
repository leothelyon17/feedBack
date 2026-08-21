"""Unit tests for INIT-001/SPEC-001 kit loader and note_to_piece resolver."""

from __future__ import annotations

import json
from pathlib import Path

import drums


SHIPPED_PRIME = drums.SHIPPED_KITS_DIR / "alesis-strata-prime.json"

FINDING_2_REMAPS = {
    24: "kick",
    38: "tom_hi",
    35: "tom_mid",
    50: "ride",
    41: "crash_l",
    43: "crash_l",
    45: "crash_r",
    47: "crash_r",
}


def _kit_json(**overrides) -> bytes:
    body = {
        "id": "test-kit",
        "name": "Test Kit",
        "verified": False,
        "notes": {"24": "kick"},
        "hihat": {
            "pedal_cc": None,
            "open": "hh_open",
            "closed": "hh_closed",
            "pedal": "hh_pedal",
        },
    }
    body.update(overrides)
    return json.dumps(body).encode("utf-8")


# ── ac-1: default parity with midi_to_piece ───────────────────────────────────

def test_note_to_piece_none_kit_matches_midi_to_piece_for_all_notes():
    for n in range(128):
        assert drums.note_to_piece(n) == drums.midi_to_piece(n)
        assert drums.note_to_piece(n, kit=None) == drums.midi_to_piece(n)


def test_midi_to_piece_unchanged_for_gm_snare():
    """The additive resolver must not change GM midi_to_piece itself."""
    assert drums.midi_to_piece(38) == "snare"
    assert drums.midi_to_piece(24) is None


# ── ac-2 + Finding 2 remaps ───────────────────────────────────────────────────

def test_shipped_strata_prime_verified_is_false():
    kit = drums.load_kit_file(SHIPPED_PRIME)
    assert kit is not None
    assert kit["id"] == "alesis-strata-prime"
    assert kit["verified"] is False
    assert kit["notes"][24] == "kick"
    assert kit["notes"][38] == "tom_hi"


def test_strata_prime_kick_24_and_tom1_not_snare():
    kit = drums.load_kit_file(SHIPPED_PRIME)
    assert drums.note_to_piece(24, kit=kit) == "kick"
    assert drums.note_to_piece(38, kit=kit) != "snare"
    assert drums.note_to_piece(38, kit=kit) == "tom_hi"


def test_strata_prime_finding_2_collision_remaps():
    kit = drums.load_kit_file(SHIPPED_PRIME)
    for note, piece in FINDING_2_REMAPS.items():
        assert drums.note_to_piece(note, kit=kit) == piece, f"MIDI {note}"
    # Uncited notes fall through to GM (36 is GM kick, not in Finding 2).
    assert drums.note_to_piece(36, kit=kit) == drums.midi_to_piece(36)
    # Uncited Prime-only notes stay unmapped (snare head 26 is not Finding 2).
    assert drums.note_to_piece(26, kit=kit) is None


# ── ac-3: unknown piece-id ignored ────────────────────────────────────────────

def test_unknown_piece_id_in_notes_is_ignored(caplog):
    raw = _kit_json(notes={"24": "not_a_piece", "38": "tom_hi"})
    with caplog.at_level("DEBUG", logger="feedBack.lib.drums"):
        kit = drums.load_kit_file(raw)
    assert kit is not None
    assert 24 not in kit["notes"]
    assert kit["notes"][38] == "tom_hi"
    assert any("not_a_piece" in rec.message for rec in caplog.records)


# ── ac-4: hi-hat pedal CC / note / omitted ────────────────────────────────────

def test_hat_strike_returns_piece_when_pedal_omitted():
    kit = drums.load_kit_file(_kit_json(notes={"42": "hh_closed", "46": "hh_open"}))
    assert drums.note_to_piece(42, kit=kit) == "hh_closed"
    assert drums.note_to_piece(46, kit=kit) == "hh_open"
    assert drums.note_to_piece(42, kit=kit, hh_pedal=None) == "hh_closed"


def test_hat_strike_cc_open_vs_closed():
    kit = drums.load_kit_file(_kit_json(notes={"42": "hh_closed"}))
    closed = drums.note_to_piece(
        42, kit=kit, hh_pedal={"kind": "cc", "controller": 4, "value": 90}
    )
    opened = drums.note_to_piece(
        42, kit=kit, hh_pedal={"kind": "cc", "controller": 4, "value": 10}
    )
    assert closed == "hh_closed"
    assert opened == "hh_open"


def test_hat_pedal_as_discrete_note():
    kit = drums.load_kit_file(_kit_json(notes={"32": "hh_pedal", "42": "hh_closed"}))
    assert drums.note_to_piece(
        32, kit=kit, hh_pedal={"kind": "note", "midi": 32}
    ) == "hh_pedal"
    # A bow strike still resolves when the pedal transport is a discrete note.
    assert drums.note_to_piece(
        42, kit=kit, hh_pedal={"kind": "note", "midi": 32}
    ) == "hh_closed"


# ── ac-5: load_kits overlay ───────────────────────────────────────────────────

def test_load_kits_user_overlays_shipped_by_id(tmp_path: Path):
    shipped = tmp_path / "shipped"
    user = tmp_path / "user"
    shipped.mkdir()
    user.mkdir()
    (shipped / "a.json").write_bytes(_kit_json(id="shared", name="Shipped", notes={"24": "kick"}))
    (shipped / "b.json").write_bytes(_kit_json(id="only-shipped", name="Only", notes={"36": "kick"}))
    (user / "a.json").write_bytes(_kit_json(id="shared", name="User", notes={"38": "tom_hi"}))
    kits = drums.load_kits(shipped, user)
    assert set(kits) == {"shared", "only-shipped"}
    assert kits["shared"]["name"] == "User"
    assert kits["shared"]["notes"] == {38: "tom_hi"}
    assert kits["only-shipped"]["notes"] == {36: "kick"}


def test_load_kits_skips_malformed_json(tmp_path: Path):
    shipped = tmp_path / "shipped"
    shipped.mkdir()
    (shipped / "good.json").write_bytes(_kit_json(id="good", notes={"24": "kick"}))
    (shipped / "bad.json").write_text("{not json", encoding="utf-8")
    kits = drums.load_kits(shipped, None)
    assert list(kits) == ["good"]


def test_load_kits_from_shipped_dir_includes_strata_prime():
    kits = drums.load_kits(drums.SHIPPED_KITS_DIR, None)
    assert "alesis-strata-prime" in kits
    assert kits["alesis-strata-prime"]["verified"] is False


# ── ac-6 + security: proto keys, non-object notes, id traversal ───────────────

def test_proto_constructor_keys_stripped_without_polluting_builtins():
    raw = _kit_json()
    obj = json.loads(raw)
    obj["__proto__"] = {"polluted": True}
    obj["constructor"] = {"polluted": True}
    obj["prototype"] = {"polluted": True}
    obj["notes"]["__proto__"] = "kick"
    kit = drums.load_kit_file(json.dumps(obj).encode("utf-8"))
    assert kit is not None
    assert "__proto__" not in kit
    assert "constructor" not in kit
    assert "prototype" not in kit
    assert "__proto__" not in kit["notes"]
    assert not hasattr(type("", (), {}), "polluted")


def test_non_object_notes_rejected():
    assert drums.load_kit_file(_kit_json(notes=["kick"])) is None
    assert drums.load_kit_file(_kit_json(notes="kick")) is None


def test_non_dict_root_rejected():
    assert drums.load_kit_file(b"[1, 2]") is None
    assert drums.load_kit_file(b"null") is None
    assert drums.load_kit_file(b'"kit"') is None


def test_kit_id_path_traversal_rejected():
    assert drums.load_kit_file(_kit_json(id="foo/bar")) is None
    assert drums.load_kit_file(_kit_json(id="foo\\bar")) is None
    assert drums.load_kit_file(_kit_json(id="foo..bar")) is None
    assert drums.load_kit_file(_kit_json(id="foo\x00bar")) is None
    assert drums.load_kit_file(_kit_json(id="")) is None


# ── edge cases from the testing strategy ──────────────────────────────────────

def test_empty_notes_is_valid_kit():
    kit = drums.load_kit_file(_kit_json(notes={}))
    assert kit is not None
    assert kit["notes"] == {}
    assert drums.note_to_piece(38, kit=kit) == drums.midi_to_piece(38)


def test_notes_accept_int_and_string_keys_at_resolve_time():
    kit = drums.load_kit_file(_kit_json(notes={"24": "kick"}))
    assert kit["notes"][24] == "kick"
    # Resolver also tolerates a caller-built kit that still has string keys.
    loose = {"id": "loose", "notes": {"50": "ride"}, "hihat": {}}
    assert drums.note_to_piece(50, kit=loose) == "ride"


def test_missing_id_rejected():
    raw = json.dumps({"name": "No Id", "notes": {}}).encode("utf-8")
    assert drums.load_kit_file(raw) is None


def test_verified_missing_treated_as_false():
    raw = json.dumps({"id": "nv", "name": "NV", "notes": {}}).encode("utf-8")
    kit = drums.load_kit_file(raw)
    assert kit is not None
    assert kit["verified"] is False


def test_load_kit_file_accepts_path(tmp_path: Path):
    p = tmp_path / "k.json"
    p.write_bytes(_kit_json(id="from-path"))
    kit = drums.load_kit_file(p)
    assert kit is not None
    assert kit["id"] == "from-path"


def test_load_kits_missing_dirs_return_empty(tmp_path: Path):
    assert drums.load_kits(tmp_path / "nope", tmp_path / "also-nope") == {}


def test_note_to_piece_emits_piece_ids_not_lane_ids():
    kit = drums.load_kit_file(SHIPPED_PRIME)
    for n in range(128):
        piece = drums.note_to_piece(n, kit=kit)
        if piece is not None:
            assert piece in drums.PIECES
            assert piece not in {"tom1", "tom2", "hihat"}


def test_note_key_and_midi_arg_edge_cases():
    kit = drums.load_kit_file(_kit_json(notes={"x": "kick", "200": "snare", "24": "kick"}))
    assert kit is not None
    assert kit["notes"] == {24: "kick"}
    assert drums.note_to_piece(True) is None
    assert drums.note_to_piece("not-a-note") is None


def test_missing_name_and_null_notes():
    raw = json.dumps({"id": "noname", "notes": None}).encode("utf-8")
    kit = drums.load_kit_file(raw)
    assert kit is not None
    assert kit["name"] == "noname"
    assert kit["notes"] == {}
    assert kit["manufacturer"] is None


def test_hihat_pedal_cc_recorded_and_controller_mismatch():
    raw = _kit_json(
        notes={"42": "hh_closed"},
        hihat={"pedal_cc": 4, "open": "hh_open", "closed": "hh_closed", "pedal": "hh_pedal"},
    )
    kit = drums.load_kit_file(raw)
    assert kit["hihat"]["pedal_cc"] == 4
    # Wrong controller: leave the mapped strike alone.
    assert drums.note_to_piece(
        42, kit=kit, hh_pedal={"kind": "cc", "controller": 10, "value": 10}
    ) == "hh_closed"
    assert drums.note_to_piece(
        42, kit=kit, hh_pedal={"kind": "cc", "controller": 4, "value": 10}
    ) == "hh_open"


def test_hh_pedal_malformed_and_non_hat_notes():
    kit = drums.load_kit_file(_kit_json(notes={"24": "kick", "42": "hh_closed"}))
    assert drums.note_to_piece(42, kit=kit, hh_pedal={"kind": "note", "midi": None}) == "hh_closed"
    assert drums.note_to_piece(24, kit=kit, hh_pedal={"kind": "cc", "value": 10}) == "kick"
    assert drums.note_to_piece(42, kit=kit, hh_pedal={"kind": "cc", "value": "x"}) == "hh_closed"
    assert drums.note_to_piece(42, kit=kit, hh_pedal={"kind": "aftertouch", "value": 1}) == "hh_closed"
    # Caller-built kit with a non-dict hihat still resolves.
    loose = {"id": "loose", "notes": {42: "hh_closed"}, "hihat": "nope"}
    assert drums.note_to_piece(
        42, kit=loose, hh_pedal={"kind": "cc", "value": 90}
    ) == "hh_closed"
    assert drums.note_to_piece(38, kit={"id": "x", "notes": []}) == drums.midi_to_piece(38)


def test_load_kit_file_missing_path_returns_none(tmp_path: Path):
    assert drums.load_kit_file(tmp_path / "no-such-kit.json") is None

