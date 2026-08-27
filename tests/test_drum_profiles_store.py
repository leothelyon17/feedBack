"""Unit tests for lib/drum_profiles.py — INIT-003/SPEC-001."""

from __future__ import annotations

import json
from pathlib import Path

import drum_profiles as dp
import drums


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


def _write_old_settings(config_dir: Path, **keys) -> dict:
    settings = dict(keys)
    (config_dir / "config.json").write_text(json.dumps(settings), encoding="utf-8")
    return settings


# ── ac-1: persist under drums/profiles/{id}.json ─────────────────────────────

def test_save_writes_canonical_document_under_profiles(tmp_path: Path):
    saved, err = dp.save_profile(tmp_path, _profile())
    assert err is None
    assert saved is not None
    dest = tmp_path / "drums" / "profiles" / "living-room.json"
    assert dest.is_file()
    on_disk = json.loads(dest.read_text(encoding="utf-8"))
    assert on_disk["id"] == "living-room"
    assert on_disk["name"] == "Living room"
    assert on_disk["kit_id"] == "alesis-strata-prime"
    assert set(on_disk) == {"id", "name", "kit_id", "device", "input", "highway"}
    assert "notes" not in on_disk
    assert "owner_id" not in on_disk
    loaded = dp.load_profile(tmp_path, "living-room")
    assert loaded == saved


def test_list_profiles_creates_nothing_when_dir_missing(tmp_path: Path):
    assert dp.list_profiles(tmp_path) == []
    assert not (tmp_path / "drums" / "profiles").exists()


def test_save_creates_missing_profiles_dir(tmp_path: Path):
    saved, err = dp.save_profile(tmp_path, _profile(id="alpha", name="Alpha"))
    assert err is None and saved["id"] == "alpha"
    assert (tmp_path / "drums" / "profiles").is_dir()


# ── ac-2: notes rejected; kit.notes untouched ────────────────────────────────

def test_validate_rejects_notes_key():
    body = _profile(notes={"24": "kick"})
    canonical, err = dp.validate_profile(body)
    assert canonical is None
    assert err is not None and "notes" in err


def test_save_rejects_notes_and_does_not_write(tmp_path: Path):
    saved, err = dp.save_profile(tmp_path, _profile(notes={}))
    assert saved is None
    assert err is not None and "notes" in err
    assert not (tmp_path / "drums" / "profiles" / "living-room.json").exists()


def test_seed_does_not_copy_custom_map_onto_profile_notes(tmp_path: Path):
    settings = {"active_kit": "alesis-strata-prime"}
    custom = {"24": "kick", "38": "snare"}
    seeded = dp.seed_default_profile(
        tmp_path, settings, drums_custom_map=custom,
    )
    assert seeded is not None
    assert "notes" not in seeded
    dest = tmp_path / "drums" / "profiles" / "default.json"
    assert "notes" not in json.loads(dest.read_text(encoding="utf-8"))


def test_kit_notes_untouched_when_profile_saved(tmp_path: Path):
    user = tmp_path / "drums"
    user.mkdir()
    kit_path = user / "user-kit.json"
    kit_path.write_text(
        json.dumps({"id": "user-kit", "name": "User", "notes": {"24": "kick"}}),
        encoding="utf-8",
    )
    before = kit_path.read_text(encoding="utf-8")
    dp.save_profile(tmp_path, _profile(id="sess", name="Sess", kit_id="user-kit"))
    assert kit_path.read_text(encoding="utf-8") == before
    kit = drums.load_kit_file(kit_path)
    assert kit is not None
    assert kit["notes"][24] == "kick"


# ── ac-3: kit glob ignores profiles/ and refuses planted profile JSON ────────

def test_load_kits_ignores_profiles_subdirectory(tmp_path: Path):
    user = tmp_path / "drums"
    dp.save_profile(tmp_path, _profile())
    kits = drums.load_kits(None, user)
    assert "living-room" not in kits
    assert kits == {}


def test_planted_profile_json_in_kit_glob_is_refused(tmp_path: Path):
    user = tmp_path / "drums"
    user.mkdir()
    planted = _profile(id="planted", name="Planted")
    (user / "planted.json").write_text(json.dumps(planted), encoding="utf-8")
    kits = drums.load_kits(None, user)
    assert "planted" not in kits
    assert drums.load_kit_file(user / "planted.json") is None


