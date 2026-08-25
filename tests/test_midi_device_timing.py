"""INIT-004/SPEC-006 + INIT-006/SPEC-005: MIDI device `timing` field."""

from __future__ import annotations

import json
import math
from pathlib import Path

import drum_profiles as dp
import midi_devices as md


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


def _timing(**overrides) -> dict:
    body = {
        "offset_ms": 12.5,
        "measured_at": "2026-08-24T12:00:00Z",
        "n": 24,
        "median_abs_error_ms": 8.2,
        "origin": "web-midi",
        "audio_backend": "html5",
    }
    body.update(overrides)
    return body


# ── ac-1: canonical shape, clamp, backends ───────────────────────────────────

def test_normalise_timing_canonical_keys_and_values():
    canonical, err = md._normalise_timing(_timing())
    assert err is None
    assert canonical == {
        "offset_ms": 12.5,
        "measured_at": "2026-08-24T12:00:00Z",
        "n": 24,
        "median_abs_error_ms": 8.2,
        "origin": "web-midi",
        "audio_backend": "html5",
    }
    assert list(canonical) == [
        "offset_ms",
        "measured_at",
        "n",
        "median_abs_error_ms",
        "origin",
        "audio_backend",
    ]


def test_normalise_timing_clamps_huge_offset():
    canonical, err = md._normalise_timing(_timing(offset_ms=1e9))
    assert err is None
    assert canonical["offset_ms"] == 250.0


def test_normalise_timing_clamps_negative_offset():
    canonical, err = md._normalise_timing(_timing(offset_ms=-400))
    assert err is None
    assert canonical["offset_ms"] == -250.0


def test_normalise_timing_accepts_juce_backend():
    canonical, err = md._normalise_timing(_timing(audio_backend="juce"))
    assert err is None
    assert canonical["audio_backend"] == "juce"


def test_save_writes_canonical_timing(tmp_path: Path):
    saved, err = md.save_device(tmp_path, _device(timing=_timing()))
    assert err is None
    assert saved["timing"] == _timing()
    on_disk = json.loads(
        (tmp_path / "midi" / "devices" / "living-room-ekit.json").read_text(encoding="utf-8")
    )
    assert on_disk["timing"] == saved["timing"]
    assert "extra" not in on_disk["timing"]


def test_normalise_timing_drops_unknown_keys():
    raw = _timing()
    raw["fail_open"] = True
    raw["nested"] = {"x": 1}
    canonical, err = md._normalise_timing(raw)
    assert err is None
    assert set(canonical) <= set(md._TIMING_CANONICAL_KEYS)
    assert "fail_open" not in canonical


def test_normalise_timing_measured_at_is_opaque_string():
    # aud-3: do not parse measured_at as a clock.
    canonical, err = md._normalise_timing(_timing(measured_at="not-a-real-instant"))
    assert err is None
    assert canonical["measured_at"] == "not-a-real-instant"


# ── ac-2: old files without timing still load ────────────────────────────────

def test_old_device_json_without_timing_loads(tmp_path: Path):
    dest = tmp_path / "midi" / "devices"
    dest.mkdir(parents=True)
    body = _device(notes={"36": "kick"})
    assert "timing" not in body
    (dest / "living-room-ekit.json").write_text(json.dumps(body), encoding="utf-8")
    loaded = md.load_device(tmp_path, "living-room-ekit")
    assert loaded is not None
    assert "timing" not in loaded
    assert loaded["notes"] == {"36": "kick"}


def test_create_with_omit_writes_no_timing_key(tmp_path: Path):
    body = _device()
    assert "timing" not in body
    saved, err = md.save_device(tmp_path, body)
    assert err is None
    assert "timing" not in saved
    on_disk = json.loads(
        (tmp_path / "midi" / "devices" / "living-room-ekit.json").read_text(encoding="utf-8")
    )
    assert "timing" not in on_disk


