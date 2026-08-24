"""Unit tests for INIT-003/SPEC-007 MIDI device-type catalogs."""

from __future__ import annotations

import json
from pathlib import Path

import drums
import midi_device_types as mdt

SHIPPED_PRIME = mdt.SHIPPED_DEVICE_TYPES_DIR / "alesis-strata-prime.json"
SHIPPED_GENERIC = mdt.SHIPPED_DEVICE_TYPES_DIR / "generic.json"
KIT_PRIME = drums.SHIPPED_KITS_DIR / "alesis-strata-prime.json"


def _catalog(**overrides) -> dict:
    body = {
        "id": "test-type",
        "name": "Test Type",
        "manufacturer": "TestCo",
        "family": "drums",
        "triggers": [{"id": "kick", "name": "Kick"}],
    }
    body.update(overrides)
    return body


def _catalog_bytes(**overrides) -> bytes:
    return json.dumps(_catalog(**overrides)).encode("utf-8")


# ── ac-1: shipped Prime catalog, no notes, no MIDI defaults ───────────────────

def test_shipped_strata_prime_catalog_has_pads_and_no_notes():
    parsed = mdt.load_device_type_file(SHIPPED_PRIME)
    assert parsed is not None
    assert parsed["id"] == "alesis-strata-prime"
    assert parsed["family"] == "drums"
    assert parsed["name"] == "Alesis Strata Prime"
    assert parsed["manufacturer"] == "Alesis"
    assert "notes" not in parsed
    ids = [t["id"] for t in parsed["triggers"]]
    assert "kick" in ids
    assert "snare" in ids
    assert "snare_rim" in ids
    assert "hh_open" in ids
    assert "crash_l" in ids
    assert "ride_bell" in ids
    for tid in ("kick", "snare", "tom_hi", "hh_closed", "crash_r", "ride"):
        assert tid in ids
        assert tid in drums.PIECES
    raw = json.loads(SHIPPED_PRIME.read_text(encoding="utf-8"))
    assert "notes" not in raw
    dumped = json.dumps(raw)
    kit_notes = json.loads(KIT_PRIME.read_text(encoding="utf-8"))["notes"]
    for midi_key in kit_notes:
        assert f'"{midi_key}"' not in dumped


def test_shipped_generic_catalog_loads_with_empty_triggers():
    parsed = mdt.load_device_type_file(SHIPPED_GENERIC)
    assert parsed is not None
    assert parsed["id"] == "generic"
    assert parsed["name"] == "Generic"
    assert parsed["family"] == "drums"
    assert parsed["triggers"] == []
    assert "notes" not in parsed
    raw = json.loads(SHIPPED_GENERIC.read_text(encoding="utf-8"))
    assert "notes" not in raw
    assert raw["triggers"] == []
    loaded = mdt.load_device_type("generic")
    assert loaded is not None
    assert loaded["triggers"] == []
    assert "notes" not in loaded


def test_load_device_type_never_returns_gm_or_kit_notes():
    catalog = mdt.load_device_type("alesis-strata-prime")
    assert catalog is not None
    assert "notes" not in catalog
    blob = json.dumps(catalog)
    for n in range(128):
        assert f'"{n}"' not in blob
        assert f": {n}" not in blob
        assert f":{n}" not in blob


# ── ac-2: family enum ─────────────────────────────────────────────────────────

def test_family_drums_keys_other_accepted():
    for family in ("drums", "keys", "other"):
        parsed = mdt.load_device_type_file(_catalog_bytes(family=family, triggers=[]))
        assert parsed is not None, family
        assert parsed["family"] == family
        assert parsed["triggers"] == []


def test_family_required_and_closed_enum():
    assert mdt.load_device_type_file(_catalog_bytes(family="guitar")) is None
    assert mdt.load_device_type_file(_catalog_bytes(family="")) is None
    assert mdt.load_device_type_file(_catalog_bytes(family=None)) is None
    body = _catalog()
    del body["family"]
    assert mdt.load_device_type_file(json.dumps(body).encode("utf-8")) is None