def test_real_kit_in_glob_still_loads_beside_profiles(tmp_path: Path):
    user = tmp_path / "drums"
    user.mkdir()
    (user / "user-kit.json").write_text(
        json.dumps({"id": "user-kit", "name": "User", "notes": {"36": "kick"}}),
        encoding="utf-8",
    )
    dp.save_profile(tmp_path, _profile(id="sess", name="Sess", kit_id="user-kit"))
    kits = drums.load_kits(None, user)
    assert set(kits) == {"user-kit"}
    assert "sess" not in kits


# ── ac-4: activate dual-writes active_kit ────────────────────────────────────

def test_activate_profile_dual_writes_active_kit(tmp_path: Path):
    dp.save_profile(tmp_path, _profile(id="stage", name="Stage", kit_id="alesis-strata-prime"))
    settings = {"volume": 0.5}
    parsed, err = dp.activate_profile(tmp_path, "stage", settings)
    assert err is None and parsed is not None
    assert settings["active_drum_profile"] == "stage"
    assert settings["active_kit"] == "alesis-strata-prime"


def test_activate_unset_kit_id_clears_active_kit(tmp_path: Path):
    dp.save_profile(tmp_path, _profile(id="bare", name="Bare", kit_id=""))
    settings = {"active_kit": "alesis-strata-prime"}
    dp.activate_profile(tmp_path, "bare", settings)
    assert "active_kit" not in settings
    assert settings["active_drum_profile"] == "bare"


# ── ac-5: seed fixture combinations ──────────────────────────────────────────

def test_seed_from_active_kit(tmp_path: Path):
    settings = {"active_kit": "alesis-strata-prime"}
    seeded = dp.seed_default_profile(tmp_path, settings)
    assert seeded is not None
    assert seeded["id"] == "default"
    assert seeded["kit_id"] == "alesis-strata-prime"
    assert settings["active_kit"] == "alesis-strata-prime"
    assert settings["active_drum_profile"] == "default"
    assert (tmp_path / "drums" / "profiles" / "default.json").is_file()


def test_seed_unset_active_kit_points_at_shipped(tmp_path: Path):
    settings: dict = {}
    seeded = dp.seed_default_profile(tmp_path, settings)
    assert seeded is not None
    assert seeded["kit_id"] == "alesis-strata-prime"
    assert settings["active_kit"] == "alesis-strata-prime"


def test_seed_no_kits_leaves_kit_id_unset(tmp_path: Path):
    empty = tmp_path / "empty-kits"
    empty.mkdir()
    settings: dict = {}
    seeded = dp.seed_default_profile(
        tmp_path, settings, shipped_dir=empty, user_dir=empty,
    )
    assert seeded is not None
    assert seeded["kit_id"] == ""
    assert "active_kit" not in settings


def test_seed_from_feedback_drums_input_v1(tmp_path: Path):
    settings = {"active_kit": "alesis-strata-prime"}
    legacy = {
        "deviceEnabled": True,
        "midiChannel": 9,
        "hitDetection": True,
        "synthVolume": 0.4,
    }
    seeded = dp.seed_default_profile(
        tmp_path, settings, feedback_drums_input_v1=legacy,
    )
    assert seeded is not None
    assert seeded["device"]["enabled"] is True
    assert seeded["device"]["source_id"] == ""
    assert seeded["input"]["midi_channel"] == 9
    assert seeded["input"]["hit_detection"] is True
    assert seeded["input"]["synth_volume"] == 0.4


def test_seed_from_drum_h3d_kit_v1_copies_visual_only(tmp_path: Path):
    settings = {"active_kit": "alesis-strata-prime"}
    h3d = {
        "name": "keep-visual",
        "lanes": [{"piece": "snare"}, {"piece": "kick"}],
        "fallbacks": {"tom_hi": "snare"},
        "notes": {"24": "kick"},
    }
    seeded = dp.seed_default_profile(tmp_path, settings, drum_h3d_kit_v1=h3d)
    assert seeded is not None
    assert "notes" not in seeded
    assert seeded["highway"]["3d"]["lanes"] == [{"piece": "snare"}, {"piece": "kick"}]
    assert seeded["highway"]["3d"]["fallbacks"]["tom_hi"] == "snare"