def test_empty_object_timing_is_not_plus_zero():
    canonical, err = md._normalise_timing({})
    assert err is None
    assert canonical is None


# ── ac-3: omit on existing file preserves ────────────────────────────────────

def test_save_omitted_timing_preserves_on_disk(tmp_path: Path):
    first, err = md.save_device(tmp_path, _device(timing=_timing(offset_ms=40)))
    assert err is None
    assert first["timing"]["offset_ms"] == 40.0
    update = _device(name="Renamed kit", notes={"36": "kick"})
    assert "timing" not in update
    saved, err = md.save_device(tmp_path, update)
    assert err is None
    assert saved["name"] == "Renamed kit"
    assert saved["notes"] == {"36": "kick"}
    assert saved["timing"]["offset_ms"] == 40.0
    on_disk = json.loads(
        (tmp_path / "midi" / "devices" / "living-room-ekit.json").read_text(encoding="utf-8")
    )
    assert on_disk["timing"]["offset_ms"] == 40.0


# ── ac-4: explicit null / empty clear ────────────────────────────────────────

def test_save_timing_null_clears_existing(tmp_path: Path):
    md.save_device(tmp_path, _device(timing=_timing()))
    saved, err = md.save_device(tmp_path, _device(timing=None))
    assert err is None
    assert "timing" not in saved
    on_disk = json.loads(
        (tmp_path / "midi" / "devices" / "living-room-ekit.json").read_text(encoding="utf-8")
    )
    assert "timing" not in on_disk


def test_save_empty_timing_object_clears_existing(tmp_path: Path):
    md.save_device(tmp_path, _device(timing=_timing()))
    saved, err = md.save_device(tmp_path, _device(timing={}))
    assert err is None
    assert "timing" not in saved
    on_disk = json.loads(
        (tmp_path / "midi" / "devices" / "living-room-ekit.json").read_text(encoding="utf-8")
    )
    assert "timing" not in on_disk


# ── ac-5: reject / drop dangerous and non-finite values ──────────────────────

def test_normalise_timing_rejects_nan():
    canonical, err = md._normalise_timing(_timing(offset_ms=float("nan")))
    assert canonical is None
    assert err is not None and "offset_ms" in err
    assert math.isnan(float("nan"))


def test_normalise_timing_rejects_object_offset():
    canonical, err = md._normalise_timing(_timing(offset_ms={"ms": 12}))
    assert canonical is None
    assert err is not None


def test_normalise_timing_rejects_non_object():
    for raw in (12, [1], "html5", True):
        canonical, err = md._normalise_timing(raw)
        assert canonical is None, raw
        assert err is not None


def test_save_rejects_timing_proto_key(tmp_path: Path):
    body = _device(timing=_timing())
    body["timing"]["__proto__"] = {}
    saved, err = md.save_device(tmp_path, body)
    assert saved is None
    assert err is not None


def test_save_clamped_offset_never_written_unclamped(tmp_path: Path):
    saved, err = md.save_device(tmp_path, _device(timing=_timing(offset_ms=1e9)))
    assert err is None
    assert saved["timing"]["offset_ms"] == 250.0
    raw = (tmp_path / "midi" / "devices" / "living-room-ekit.json").read_text(encoding="utf-8")
    assert "1000000000" not in raw
    assert "1e+09" not in raw
    assert "1e9" not in raw


def test_save_rejects_invalid_backend(tmp_path: Path):
    saved, err = md.save_device(tmp_path, _device(timing=_timing(audio_backend="wasapi")))
    assert saved is None
    assert err is not None and "audio_backend" in err


def test_save_rejects_bool_offset(tmp_path: Path):
    saved, err = md.save_device(tmp_path, _device(timing=_timing(offset_ms=True)))
    assert saved is None


# ── ac-6: create-from-type / migrate do not seed timing ──────────────────────