# ── ac-3: overlay wins / replace triggers ─────────────────────────────────────

def test_overlay_replaces_triggers_for_same_id(tmp_path: Path):
    shipped = tmp_path / "shipped"
    user = tmp_path / "midi" / "device-types"
    shipped.mkdir()
    user.mkdir(parents=True)
    (shipped / "shared.json").write_bytes(
        _catalog_bytes(id="shared", name="Shipped", triggers=[{"id": "kick", "name": "Kick"}])
    )
    (shipped / "only-shipped.json").write_bytes(
        _catalog_bytes(id="only-shipped", name="Only", triggers=[{"id": "snare", "name": "Snare"}])
    )
    (user / "shared.json").write_bytes(
        _catalog_bytes(
            id="shared",
            name="User",
            triggers=[{"id": "snare_rim", "name": "Snare Rim", "zone": "rim"}],
        )
    )
    types = mdt.load_device_types(shipped, user)
    assert set(types) == {"shared", "only-shipped"}
    assert types["shared"]["name"] == "User"
    assert types["shared"]["triggers"] == [
        {"id": "snare_rim", "name": "Snare Rim", "zone": "rim"}
    ]
    assert types["only-shipped"]["triggers"][0]["id"] == "snare"


def test_overlay_can_add_a_new_type(tmp_path: Path):
    shipped = tmp_path / "shipped"
    user = tmp_path / "user"
    shipped.mkdir()
    user.mkdir()
    (shipped / "prime.json").write_bytes(_catalog_bytes(id="alesis-strata-prime"))
    (user / "custom.json").write_bytes(
        _catalog_bytes(id="custom-board", family="keys", triggers=[])
    )
    types = mdt.load_device_types(shipped, user)
    assert set(types) == {"alesis-strata-prime", "custom-board"}
    assert types["custom-board"]["family"] == "keys"


def test_load_device_type_overlay_wins(tmp_path: Path):
    overlay_dir = tmp_path / "midi" / "device-types"
    overlay_dir.mkdir(parents=True)
    (overlay_dir / "alesis-strata-prime.json").write_bytes(
        _catalog_bytes(id="alesis-strata-prime", name="Overlay Prime", triggers=[])
    )
    parsed = mdt.load_device_type("alesis-strata-prime", config_dir=tmp_path)
    assert parsed is not None
    assert parsed["name"] == "Overlay Prime"
    assert parsed["triggers"] == []


def test_corrupt_overlay_skipped_falls_through_to_shipped(tmp_path: Path, caplog):
    overlay_dir = tmp_path / "midi" / "device-types"
    overlay_dir.mkdir(parents=True)
    (overlay_dir / "alesis-strata-prime.json").write_text("{not json", encoding="utf-8")
    with caplog.at_level("WARNING", logger="feedBack.lib.midi_device_types"):
        parsed = mdt.load_device_type("alesis-strata-prime", config_dir=tmp_path)
    assert parsed is not None
    assert parsed["id"] == "alesis-strata-prime"
    assert parsed["family"] == "drums"
    assert "notes" not in parsed
    assert any("invalid JSON" in rec.message or "corrupt overlay" in rec.message for rec in caplog.records)


def test_load_device_types_skips_malformed_json(tmp_path: Path):
    shipped = tmp_path / "shipped"
    shipped.mkdir()
    (shipped / "good.json").write_bytes(_catalog_bytes(id="good"))
    (shipped / "bad.json").write_text("{not json", encoding="utf-8")
    types = mdt.load_device_types(shipped, None)
    assert list(types) == ["good"]


# ── ac-4: path traversal, proto keys, containment ─────────────────────────────