def test_seed_all_four_legacy_stores_together(tmp_path: Path):
    settings = {"active_kit": "alesis-strata-prime"}
    seeded = dp.seed_default_profile(
        tmp_path,
        settings,
        feedback_drums_input_v1={"deviceEnabled": True, "midiChannel": 0},
        drums_custom_map={"24": "kick"},
        drum_h3d_kit_v1={"lanes": [{"piece": "ride"}], "fallbacks": {}},
    )
    assert seeded is not None
    assert seeded["kit_id"] == "alesis-strata-prime"
    assert seeded["device"]["enabled"] is True
    assert seeded["input"]["midi_channel"] == 0
    assert seeded["highway"]["3d"]["lanes"] == [{"piece": "ride"}]
    assert "notes" not in seeded


def test_seed_is_idempotent(tmp_path: Path):
    settings = {"active_kit": "alesis-strata-prime"}
    first = dp.seed_default_profile(tmp_path, settings)
    second = dp.seed_default_profile(
        tmp_path, settings, feedback_drums_input_v1={"deviceEnabled": True},
    )
    assert first is not None and second is not None
    assert first["id"] == second["id"] == "default"
    assert second["device"]["enabled"] is False
    assert len(dp.list_profiles(tmp_path)) == 1


# ── ac-6: old settings without active_drum_profile keep loading ──────────────

def test_old_settings_round_trip_without_active_drum_profile(tmp_path: Path):
    settings = _write_old_settings(tmp_path, volume=0.8, active_kit="alesis-strata-prime")
    raw = json.loads((tmp_path / "config.json").read_text(encoding="utf-8"))
    assert "active_drum_profile" not in raw
    seeded = dp.seed_default_profile(tmp_path, settings)
    assert seeded is not None
    reread = json.loads((tmp_path / "config.json").read_text(encoding="utf-8"))
    assert "active_drum_profile" not in reread
    assert reread["active_kit"] == "alesis-strata-prime"
    assert reread["volume"] == 0.8
    kits = drums.load_kits(drums.SHIPPED_KITS_DIR, tmp_path / "drums")
    assert "alesis-strata-prime" in kits


def test_list_and_load_kits_tolerate_absent_active_drum_profile(tmp_path: Path):
    _write_old_settings(tmp_path, theme="dark")
    assert dp.list_profiles(tmp_path) == []
    kits = drums.load_kits(drums.SHIPPED_KITS_DIR, tmp_path / "drums")
    assert "alesis-strata-prime" in kits


# ── ac-7: slug id + logical source_id ────────────────────────────────────────

def test_validate_rejects_bad_profile_id():
    for bad in ("Foo", "has space", "foo/bar", "../kits/foo", "foo_bar", ""):
        canonical, err = dp.validate_profile(_profile(id=bad))
        assert canonical is None, bad
        assert err is not None


def test_validate_rejects_bad_kit_id_slug():
    canonical, err = dp.validate_profile(_profile(kit_id="Not A Slug"))
    assert canonical is None
    assert err is not None and "kit_id" in err


def test_empty_name_rejected():
    canonical, err = dp.validate_profile(_profile(name="   "))
    assert canonical is None
    assert err is not None and "name" in err


def test_source_id_empty_string_allowed():
    canonical, err = dp.validate_profile(
        _profile(device={"source_id": "", "enabled": False})
    )
    assert err is None
    assert canonical["device"]["source_id"] == ""


def test_source_id_logical_id_accepted():
    canonical, err = dp.validate_profile(
        _profile(device={"source_id": "web-midi::pad-1", "enabled": True})
    )
    assert err is None
    assert canonical["device"]["source_id"] == "web-midi::pad-1"


def test_source_id_rejects_raw_port_labels():
    labels = [
        "Alesis Nitro Max",
        "MIDIIN2 (MPK Mini)",
        "USB Midi Device",
        "CoreMIDI: IAC Driver",
    ]
    for label in labels:
        canonical, err = dp.validate_profile(
            _profile(device={"source_id": label, "enabled": True})
        )
        assert canonical is None, label
        assert err is not None and "source_id" in err


# ── ac-8: no owner_id written or read ────────────────────────────────────────

def test_validate_rejects_owner_id():
    canonical, err = dp.validate_profile(_profile(owner_id="user-1"))
    assert canonical is None
    assert err is not None and "owner_id" in err