def test_device_from_type_does_not_seed_timing(tmp_path: Path):
    saved, err = md.device_from_type(
        tmp_path, "alesis-strata-prime", device_id="from-prime",
    )
    assert err is None
    assert "timing" not in saved
    on_disk = json.loads(
        (tmp_path / "midi" / "devices" / "from-prime.json").read_text(encoding="utf-8")
    )
    assert "timing" not in on_disk


def test_overlay_migrate_does_not_seed_timing(tmp_path: Path):
    _overlay_kit(tmp_path / "drums")
    migrated = md.migrate_overlay_kit_notes(tmp_path)
    assert migrated is not None
    assert "timing" not in migrated
    on_disk = json.loads(
        (tmp_path / "midi" / "devices" / f"{migrated['id']}.json").read_text(encoding="utf-8")
    )
    assert "timing" not in on_disk


# ── ac-7: drum profile still rejects notes and has no timing field ───────────

def test_validate_profile_still_rejects_notes_and_has_no_timing(tmp_path: Path):
    md.save_device(tmp_path, _device(timing=_timing()))
    canonical, err = dp.validate_profile(
        _profile(device_id="living-room-ekit", notes={"24": "kick"}),
        config_dir=tmp_path,
    )
    assert canonical is None
    assert err is not None and "notes" in err


def test_validate_profile_does_not_grow_timing_field(tmp_path: Path):
    md.save_device(tmp_path, _device(timing=_timing()))
    body = _profile(device_id="living-room-ekit")
    body["timing"] = _timing()
    canonical, err = dp.validate_profile(body, config_dir=tmp_path)
    assert err is None
    assert "timing" not in canonical
    saved, serr = dp.save_profile(tmp_path, body)
    assert serr is None
    assert "timing" not in saved
    on_disk = json.loads(
        (tmp_path / "drums" / "profiles" / "living-room.json").read_text(encoding="utf-8")
    )
    assert "timing" not in on_disk
    assert "notes" not in on_disk


# ── ac-8 / extras: create omit vs preserve, logging path ─────────────────────

def test_normalise_timing_none_is_not_set():
    canonical, err = md._normalise_timing(None)
    assert err is None
    assert canonical is None


def test_normalise_timing_rejects_dangerous_keys_on_timing_object():
    raw = _timing()
    raw["__proto__"] = {}
    canonical, err = md._normalise_timing(raw)
    assert canonical is None
    assert err is not None and "reserved" in err


def test_normalise_timing_rejects_non_string_measured_at():
    canonical, err = md._normalise_timing(_timing(measured_at=1700000000))
    assert canonical is None
    assert err is not None and "measured_at" in err


def test_normalise_timing_rejects_invalid_n():
    for n in (True, -1, 1.5, "24"):
        canonical, err = md._normalise_timing(_timing(n=n))
        assert canonical is None, n
        assert err is not None and "n" in err


def test_normalise_timing_rejects_non_finite_median():
    canonical, err = md._normalise_timing(_timing(median_abs_error_ms=float("nan")))
    assert canonical is None
    assert err is not None and "median_abs_error_ms" in err


def test_normalise_timing_rejects_blank_origin():
    canonical, err = md._normalise_timing(_timing(origin="   "))
    assert canonical is None
    assert err is not None and "origin" in err


def test_normalise_timing_optional_fields_may_be_omitted():
    canonical, err = md._normalise_timing({"offset_ms": 8, "audio_backend": "html5"})
    assert err is None
    assert canonical == {"offset_ms": 8.0, "audio_backend": "html5"}


def test_save_omit_on_existing_without_timing_stays_unset(tmp_path: Path):
    md.save_device(tmp_path, _device())
    saved, err = md.save_device(tmp_path, _device(name="Still unset"))
    assert err is None
    assert "timing" not in saved