def test_id_path_traversal_rejected():
    assert mdt.load_device_type_file(_catalog_bytes(id="../drums/foo")) is None
    assert mdt.load_device_type_file(_catalog_bytes(id="foo/bar")) is None
    assert mdt.load_device_type_file(_catalog_bytes(id="foo\\bar")) is None
    assert mdt.load_device_type_file(_catalog_bytes(id="foo..bar")) is None
    assert mdt.device_type_path(Path("/tmp"), "../drums/foo") is None
    assert mdt.device_type_path(Path("/tmp"), "alesis-strata-prime/../../etc") is None
    assert mdt.load_device_type("../drums/foo") is None
    assert mdt.load_device_type("__proto__") is None
    assert mdt.load_device_type("constructor") is None


def test_device_type_path_stays_under_midi_device_types(tmp_path: Path):
    resolved = mdt.device_type_path(tmp_path, "alesis-strata-prime")
    assert resolved is not None
    assert resolved.parent == tmp_path / "midi" / "device-types"
    assert resolved.name == "alesis-strata-prime.json"
    drums_escape = tmp_path / "drums"
    drums_escape.mkdir()
    (drums_escape / "foo.json").write_text("{}", encoding="utf-8")
    assert mdt.device_type_path(tmp_path, "../drums/foo") is None


def test_proto_constructor_keys_refused():
    for key in ("__proto__", "constructor", "prototype"):
        obj = _catalog()
        obj[key] = {"polluted": True}
        assert mdt.load_device_type_file(json.dumps(obj).encode("utf-8")) is None
    nested = _catalog()
    nested["triggers"] = [{"id": "kick", "name": "Kick", "__proto__": "x"}]
    assert mdt.load_device_type_file(json.dumps(nested).encode("utf-8")) is None
    assert not hasattr(type("", (), {}), "polluted")


def test_glob_skips_file_outside_device_types(tmp_path: Path):
    user = tmp_path / "midi" / "device-types"
    user.mkdir(parents=True)
    (user / "ok.json").write_bytes(_catalog_bytes(id="ok", triggers=[]))
    types = mdt.load_device_types(None, user)
    assert set(types) == {"ok"}


# ── ac-5: never notes; notes key refused ──────────────────────────────────────

def test_notes_key_on_catalog_is_refused():
    assert mdt.load_device_type_file(_catalog_bytes(notes={"24": "kick"})) is None
    assert mdt.load_device_type_file(_catalog_bytes(notes={})) is None


def test_trigger_midi_defaults_refused():
    assert mdt.load_device_type_file(
        _catalog_bytes(triggers=[{"id": "kick", "name": "Kick", "midi": 36}])
    ) is None
    assert mdt.load_device_type_file(
        _catalog_bytes(triggers=[{"id": "snare", "note": 38}])
    ) is None


def test_empty_trigger_list_allowed():
    parsed = mdt.load_device_type_file(_catalog_bytes(triggers=[]))
    assert parsed is not None
    assert parsed["triggers"] == []
    missing = _catalog()
    del missing["triggers"]
    parsed_missing = mdt.load_device_type_file(json.dumps(missing).encode("utf-8"))
    assert parsed_missing is not None
    assert parsed_missing["triggers"] == []
    parsed_null = mdt.load_device_type_file(_catalog_bytes(triggers=None))
    assert parsed_null is not None
    assert parsed_null["triggers"] == []


def test_non_list_triggers_rejected():
    assert mdt.load_device_type_file(_catalog_bytes(triggers={"kick": True})) is None
    assert mdt.load_device_type_file(_catalog_bytes(triggers="kick")) is None


# ── kit glob isolation ────────────────────────────────────────────────────────

def test_planted_catalog_json_in_kit_glob_is_refused(tmp_path: Path):
    user = tmp_path / "drums"
    user.mkdir()
    planted = _catalog(id="alesis-strata-prime")
    (user / "alesis-strata-prime.json").write_text(json.dumps(planted), encoding="utf-8")
    kits = drums.load_kits(None, user)
    assert "alesis-strata-prime" not in kits
    assert drums.load_kit_file(user / "alesis-strata-prime.json") is None