def test_saved_document_never_contains_owner_id(tmp_path: Path):
    saved, err = dp.save_profile(tmp_path, _profile())
    assert err is None
    on_disk = json.loads(
        (tmp_path / "drums" / "profiles" / "living-room.json").read_text(encoding="utf-8")
    )
    assert "owner_id" not in on_disk
    assert "owner_id" not in saved


# ── security: path containment + reserved keys ───────────────────────────────

def test_profile_path_rejects_traversal_id(tmp_path: Path):
    assert dp.profile_path(tmp_path, "../kits/foo") is None
    assert dp.profile_path(tmp_path, "..") is None
    assert dp.profile_path(tmp_path, "foo/bar") is None
    saved, err = dp.save_profile(tmp_path, _profile(id="../kits/foo", name="X"))
    assert saved is None
    assert err is not None
    kits_dir = tmp_path / "drums" / "kits"
    assert not kits_dir.exists()
    assert not list((tmp_path / "drums").rglob("foo.json")) if (tmp_path / "drums").exists() else True
    # Nothing escaped to config_dir root either.
    assert not (tmp_path / "foo.json").exists()
    assert not (tmp_path / "kits").exists()


def test_dangerous_keys_rejected():
    for key in ("__proto__", "constructor", "prototype"):
        body = _profile()
        body[key] = {"polluted": True}
        canonical, err = dp.validate_profile(body)
        assert canonical is None, key
        assert err is not None and "reserved" in err


def test_nested_dangerous_keys_rejected():
    body = _profile()
    body["highway"] = {"2d": {"__proto__": {"x": 1}}}
    canonical, err = dp.validate_profile(body)
    assert canonical is None
    assert err is not None and "reserved" in err


def test_corrupt_json_skipped_on_list(tmp_path: Path, caplog):
    root = dp.profiles_dir(tmp_path)
    root.mkdir(parents=True)
    (root / "good.json").write_text(json.dumps(_profile(id="good", name="Good")), encoding="utf-8")
    (root / "bad.json").write_text("{not json", encoding="utf-8")
    with caplog.at_level("WARNING", logger="feedBack.lib.drum_profiles"):
        listed = dp.list_profiles(tmp_path)
    assert [p["id"] for p in listed] == ["good"]
    assert any("invalid JSON" in rec.message for rec in caplog.records)


def test_empty_settings_without_active_kit_still_seeds(tmp_path: Path):
    seeded = dp.seed_default_profile(tmp_path, {})
    assert seeded is not None
    assert seeded["kit_id"]
    assert dp.PROFILE_ID_RE.fullmatch(seeded["kit_id"])


def test_validate_rejects_non_object_and_bad_nested_types():
    assert dp.validate_profile([])[0] is None
    assert dp.validate_profile(_profile(device="usb"))[0] is None
    assert dp.validate_profile(_profile(input="ch9"))[0] is None
    assert dp.validate_profile(_profile(highway="flat"))[0] is None
    assert dp.validate_profile(_profile(kit_id=12))[0] is None
    assert dp.validate_profile(_profile(device={"source_id": 9, "enabled": True}))[0] is None


def test_defaults_when_device_input_highway_omitted():
    body = {"id": "bare", "name": "Bare", "kit_id": ""}
    canonical, err = dp.validate_profile(body)
    assert err is None
    assert canonical["device"]["source_id"] == ""
    assert canonical["input"]["midi_channel"] == -1
    assert canonical["highway"]["2d"]["lane_preset"] == "phase_shift_8"


def test_input_clamps_channel_and_volume():
    body = _profile(input={"midi_channel": 99, "hit_detection": True, "synth_volume": 4})
    canonical, err = dp.validate_profile(body)
    assert err is None
    assert canonical["input"]["midi_channel"] == 15
    assert canonical["input"]["synth_volume"] == 1.0
    body = _profile(input={"midi_channel": -8, "hit_detection": False, "synth_volume": -1})
    canonical, err = dp.validate_profile(body)
    assert canonical["input"]["midi_channel"] == -1
    assert canonical["input"]["synth_volume"] == 0.0
    body = _profile(input={"midi_channel": True, "hit_detection": 1, "synth_volume": True})
    canonical, err = dp.validate_profile(body)
    assert canonical["input"]["midi_channel"] == -1
    assert canonical["input"]["hit_detection"] is False
    assert canonical["input"]["synth_volume"] == 0.7