def test_save_omit_preserves_nothing_when_on_disk_unreadable(tmp_path: Path):
    dest = tmp_path / "midi" / "devices"
    dest.mkdir(parents=True)
    (dest / "living-room-ekit.json").write_text("{not json", encoding="utf-8")
    saved, err = md.save_device(tmp_path, _device())
    assert err is None
    assert "timing" not in saved


# ── INIT-006/SPEC-005 ac-1: old offset_ms + tag is the active profile ─────────

def test_old_format_offset_and_tag_loads_as_active_profile(tmp_path: Path):
    dest = tmp_path / "midi" / "devices"
    dest.mkdir(parents=True)
    body = _device(timing={
        "offset_ms": 12.5,
        "measured_at": "2026-08-24T12:00:00Z",
        "n": 24,
        "median_abs_error_ms": 8.2,
        "origin": "web-midi",
        "audio_backend": "html5",
    })
    assert "profiles" not in body["timing"]
    assert "audio_latency_hint_ms" not in body["timing"]
    (dest / "living-room-ekit.json").write_text(json.dumps(body), encoding="utf-8")
    loaded = md.load_device(tmp_path, "living-room-ekit")
    assert loaded is not None
    timing = loaded["timing"]
    assert timing["offset_ms"] == 12.5
    assert timing["origin"] == "web-midi"
    assert timing["audio_backend"] == "html5"
    assert "profiles" not in timing
    active = md.active_timing_profile(timing)
    assert active == {
        "origin": "web-midi",
        "audio_backend": "html5",
        "offset_ms": 12.5,
    }


def test_empty_profiles_leftover_offset_stays_active():
    canonical, err = md._normalise_timing(_timing(profiles=[]))
    assert err is None
    assert canonical["offset_ms"] == 12.5
    assert "profiles" not in canonical
    active = md.active_timing_profile(canonical)
    assert active["offset_ms"] == 12.5
    assert active["origin"] == "web-midi"


# ── INIT-006/SPEC-005 ac-2: second topology kept; switch selects match ────────

def test_second_topology_keeps_first_switch_selects_match(tmp_path: Path):
    first, err = md.save_device(
        tmp_path,
        _device(timing=_timing(offset_ms=12.5, origin="web-midi", audio_backend="html5")),
    )
    assert err is None
    assert first["timing"]["offset_ms"] == 12.5
    second, err = md.save_device(
        tmp_path,
        _device(timing=_timing(offset_ms=40.0, origin="desktop", audio_backend="juce")),
    )
    assert err is None
    timing = second["timing"]
    keys = {(p["origin"], p["audio_backend"], p["offset_ms"]) for p in timing["profiles"]}
    assert ("web-midi", "html5", 12.5) in keys
    assert ("desktop", "juce", 40.0) in keys
    assert timing["offset_ms"] == 40.0
    assert timing["origin"] == "desktop"
    assert timing["audio_backend"] == "juce"
    switched = md.select_timing_profile(timing, "web-midi", "html5")
    assert switched is not None
    assert switched["offset_ms"] == 12.5
    assert switched["origin"] == "web-midi"
    assert switched["audio_backend"] == "html5"
    switched_keys = {
        (p["origin"], p["audio_backend"], p["offset_ms"]) for p in switched["profiles"]
    }
    assert switched_keys == keys
    still_desktop = md.active_timing_profile(switched, "desktop", "juce")
    assert still_desktop is not None
    assert still_desktop["offset_ms"] == 40.0


def test_upsert_timing_profile_keeps_first_in_memory():
    first, err = md._normalise_timing(_timing(offset_ms=12.5))
    assert err is None
    updated, err = md.upsert_timing_profile(
        first, origin="desktop", audio_backend="juce", offset_ms=18.0,
    )
    assert err is None
    keys = {(p["origin"], p["audio_backend"]) for p in updated["profiles"]}
    assert keys == {("web-midi", "html5"), ("desktop", "juce")}
    assert updated["offset_ms"] == 18.0
    web = md.active_timing_profile(updated, "web-midi", "html5")
    assert web["offset_ms"] == 12.5
    assert md.active_timing_profile(updated, "nas", "html5") is None


