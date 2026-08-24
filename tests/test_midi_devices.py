"""Unit tests for INIT-003/SPEC-008 MIDI device documents and profile attach."""

from __future__ import annotations

import json
from pathlib import Path

import drum_profiles as dp
import drums
import midi_devices as md

SHIPPED_KIT_PRIME = drums.SHIPPED_KITS_DIR / "alesis-strata-prime.json"


def _device(**overrides) -> dict:
    body = {
        "id": "living-room-ekit",
        "name": "Living room e-kit",
        "source_id": "web-midi::pad-1",
        "device_type_id": "alesis-strata-prime",
        "family": "drums",
        "notes": {},
        "input": {"midi_channel": -1, "hit_detection": False, "synth_volume": 0.7},
    }
    body.update(overrides)
    return body


def _profile(**overrides) -> dict:
    body = {
        "id": "living-room",
        "name": "Living room",
        "kit_id": "alesis-strata-prime",
        "device": {"source_id": "web-midi::pad-1", "enabled": True},
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


def _overlay_kit(user_dir: Path, kit_id: str = "user-kit", notes: dict | None = None) -> Path:
    user_dir.mkdir(parents=True, exist_ok=True)
    path = user_dir / f"{kit_id}.json"
    path.write_text(
        json.dumps({
            "id": kit_id,
            "name": "User overlay",
            "notes": notes if notes is not None else {"24": "kick", "38": "snare"},
        }),
        encoding="utf-8",
    )
    return path


# ── ac-1: persist + notes default {} ─────────────────────────────────────────

def test_save_writes_canonical_document_under_midi_devices(tmp_path: Path):
    saved, err = md.save_device(tmp_path, _device())
    assert err is None
    assert saved is not None
    dest = tmp_path / "midi" / "devices" / "living-room-ekit.json"
    assert dest.is_file()
    on_disk = json.loads(dest.read_text(encoding="utf-8"))
    assert on_disk["id"] == "living-room-ekit"
    assert on_disk["name"] == "Living room e-kit"
    assert on_disk["source_id"] == "web-midi::pad-1"
    assert on_disk["device_type_id"] == "alesis-strata-prime"
    assert on_disk["family"] == "drums"
    assert on_disk["notes"] == {}
    assert on_disk["input"] == {
        "midi_channel": -1,
        "hit_detection": False,
        "synth_volume": 0.7,
    }
    loaded = md.load_device(tmp_path, "living-room-ekit")
    assert loaded == saved


def test_notes_omitted_defaults_to_empty_object(tmp_path: Path):
    body = _device()
    del body["notes"]
    saved, err = md.save_device(tmp_path, body)
    assert err is None
    assert saved["notes"] == {}
    on_disk = json.loads(
        (tmp_path / "midi" / "devices" / "living-room-ekit.json").read_text(encoding="utf-8")
    )
    assert on_disk["notes"] == {}


def test_list_devices_creates_nothing_when_dir_missing(tmp_path: Path):
    assert md.list_devices(tmp_path) == []
    assert not (tmp_path / "midi" / "devices").exists()


def test_save_creates_missing_devices_dir(tmp_path: Path):
    saved, err = md.save_device(tmp_path, _device(id="alpha", name="Alpha"))
    assert err is None and saved["id"] == "alpha"
    assert (tmp_path / "midi" / "devices").is_dir()


def test_user_notes_round_trip(tmp_path: Path):
    saved, err = md.save_device(tmp_path, _device(notes={"36": "kick", "38": "snare"}))
    assert err is None
    assert saved["notes"] == {"36": "kick", "38": "snare"}
    loaded = md.load_device(tmp_path, "living-room-ekit")
    assert loaded["notes"] == {"36": "kick", "38": "snare"}


# ── ac-2: source_id rejects raw port labels ──────────────────────────────────

def test_source_id_empty_string_allowed(tmp_path: Path):
    saved, err = md.save_device(tmp_path, _device(source_id=""))
    assert err is None
    assert saved["source_id"] == ""


def test_source_id_logical_id_accepted(tmp_path: Path):
    saved, err = md.save_device(tmp_path, _device(source_id="web-midi::pad-1"))
    assert err is None
    assert saved["source_id"] == "web-midi::pad-1"


def test_source_id_rejects_raw_port_labels(tmp_path: Path):
    labels = [
        "Alesis Nitro Max",
        "MIDIIN2 (MPK Mini)",
        "USB Midi Device",
        "CoreMIDI: IAC Driver",
    ]
    for label in labels:
        saved, err = md.save_device(tmp_path, _device(source_id=label))
        assert saved is None, label
        assert err is not None and "source_id" in err
    assert not (tmp_path / "midi" / "devices").exists() or not any(
        (tmp_path / "midi" / "devices").glob("*.json")
    )


# ── ac-3: new-from-type empty notes despite shipped kit notes ────────────────

def test_device_from_type_empty_notes_despite_shipped_kit(tmp_path: Path):
    kit = json.loads(SHIPPED_KIT_PRIME.read_text(encoding="utf-8"))
    assert kit["notes"]
    saved, err = md.device_from_type(
        tmp_path, "alesis-strata-prime", device_id="from-prime",
    )
    assert err is None
    assert saved is not None
    assert saved["notes"] == {}
    assert saved["device_type_id"] == "alesis-strata-prime"
    assert saved["family"] == "drums"
    on_disk = json.loads(
        (tmp_path / "midi" / "devices" / "from-prime.json").read_text(encoding="utf-8")
    )
    assert on_disk["notes"] == {}
    for midi_key in kit["notes"]:
        assert midi_key not in on_disk["notes"]


# ── ac-4: validate_profile accepts existing device_id; still rejects notes ───

def test_validate_profile_accepts_existing_device_id(tmp_path: Path):
    device, err = md.save_device(tmp_path, _device())
    assert err is None
    canonical, perr = dp.validate_profile(
        _profile(device_id=device["id"], kit_id="alesis-strata-prime"),
        config_dir=tmp_path,
    )
    assert perr is None
    assert canonical["device_id"] == "living-room-ekit"
    assert canonical["kit_id"] == "alesis-strata-prime"
    assert "notes" not in canonical


def test_validate_profile_still_rejects_notes_when_device_attached(tmp_path: Path):
    md.save_device(tmp_path, _device())
    canonical, err = dp.validate_profile(
        _profile(device_id="living-room-ekit", notes={"24": "kick"}),
        config_dir=tmp_path,
    )
    assert canonical is None
    assert err is not None and "notes" in err


def test_validate_profile_rejects_unknown_device_id(tmp_path: Path):
    canonical, err = dp.validate_profile(
        _profile(device_id="no-such-device"),
        config_dir=tmp_path,
    )
    assert canonical is None
    assert err is not None and "device_id" in err


def test_validate_profile_rejects_traversal_device_id(tmp_path: Path):
    canonical, err = dp.validate_profile(
        _profile(device_id="../profiles/foo"),
        config_dir=tmp_path,
    )
    assert canonical is None
    assert err is not None and "device_id" in err


def test_save_profile_writes_device_id_and_kit_id(tmp_path: Path):
    md.save_device(tmp_path, _device())
    saved, err = dp.save_profile(
        tmp_path,
        _profile(device_id="living-room-ekit", kit_id="alesis-strata-prime"),
    )
    assert err is None
    assert saved["device_id"] == "living-room-ekit"
    assert saved["kit_id"] == "alesis-strata-prime"
    on_disk = json.loads(
        (tmp_path / "drums" / "profiles" / "living-room.json").read_text(encoding="utf-8")
    )
    assert on_disk["device_id"] == "living-room-ekit"
    assert "notes" not in on_disk


def test_scoring_notes_uses_device_map_when_attached(tmp_path: Path):
    md.save_device(tmp_path, _device(notes={"36": "kick"}))
    profile, err = dp.save_profile(
        tmp_path, _profile(device_id="living-room-ekit"),
    )
    assert err is None
    assert dp.scoring_notes(tmp_path, profile) == {"36": "kick"}


def test_scoring_notes_empty_without_device_id(tmp_path: Path):
    profile, err = dp.save_profile(tmp_path, _profile())
    assert err is None
    assert "device_id" not in profile
    assert dp.scoring_notes(tmp_path, profile) == {}


# ── ac-5: kit glob ignores midi/devices and midi/device-types ────────────────

def test_planted_device_json_in_kit_glob_is_refused(tmp_path: Path):
    user = tmp_path / "drums"
    user.mkdir()
    planted = _device(id="planted-ekit", name="Planted")
    (user / "planted-ekit.json").write_text(json.dumps(planted), encoding="utf-8")
    kits = drums.load_kits(None, user)
    assert "planted-ekit" not in kits
    assert drums.load_kit_file(user / "planted-ekit.json") is None


def test_device_under_midi_devices_does_not_change_kit_list(tmp_path: Path):
    drums_dir = tmp_path / "drums"
    drums_dir.mkdir()
    (drums_dir / "user-kit.json").write_text(
        json.dumps({"id": "user-kit", "name": "User", "notes": {"36": "kick"}}),
        encoding="utf-8",
    )
    md.save_device(tmp_path, _device())
    overlay = tmp_path / "midi" / "device-types"
    overlay.mkdir(parents=True, exist_ok=True)
    (overlay / "extra-type.json").write_text(
        json.dumps({
            "id": "extra-type",
            "name": "Extra",
            "family": "drums",
            "triggers": [],
        }),
        encoding="utf-8",
    )
    kits = drums.load_kits(drums.SHIPPED_KITS_DIR, drums_dir)
    assert "user-kit" in kits
    assert "living-room-ekit" not in kits
    assert "extra-type" not in kits
    assert "alesis-strata-prime" in kits


def test_real_kit_in_glob_still_loads_beside_devices(tmp_path: Path):
    user = tmp_path / "drums"
    user.mkdir()
    (user / "user-kit.json").write_text(
        json.dumps({"id": "user-kit", "name": "User", "notes": {"36": "kick"}}),
        encoding="utf-8",
    )
    md.save_device(tmp_path, _device())
    kits = drums.load_kits(None, user)
    assert set(kits) == {"user-kit"}


# ── ac-6: overlay-kit migrate once; shipped kit notes not copied ─────────────

def test_overlay_kit_notes_migrate_once(tmp_path: Path):
    _overlay_kit(tmp_path / "drums")
    first = md.migrate_overlay_kit_notes(tmp_path)
    assert first is not None
    assert first["notes"] == {"24": "kick", "38": "snare"}
    assert first["id"] == "user-kit"
    devices = md.list_devices(tmp_path)
    assert len(devices) == 1
    sentinel = tmp_path / "midi" / "overlay-kit-notes-migrated"
    assert sentinel.is_file()

    second = md.migrate_overlay_kit_notes(tmp_path)
    assert second is None
    assert len(md.list_devices(tmp_path)) == 1


def test_migrate_skips_when_any_device_file_exists(tmp_path: Path):
    md.save_device(tmp_path, _device(notes={}))
    _overlay_kit(tmp_path / "drums")
    result = md.migrate_overlay_kit_notes(tmp_path)
    assert result is None
    devices = md.list_devices(tmp_path)
    assert len(devices) == 1
    assert devices[0]["notes"] == {}
    assert (tmp_path / "midi" / "overlay-kit-notes-migrated").is_file()


def test_migrate_does_not_copy_shipped_kit_notes(tmp_path: Path):
    shipped_notes = json.loads(SHIPPED_KIT_PRIME.read_text(encoding="utf-8"))["notes"]
    assert shipped_notes
    result = md.migrate_overlay_kit_notes(tmp_path)
    assert result is None
    assert md.list_devices(tmp_path) == []
    assert (tmp_path / "midi" / "overlay-kit-notes-migrated").is_file()
    third = md.migrate_overlay_kit_notes(tmp_path)
    assert third is None
    assert md.list_devices(tmp_path) == []


def test_migrate_overlay_notes_are_not_shipped_prime_map(tmp_path: Path):
    shipped_notes = json.loads(SHIPPED_KIT_PRIME.read_text(encoding="utf-8"))["notes"]
    overlay_notes = {"60": "snare"}
    _overlay_kit(tmp_path / "drums", notes=overlay_notes)
    migrated = md.migrate_overlay_kit_notes(tmp_path)
    assert migrated is not None
    assert migrated["notes"] == overlay_notes
    assert migrated["notes"] != shipped_notes


# ── security: path traversal, reserved keys, catalog existence ───────────────

def test_device_path_rejects_traversal_id(tmp_path: Path):
    assert md.device_path(tmp_path, "../profiles/foo") is None
    assert md.device_path(tmp_path, "..") is None
    assert md.device_path(tmp_path, "foo/bar") is None


def test_save_traversal_id_cannot_write_outside_midi_devices(tmp_path: Path):
    saved, err = md.save_device(tmp_path, _device(id="../profiles/foo"))
    assert saved is None
    assert err is not None
    profiles = tmp_path / "drums" / "profiles"
    midi_devices_root = tmp_path / "midi" / "devices"
    assert not (tmp_path / "profiles").exists()
    assert not (tmp_path / "foo.json").exists()
    if midi_devices_root.exists():
        assert not list(midi_devices_root.glob("*.json"))
    assert not profiles.exists() or not list(profiles.glob("*.json"))


def test_device_type_id_must_exist_in_catalog(tmp_path: Path):
    saved, err = md.save_device(tmp_path, _device(device_type_id="no-such-type"))
    assert saved is None
    assert err is not None and "device_type_id" in err


def test_family_must_match_catalog_type(tmp_path: Path):
    saved, err = md.save_device(tmp_path, _device(family="keys"))
    assert saved is None
    assert err is not None and "family" in err


def test_reserved_keys_rejected(tmp_path: Path):
    for key in ("__proto__", "constructor", "prototype"):
        body = _device()
        body[key] = {}
        saved, err = md.save_device(tmp_path, body)
        assert saved is None, key
        assert err is not None


def test_corrupt_json_skipped_not_crash(tmp_path: Path, caplog):
    dest = tmp_path / "midi" / "devices"
    dest.mkdir(parents=True)
    (dest / "broken.json").write_text("{not json", encoding="utf-8")
    md.save_device(tmp_path, _device())
    with caplog.at_level("WARNING", logger="feedBack.lib.midi_devices"):
        devices = md.list_devices(tmp_path)
    assert [d["id"] for d in devices] == ["living-room-ekit"]


def test_oversized_body_rejected():
    huge = _device(name="x" * (70 * 1024))
    assert md.load_device_file(json.dumps(huge).encode("utf-8")) is None


def test_count_cap_rejects_additional_device(tmp_path: Path, monkeypatch):
    monkeypatch.setattr(md, "_DEVICE_COUNT_MAX", 2)
    assert md.save_device(tmp_path, _device(id="one", name="One"))[1] is None
    assert md.save_device(tmp_path, _device(id="two", name="Two"))[1] is None
    saved, err = md.save_device(tmp_path, _device(id="three", name="Three"))
    assert saved is None
    assert err is not None and "count" in err
    assert md.save_device(tmp_path, _device(id="one", name="One renamed"))[1] is None


def test_invalid_notes_entries_skipped_not_fatal(tmp_path: Path):
    saved, err = md.save_device(
        tmp_path,
        _device(notes={"36": "kick", "nope": "snare", "200": "tom_hi", "38": "not-a-piece"}),
    )
    assert err is None
    assert saved["notes"] == {"36": "kick"}


def test_non_object_notes_rejected(tmp_path: Path):
    saved, err = md.save_device(tmp_path, _device(notes=["kick"]))
    assert saved is None
    assert err is not None and "notes" in err


def test_device_from_type_unknown_catalog(tmp_path: Path):
    saved, err = md.device_from_type(tmp_path, "no-such-type", device_id="x")
    assert saved is None
    assert err is not None


def test_load_device_missing_returns_none(tmp_path: Path):
    assert md.load_device(tmp_path, "nope") is None
    assert md.load_device_file(tmp_path / "no-such.json") is None


def test_non_dict_root_rejected():
    assert md.load_device_file(b"[1, 2]") is None
    assert md.load_device_file(b"null") is None


def test_overlay_catalog_type_accepted(tmp_path: Path):
    overlay = tmp_path / "midi" / "device-types"
    overlay.mkdir(parents=True)
    (overlay / "custom-board.json").write_text(
        json.dumps({
            "id": "custom-board",
            "name": "Custom",
            "family": "keys",
            "triggers": [],
        }),
        encoding="utf-8",
    )
    saved, err = md.save_device(
        tmp_path,
        _device(
            id="keys-1",
            name="Keys",
            device_type_id="custom-board",
            family="keys",
            source_id="",
        ),
    )
    assert err is None
    assert saved["family"] == "keys"
    assert saved["device_type_id"] == "custom-board"


def test_input_defaults_when_omitted(tmp_path: Path):
    body = _device()
    del body["input"]
    saved, err = md.save_device(tmp_path, body)
    assert err is None
    assert saved["input"] == {
        "midi_channel": -1,
        "hit_detection": False,
        "synth_volume": 0.7,
    }


def test_family_required(tmp_path: Path):
    body = _device()
    del body["family"]
    saved, err = md.save_device(tmp_path, body)
    assert saved is None
    assert err is not None and "family" in err


def test_profile_without_device_id_still_loads(tmp_path: Path):
    saved, err = dp.save_profile(tmp_path, _profile())
    assert err is None
    assert "device_id" not in saved
    loaded = dp.load_profile(tmp_path, "living-room")
    assert loaded == saved


def test_input_clamps_channel_and_volume(tmp_path: Path):
    saved, err = md.save_device(
        tmp_path,
        _device(input={"midi_channel": 99, "hit_detection": True, "synth_volume": 2.5}),
    )
    assert err is None
    assert saved["input"]["midi_channel"] == 15
    assert saved["input"]["synth_volume"] == 1.0
    saved, err = md.save_device(
        tmp_path,
        _device(id="lo", name="Lo", input={"midi_channel": -9, "hit_detection": 1, "synth_volume": -0.2}),
    )
    assert err is None
    assert saved["input"]["midi_channel"] == -1
    assert saved["input"]["hit_detection"] is False
    assert saved["input"]["synth_volume"] == 0.0


def test_source_id_null_becomes_empty(tmp_path: Path):
    saved, err = md.save_device(tmp_path, _device(source_id=None))
    assert err is None
    assert saved["source_id"] == ""


def test_non_object_input_rejected(tmp_path: Path):
    saved, err = md.save_device(tmp_path, _device(input="ch9"))
    assert saved is None
    assert err is not None and "input" in err


def test_source_id_non_string_rejected(tmp_path: Path):
    saved, err = md.save_device(tmp_path, _device(source_id=9))
    assert saved is None
    assert err is not None and "source_id" in err


def test_validate_device_id_override(tmp_path: Path):
    canonical, err = md.validate_device(_device(id="old"), device_id="new-id", config_dir=tmp_path)
    assert err is None
    assert canonical["id"] == "new-id"


def test_notes_null_defaults_empty(tmp_path: Path):
    saved, err = md.save_device(tmp_path, _device(notes=None))
    assert err is None
    assert saved["notes"] == {}


def test_load_device_file_accepts_str_payload():
    parsed = md.load_device_file(json.dumps(_device()))
    assert parsed is not None
    assert parsed["id"] == "living-room-ekit"
    assert parsed["notes"] == {}


def test_list_skips_json_named_directory(tmp_path: Path):
    dest = tmp_path / "midi" / "devices"
    dest.mkdir(parents=True)
    (dest / "trap.json").mkdir()
    md.save_device(tmp_path, _device(id="ok", name="Ok"))
    devices = md.list_devices(tmp_path)
    assert [d["id"] for d in devices] == ["ok"]


def test_device_from_type_uses_catalog_name_when_name_blank(tmp_path: Path):
    saved, err = md.device_from_type(
        tmp_path, "alesis-strata-prime", device_id="named", name="  ",
    )
    assert err is None
    assert saved["name"] == "Alesis Strata Prime"
    assert saved["notes"] == {}


def test_save_rejects_oversized_canonical(tmp_path: Path):
    saved, err = md.save_device(tmp_path, _device(name="x" * (70 * 1024)))
    assert saved is None
    assert err is not None


def test_nested_dangerous_keys_rejected(tmp_path: Path):
    body = _device(input={"midi_channel": -1, "hit_detection": False, "synth_volume": 0.7, "__proto__": {}})
    saved, err = md.save_device(tmp_path, body)
    assert saved is None


def test_device_type_id_must_be_slug(tmp_path: Path):
    saved, err = md.save_device(tmp_path, _device(device_type_id="Not A Slug"))
    assert saved is None
    assert err is not None and "device_type_id" in err


def test_empty_name_rejected(tmp_path: Path):
    saved, err = md.save_device(tmp_path, _device(name="   "))
    assert saved is None
    assert err is not None and "name" in err


def test_scoring_notes_unknown_device_is_empty(tmp_path: Path):
    assert dp.scoring_notes(tmp_path, {"device_id": "ghost"}) == {}
    assert dp.scoring_notes(tmp_path, "nope") == {}


def test_profile_device_id_null_omitted(tmp_path: Path):
    canonical, err = dp.validate_profile(_profile(device_id=None), config_dir=tmp_path)
    assert err is None
    assert "device_id" not in canonical


def test_migrate_uses_matching_catalog_type_id(tmp_path: Path):
    overlay = tmp_path / "midi" / "device-types"
    overlay.mkdir(parents=True)
    (overlay / "user-kit.json").write_text(
        json.dumps({"id": "user-kit", "name": "User Type", "family": "drums", "triggers": []}),
        encoding="utf-8",
    )
    _overlay_kit(tmp_path / "drums")
    migrated = md.migrate_overlay_kit_notes(tmp_path)
    assert migrated is not None
    assert migrated["device_type_id"] == "user-kit"
    assert migrated["notes"] == {"24": "kick", "38": "snare"}