def test_source_id_null_becomes_empty():
    canonical, err = dp.validate_profile(
        _profile(device={"source_id": None, "enabled": True})
    )
    assert err is None
    assert canonical["device"]["source_id"] == ""


def test_highway_branch_non_dict_falls_back():
    body = _profile(highway={"2d": "nope", "3d": None})
    canonical, err = dp.validate_profile(body)
    assert err is None
    assert canonical["highway"]["2d"]["lane_preset"] == "phase_shift_8"


def test_load_profile_file_accepts_str_and_rejects_oversized():
    text = json.dumps(_profile(id="from-str", name="From str"))
    parsed = dp.load_profile_file(text)
    assert parsed is not None and parsed["id"] == "from-str"
    huge = "{" + ("x" * (65 * 1024)) + "}"
    assert dp.load_profile_file(huge) is None


def test_load_profile_file_missing_path_returns_none(tmp_path: Path):
    assert dp.load_profile_file(tmp_path / "nope.json") is None


def test_load_and_activate_unknown_profile(tmp_path: Path):
    assert dp.load_profile(tmp_path, "missing") is None
    parsed, err = dp.activate_profile(tmp_path, "missing", {})
    assert parsed is None
    assert err == "unknown profile"


def test_seed_legacy_json_string_and_snake_case(tmp_path: Path):
    settings = {"active_kit": "alesis-strata-prime"}
    raw = json.dumps({
        "enabled": True,
        "midi_channel": "4",
        "hit_detection": True,
        "synth_volume": "0.2",
    })
    seeded = dp.seed_default_profile(
        tmp_path, settings,
        feedback_drums_input_v1=raw,
        drums_custom_map=b'{"24":"kick"}',
        drum_h3d_kit_v1=b"not-json",
    )
    assert seeded is not None
    assert seeded["device"]["enabled"] is True
    assert seeded["input"]["midi_channel"] == 4
    assert seeded["input"]["hit_detection"] is True
    assert seeded["input"]["synth_volume"] == 0.2


def test_seed_first_kit_when_prime_absent(tmp_path: Path):
    shipped = tmp_path / "shipped"
    shipped.mkdir()
    (shipped / "zeta.json").write_text(
        json.dumps({"id": "zeta-kit", "name": "Zeta", "notes": {}}), encoding="utf-8"
    )
    (shipped / "alpha.json").write_text(
        json.dumps({"id": "alpha-kit", "name": "Alpha", "notes": {}}), encoding="utf-8"
    )
    seeded = dp.seed_default_profile(
        tmp_path, {}, shipped_dir=shipped, user_dir=tmp_path / "empty",
    )
    assert seeded is not None
    assert seeded["kit_id"] == "alpha-kit"
    assert seeded["name"] == "Alpha"


def test_seed_settings_none_still_writes(tmp_path: Path):
    seeded = dp.seed_default_profile(tmp_path, None)
    assert seeded is not None
    assert dp.load_profile(tmp_path, "default") is not None


def test_validate_profile_id_override():
    canonical, err = dp.validate_profile(_profile(id="old"), profile_id="new-id")
    assert err is None
    assert canonical["id"] == "new-id"


# ── INIT-007/SPEC-002: scoring.precision_mode persist ─────────────────────────

def test_load_and_validate_missing_scoring_is_false():
    canonical, err = dp.validate_profile(_profile())
    assert err is None
    assert canonical["scoring"] == {"precision_mode": False}
    parsed = dp.load_profile_file(json.dumps(_profile()))
    assert parsed is not None
    assert parsed["scoring"]["precision_mode"] is False


def test_save_load_round_trip_keeps_precision_mode_true(tmp_path: Path):
    body = _profile(scoring={"precision_mode": True})
    saved, err = dp.save_profile(tmp_path, body)
    assert err is None
    assert saved["scoring"]["precision_mode"] is True
    dest = tmp_path / "drums" / "profiles" / "living-room.json"
    on_disk = json.loads(dest.read_text(encoding="utf-8"))
    assert on_disk["scoring"] == {"precision_mode": True}
    loaded = dp.load_profile(tmp_path, "living-room")
    assert loaded["scoring"]["precision_mode"] is True
    assert loaded == saved