def test_catalog_under_midi_does_not_change_kit_list(tmp_path: Path):
    drums_dir = tmp_path / "drums"
    drums_dir.mkdir()
    (drums_dir / "user-kit.json").write_text(
        json.dumps({"id": "user-kit", "name": "User", "notes": {"36": "kick"}}),
        encoding="utf-8",
    )
    overlay = tmp_path / "midi" / "device-types"
    overlay.mkdir(parents=True)
    (overlay / "alesis-strata-prime.json").write_bytes(
        _catalog_bytes(id="alesis-strata-prime", triggers=[])
    )
    before = drums.load_kits(drums.SHIPPED_KITS_DIR, drums_dir)
    after_ids = set(drums.load_kits(drums.SHIPPED_KITS_DIR, drums_dir))
    assert after_ids == set(before)
    assert "alesis-strata-prime" in after_ids
    assert before["alesis-strata-prime"]["notes"]
    assert "user-kit" in after_ids


# ── edges: skip bad rows, missing dirs, size, name fallback ───────────────────

def test_invalid_trigger_rows_skipped_not_fatal():
    parsed = mdt.load_device_type_file(
        _catalog_bytes(
            triggers=[
                "nope",
                {"id": "BadId", "name": "X"},
                {"id": "snare", "name": "Snare", "zone": "nose"},
                {"id": "kick", "name": "  "},
                {"id": "ride", "name": "Ride", "zone": "head"},
            ]
        )
    )
    assert parsed is not None
    assert parsed["triggers"] == [
        {"id": "kick", "name": "kick"},
        {"id": "ride", "name": "Ride", "zone": "head"},
    ]


def test_load_device_type_file_accepts_str_payload():
    parsed = mdt.load_device_type_file(json.dumps(_catalog(triggers=[])))
    assert parsed is not None
    assert parsed["id"] == "test-type"


def test_load_dir_skips_json_named_directory(tmp_path: Path):
    user = tmp_path / "user"
    user.mkdir()
    (user / "trap.json").mkdir()
    (user / "ok.json").write_bytes(_catalog_bytes(id="ok", triggers=[]))
    types = mdt.load_device_types(None, user)
    assert set(types) == {"ok"}


def test_load_device_type_none_shipped_dir_without_overlay():
    assert mdt.load_device_type("alesis-strata-prime", shipped_dir=None) is None


def test_missing_name_defaults_to_id_and_optional_manufacturer():
    raw = json.dumps({"id": "bare-type", "family": "other", "triggers": []}).encode("utf-8")
    parsed = mdt.load_device_type_file(raw)
    assert parsed is not None
    assert parsed["name"] == "bare-type"
    assert "manufacturer" not in parsed


def test_load_device_types_missing_dirs_return_empty(tmp_path: Path):
    assert mdt.load_device_types(tmp_path / "nope", tmp_path / "also-nope") == {}


def test_load_device_type_file_missing_path_returns_none(tmp_path: Path):
    assert mdt.load_device_type_file(tmp_path / "no-such.json") is None


def test_non_dict_root_rejected():
    assert mdt.load_device_type_file(b"[1, 2]") is None
    assert mdt.load_device_type_file(b"null") is None
    assert mdt.load_device_type_file(b'"type"') is None


def test_oversized_body_rejected():
    huge = _catalog()
    huge["name"] = "x" * (70 * 1024)
    assert mdt.load_device_type_file(json.dumps(huge).encode("utf-8")) is None


def test_shipped_dir_constant_is_sibling_of_kits():
    assert mdt.SHIPPED_DEVICE_TYPES_DIR.name == "device-types"
    assert mdt.SHIPPED_DEVICE_TYPES_DIR.parent.name == "midi"
    assert drums.SHIPPED_KITS_DIR.parent.name == "drums"
    assert mdt.SHIPPED_DEVICE_TYPES_DIR.parent.parent == drums.SHIPPED_KITS_DIR.parent.parent