def test_unknown_profile_backend_skipped_leftover_kept():
    raw = _timing(offset_ms=12.5)
    raw["profiles"] = [
        {"origin": "nas", "audio_backend": "wasapi", "offset_ms": 99},
        {"origin": "web-midi", "audio_backend": "html5", "offset_ms": 12.5},
    ]
    canonical, err = md._normalise_timing(raw)
    assert err is None
    origins = {p["origin"] for p in canonical["profiles"]}
    assert "nas" not in origins
    assert "web-midi" in origins
    assert canonical["offset_ms"] == 12.5


# ── INIT-006/SPEC-005 ac-3: hint omitted vs finite; never summed ──────────────

def test_audio_latency_hint_omitted_means_no_hint():
    canonical, err = md._normalise_timing(_timing())
    assert err is None
    assert "audio_latency_hint_ms" not in canonical


def test_audio_latency_hint_finite_round_trip_not_summed(tmp_path: Path):
    offset = 12.5
    hint = 40.0
    saved, err = md.save_device(
        tmp_path,
        _device(timing=_timing(offset_ms=offset, audio_latency_hint_ms=hint)),
    )
    assert err is None
    timing = saved["timing"]
    assert timing["audio_latency_hint_ms"] == hint
    assert timing["offset_ms"] == offset
    assert timing["offset_ms"] != offset + hint
    on_disk = json.loads(
        (tmp_path / "midi" / "devices" / "living-room-ekit.json").read_text(encoding="utf-8")
    )
    assert on_disk["timing"]["audio_latency_hint_ms"] == hint
    assert on_disk["timing"]["offset_ms"] == offset
    reloaded = md.load_device(tmp_path, "living-room-ekit")
    assert reloaded["timing"]["audio_latency_hint_ms"] == hint
    assert reloaded["timing"]["offset_ms"] == offset


def test_audio_latency_hint_omitted_on_disk_fixture(tmp_path: Path):
    dest = tmp_path / "midi" / "devices"
    dest.mkdir(parents=True)
    body = _device(timing=_timing())
    (dest / "living-room-ekit.json").write_text(json.dumps(body), encoding="utf-8")
    loaded = md.load_device(tmp_path, "living-room-ekit")
    assert "audio_latency_hint_ms" not in loaded["timing"]


def test_normalise_timing_rejects_non_finite_hint():
    canonical, err = md._normalise_timing(_timing(audio_latency_hint_ms=float("nan")))
    assert canonical is None
    assert err is not None and "audio_latency_hint_ms" in err


def test_upsert_does_not_fold_hint_into_offset():
    seeded, err = md._normalise_timing(_timing(offset_ms=10.0, audio_latency_hint_ms=25.0))
    assert err is None
    updated, err = md.upsert_timing_profile(
        seeded, origin="desktop", audio_backend="juce", offset_ms=10.0,
    )
    assert err is None
    assert updated["offset_ms"] == 10.0
    assert updated["audio_latency_hint_ms"] == 25.0
    assert updated["offset_ms"] != 10.0 + 25.0


def test_profiles_must_be_a_list():
    canonical, err = md._normalise_timing(_timing(profiles={"web-midi": 12.5}))
    assert canonical is None
    assert err is not None and "profiles" in err


def test_non_object_profile_row_skipped():
    raw = _timing()
    raw["profiles"] = ["nope", {"origin": "web-midi", "audio_backend": "html5", "offset_ms": 12.5}]
    canonical, err = md._normalise_timing(raw)
    assert err is None
    assert canonical["profiles"] == [
        {"origin": "web-midi", "audio_backend": "html5", "offset_ms": 12.5},
    ]