def test_save_omit_on_existing_without_scoring_stays_false(tmp_path: Path):
    first, err = dp.save_profile(tmp_path, _profile())
    assert err is None
    assert first["scoring"]["precision_mode"] is False
    saved, err = dp.save_profile(tmp_path, _profile(name="Still default"))
    assert err is None
    assert saved["scoring"]["precision_mode"] is False
    on_disk = json.loads(
        (tmp_path / "drums" / "profiles" / "living-room.json").read_text(encoding="utf-8")
    )
    assert "scoring" not in on_disk


def test_save_omitted_scoring_preserves_on_disk_true(tmp_path: Path):
    first, err = dp.save_profile(tmp_path, _profile(scoring={"precision_mode": True}))
    assert err is None
    assert first["scoring"]["precision_mode"] is True
    update = _profile(name="Renamed room")
    assert "scoring" not in update
    saved, err = dp.save_profile(tmp_path, update)
    assert err is None
    assert saved["name"] == "Renamed room"
    assert saved["scoring"]["precision_mode"] is True
    on_disk = json.loads(
        (tmp_path / "drums" / "profiles" / "living-room.json").read_text(encoding="utf-8")
    )
    assert on_disk["scoring"]["precision_mode"] is True


def test_explicit_false_clears_stored_precision_mode(tmp_path: Path):
    dp.save_profile(tmp_path, _profile(scoring={"precision_mode": True}))
    saved, err = dp.save_profile(tmp_path, _profile(scoring={"precision_mode": False}))
    assert err is None
    assert saved["scoring"]["precision_mode"] is False
    on_disk = json.loads(
        (tmp_path / "drums" / "profiles" / "living-room.json").read_text(encoding="utf-8")
    )
    assert "scoring" not in on_disk


def test_precision_mode_garbage_coerces_false():
    for garbage in ("yes", 1, "true", "True", 0, [], {}):
        canonical, err = dp.validate_profile(_profile(scoring={"precision_mode": garbage}))
        assert err is None, garbage
        assert canonical["scoring"]["precision_mode"] is False, garbage
    for raw in (None, "yes", 1, True):
        canonical, err = dp.validate_profile(_profile(scoring=raw))
        assert err is None, raw
        assert canonical["scoring"]["precision_mode"] is False, raw


def test_save_garbage_precision_mode_does_not_persist_true(tmp_path: Path):
    saved, err = dp.save_profile(
        tmp_path, _profile(scoring={"precision_mode": "yes"}),
    )
    assert err is None
    assert saved["scoring"]["precision_mode"] is False
    on_disk = json.loads(
        (tmp_path / "drums" / "profiles" / "living-room.json").read_text(encoding="utf-8")
    )
    assert "scoring" not in on_disk


def test_old_format_profile_without_scoring_still_loads(tmp_path: Path):
    root = dp.profiles_dir(tmp_path)
    root.mkdir(parents=True)
    old = {
        "id": "legacy",
        "name": "Legacy",
        "kit_id": "alesis-strata-prime",
        "device": {"source_id": "", "enabled": False},
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
    dest = root / "legacy.json"
    dest.write_text(json.dumps(old), encoding="utf-8")
    assert "scoring" not in json.loads(dest.read_text(encoding="utf-8"))
    loaded = dp.load_profile(tmp_path, "legacy")
    assert loaded is not None
    assert loaded["id"] == "legacy"
    assert loaded["scoring"]["precision_mode"] is False
    listed = dp.list_profiles(tmp_path)
    assert [p["id"] for p in listed] == ["legacy"]
    assert listed[0]["scoring"]["precision_mode"] is False


def test_scoring_lives_at_profile_root_not_highway():
    body = _profile()
    body["highway"] = {
        "2d": {"lane_preset": "phase_shift_8", "precision_mode": True},
        "3d": {"precision_mode": True},
    }
    canonical, err = dp.validate_profile(body)
    assert err is None
    assert canonical["scoring"]["precision_mode"] is False


def test_save_omit_preserves_nothing_when_on_disk_unreadable(tmp_path: Path):
    dest = tmp_path / "drums" / "profiles"
    dest.mkdir(parents=True)
    (dest / "living-room.json").write_text("{not json", encoding="utf-8")
    saved, err = dp.save_profile(tmp_path, _profile())
    assert err is None
    assert saved["scoring"]["precision_mode"] is False
    on_disk = json.loads((dest / "living-room.json").read_text(encoding="utf-8"))
    assert "scoring" not in on_disk