def test_offset_derived_from_matching_profile_when_cache_omitted():
    canonical, err = md._normalise_timing({
        "origin": "desktop",
        "audio_backend": "juce",
        "profiles": [
            {"origin": "web-midi", "audio_backend": "html5", "offset_ms": 12.5},
            {"origin": "desktop", "audio_backend": "juce", "offset_ms": 40},
        ],
    })
    assert err is None
    assert canonical["offset_ms"] == 40.0
    assert canonical["origin"] == "desktop"
    assert canonical["audio_backend"] == "juce"


def test_offset_derived_from_first_profile_when_tag_omitted():
    canonical, err = md._normalise_timing({
        "profiles": [
            {"origin": "web-midi", "audio_backend": "html5", "offset_ms": 12.5},
        ],
    })
    assert err is None
    assert canonical["offset_ms"] == 12.5
    assert canonical["origin"] == "web-midi"
    assert canonical["audio_backend"] == "html5"


def test_active_profile_none_and_origin_mismatch():
    assert md.active_timing_profile(None) is None
    canonical, err = md._normalise_timing(_timing())
    assert err is None
    assert md.active_timing_profile(canonical, "desktop", "juce") is None


def test_active_profile_incomplete_tag_without_origin():
    canonical, err = md._normalise_timing({"offset_ms": 8, "audio_backend": "html5"})
    assert err is None
    active = md.active_timing_profile(canonical)
    assert active["offset_ms"] == 8.0
    assert active["audio_backend"] == "html5"
    assert md.active_timing_profile(canonical, audio_backend="juce") is None


def test_select_unknown_origin_returns_none_without_wipe():
    canonical, err = md._normalise_timing(_timing())
    assert err is None
    switched = md.select_timing_profile(canonical, "desktop", "juce")
    assert switched is None
    assert canonical["offset_ms"] == 12.5
    assert "profiles" not in canonical


def test_select_matching_origin_on_old_format_synthesizes_profile():
    canonical, err = md._normalise_timing(_timing())
    assert err is None
    assert "profiles" not in canonical
    switched = md.select_timing_profile(canonical, "web-midi", "html5")
    assert switched is not None
    assert switched["offset_ms"] == 12.5
    assert switched["profiles"] == [
        {"origin": "web-midi", "audio_backend": "html5", "offset_ms": 12.5},
    ]


def test_third_save_updates_matching_profile_keeps_other(tmp_path: Path):
    md.save_device(
        tmp_path,
        _device(timing=_timing(offset_ms=12.5, origin="web-midi", audio_backend="html5")),
    )
    md.save_device(
        tmp_path,
        _device(timing=_timing(offset_ms=40.0, origin="desktop", audio_backend="juce")),
    )
    third, err = md.save_device(
        tmp_path,
        _device(timing=_timing(offset_ms=7.0, origin="web-midi", audio_backend="html5")),
    )
    assert err is None
    keys = {(p["origin"], p["audio_backend"], p["offset_ms"]) for p in third["timing"]["profiles"]}
    assert ("web-midi", "html5", 7.0) in keys
    assert ("desktop", "juce", 40.0) in keys
    assert third["timing"]["offset_ms"] == 7.0


def test_upsert_from_unset_timing():
    updated, err = md.upsert_timing_profile(
        None, origin="web-midi", audio_backend="html5", offset_ms=5.0,
    )
    assert err is None
    assert updated["offset_ms"] == 5.0
    assert updated["origin"] == "web-midi"
    active = md.active_timing_profile(updated)
    assert active["offset_ms"] == 5.0


def test_profile_offset_clamped_like_cache():
    raw = _timing(offset_ms=1e9)
    raw["profiles"] = [
        {"origin": "web-midi", "audio_backend": "html5", "offset_ms": 1e9},
    ]
    canonical, err = md._normalise_timing(raw)
    assert err is None
    assert canonical["offset_ms"] == 250.0
    assert canonical["profiles"][0]["offset_ms"] == 250.0
