"""Tests for lib/progression.py — the pure progression engine (spec 010)."""

import json
from datetime import datetime
from pathlib import Path

import pytest

from progression import (
    active_challenges,
    evaluate_event,
    goal_matches_event,
    instrument_for_arrangement,
    load_content,
    mastery_rank,
    path_max_level,
    period_keys,
    period_resets_at,
    select_quests,
    threshold_goal_met,
    wallet_balance,
)

REPO_ROOT = Path(__file__).resolve().parents[1]
BUNDLED_CONTENT = REPO_ROOT / "data" / "progression"


# ---------------------------------------------------------------------------
# Content loading
# ---------------------------------------------------------------------------


def test_bundled_content_loads_clean():
    content, warnings = load_content(BUNDLED_CONTENT)
    assert warnings == []
    assert set(content["paths"]) == {"guitar", "bass", "drums", "keys"}
    assert content["challenge_index"]
    assert content["quests"]["daily"]["count"] == 3
    assert content["quests"]["weekly"]["count"] == 2
    assert content["quests"]["daily"]["pool"]
    assert content["shop"]
    # Every indexed challenge id is namespaced under its path.
    for cid, entry in content["challenge_index"].items():
        assert cid.startswith(entry["path_id"] + ".")


def _write_content(root: Path, paths=None, quests=None, shop=None):
    (root / "paths").mkdir(parents=True, exist_ok=True)
    for name, data in (paths or {}).items():
        (root / "paths" / f"{name}.json").write_text(
            data if isinstance(data, str) else json.dumps(data)
        )
    (root / "quests.json").write_text(json.dumps(quests if quests is not None else {}))
    (root / "shop.json").write_text(json.dumps(shop if shop is not None else {}))


def _minimal_path(pid="guitar", level=1, required=1, challenges=None):
    return {
        "id": pid,
        "name": pid.title(),
        "levels": [
            {
                "level": level,
                "required": required,
                "challenges": challenges
                or [
                    {
                        "id": f"{pid}.l{level}.c1",
                        "title": "C1",
                        "goal": {"type": "song_completed", "target": 1},
                    }
                ],
            }
        ],
    }


def test_load_content_skips_bad_json_file(tmp_path):
    _write_content(tmp_path, paths={"guitar": _minimal_path()})
    (tmp_path / "paths" / "broken.json").write_text("{not json")
    content, warnings = load_content(tmp_path)
    assert "guitar" in content["paths"]
    assert any("broken.json" in w for w in warnings)


def test_load_content_rejects_unknown_goal_type(tmp_path):
    bad = _minimal_path(
        challenges=[
            {"id": "guitar.l1.bad", "goal": {"type": "moonwalk", "target": 1}},
            {"id": "guitar.l1.ok", "goal": {"type": "song_completed", "target": 1}},
        ]
    )
    _write_content(tmp_path, paths={"guitar": bad})
    content, warnings = load_content(tmp_path)
    ids = list(content["challenge_index"])
    assert ids == ["guitar.l1.ok"]
    assert any("unknown goal type" in w for w in warnings)


def test_load_content_rejects_duplicate_challenge_ids(tmp_path):
    p = _minimal_path(
        challenges=[
            {"id": "guitar.l1.dup", "goal": {"type": "song_completed", "target": 1}},
            {"id": "guitar.l1.dup", "goal": {"type": "minigame_run", "target": 1}},
        ]
    )
    _write_content(tmp_path, paths={"guitar": p})
    content, warnings = load_content(tmp_path)
    assert list(content["challenge_index"]) == ["guitar.l1.dup"]
    assert content["challenge_index"]["guitar.l1.dup"]["challenge"]["goal"]["type"] == (
        "song_completed"
    )
    assert any("duplicate challenge id" in w for w in warnings)


def test_load_content_clamps_required_and_warns_on_level_gap(tmp_path):
    p = _minimal_path(required=5)
    p["levels"].append(
        {
            "level": 3,  # gap: level 2 missing
            "required": 1,
            "challenges": [
                {"id": "guitar.l3.c1", "goal": {"type": "minigame_run", "target": 1}}
            ],
        }
    )
    _write_content(tmp_path, paths={"guitar": p})
    content, warnings = load_content(tmp_path)
    assert content["paths"]["guitar"]["levels"][0]["required"] == 1  # clamped
    assert any("clamped" in w for w in warnings)
    assert any("numbering gap" in w for w in warnings)


def test_load_content_validates_quests_and_shop(tmp_path):
    _write_content(
        tmp_path,
        paths={"guitar": _minimal_path()},
        quests={
            "daily": {
                "count": 2,
                "pool": [
                    {"id": "d.ok", "reward_db": 10, "goal": {"type": "minigame_run", "target": 1}},
                    {"id": "d.neg", "reward_db": -5, "goal": {"type": "minigame_run", "target": 1}},
                    {"id": "d.badgoal", "reward_db": 10, "goal": {"type": "nope", "target": 1}},
                ],
            }
        },
        shop={
            "items": [
                {"id": "theme.ok", "slot": "theme", "cost": 100, "payload": {"colors": {}}},
                {"id": "hat.bad", "slot": "hat", "cost": 100, "payload": {}},
                {"id": "theme.negcost", "slot": "theme", "cost": -1, "payload": {}},
            ]
        },
    )
    content, warnings = load_content(tmp_path)
    assert list(content["quests"]["daily"]["pool"]) == ["d.ok"]
    assert any("missing" in w and "weekly" in w for w in warnings)
    assert list(content["shop"]) == ["theme.ok"]
    assert any("unknown slot" in w for w in warnings)
    assert any("cost" in w for w in warnings)
    assert any("reward_db" in w for w in warnings)


def test_load_content_missing_root_is_nonfatal(tmp_path):
    content, warnings = load_content(tmp_path / "nope")
    assert content["paths"] == {}
    assert warnings


# ---------------------------------------------------------------------------
# Instrument attribution
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "entry,expected",
    [
        ({"type": "lead"}, "guitar"),
        ({"type": "rhythm"}, "guitar"),
        ({"type": "combo"}, "guitar"),
        ({"type": "bass"}, "bass"),
        ({"type": "drums"}, "drums"),
        ({"name": "Bass"}, "bass"),
        ({"name": "Drum Kit"}, "drums"),
        ({"name": "Percussion"}, "drums"),
        ({"name": "Vocals"}, "vocals"),
        ({"name": "Lead"}, "guitar"),
        ({"type": "piano"}, "keys"),
        ({"type": "keys"}, "keys"),
        ({"name": "Keys"}, "keys"),
        ({"name": "Piano"}, "keys"),
        ({"name": "Keyboard"}, "keys"),
        ({"name": "Synth Lead"}, "keys"),
        # bass name check wins before the keys word-match
        ({"name": "Bass Synth"}, "bass"),
        # word-boundary: "keys" inside another word is not keys
        ({"name": "Monkeys Medley"}, "guitar"),
        ({}, "guitar"),
        (None, "guitar"),
        # name overrides generic guitar type (legacy archive keys arrangements)
        ({"type": "lead", "name": "Keys"}, "keys"),
        ({"type": "combo", "name": "Piano"}, "keys"),
        ({"type": "lead", "name": "Bass"}, "bass"),
    ],
)
def test_instrument_for_arrangement(entry, expected):
    assert instrument_for_arrangement(entry) == expected


# ---------------------------------------------------------------------------
# Quest periods
# ---------------------------------------------------------------------------


def test_period_keys():
    keys = period_keys(datetime(2026, 6, 12, 15, 30))
    assert keys == {"daily": "2026-06-12", "weekly": "2026-W24"}


def test_period_keys_iso_year_boundary():
    # 2024-12-30 is a Monday belonging to ISO week 1 of 2025.
    keys = period_keys(datetime(2024, 12, 30, 8, 0))
    assert keys["daily"] == "2024-12-30"
    assert keys["weekly"] == "2025-W01"


def test_period_resets_at_daily():
    resets = period_resets_at("daily", datetime(2026, 6, 12, 23, 59))
    assert resets == datetime(2026, 6, 13, 0, 0)


def test_period_resets_at_weekly():
    # 2026-06-12 is a Friday; next Monday is 2026-06-15.
    assert period_resets_at("weekly", datetime(2026, 6, 12, 10, 0)) == datetime(2026, 6, 15)
    # From a Monday the period runs a full week.
    assert period_resets_at("weekly", datetime(2026, 6, 15, 0, 0)) == datetime(2026, 6, 22)


def test_period_resets_at_rejects_unknown():
    with pytest.raises(ValueError):
        period_resets_at("hourly", datetime(2026, 6, 12))


def test_select_quests_deterministic():
    pool = [f"q{i}" for i in range(10)]
    first = select_quests(pool, "daily", "2026-06-12", 3)
    assert first == select_quests(list(reversed(pool)), "daily", "2026-06-12", 3)
    assert len(first) == 3
    assert first == sorted(first)
    assert set(first) <= set(pool)


def test_select_quests_varies_across_periods():
    pool = [f"q{i}" for i in range(10)]
    selections = {
        tuple(select_quests(pool, "daily", f"2026-06-{day:02d}", 3))
        for day in range(1, 15)
    }
    assert len(selections) > 1


def test_select_quests_small_pool_returns_all():
    assert select_quests(["b", "a"], "weekly", "2026-W24", 5) == ["a", "b"]


# ---------------------------------------------------------------------------
# Goal matching
# ---------------------------------------------------------------------------


def _song_event(**payload):
    base = {"filename": "song.archive", "instrument": "guitar", "accuracy": 0.9, "score": 1000}
    base.update(payload)
    return {"type": "song_completed", "payload": base}


def test_goal_matches_song_accuracy_boundary():
    goal = {"type": "song_completed", "min_accuracy": 0.8, "target": 1}
    assert goal_matches_event(goal, _song_event(accuracy=0.8))
    assert not goal_matches_event(goal, _song_event(accuracy=0.799))
    assert not goal_matches_event(goal, _song_event(accuracy=None))


def test_goal_matches_song_filters():
    assert not goal_matches_event(
        {"type": "song_completed", "instrument": "bass", "target": 1}, _song_event()
    )
    assert goal_matches_event(
        {"type": "song_completed", "instrument": "guitar", "target": 1}, _song_event()
    )
    assert goal_matches_event(
        {"type": "song_completed", "filename": "song.archive", "target": 1}, _song_event()
    )
    assert not goal_matches_event(
        {"type": "song_completed", "filename": "other.archive", "target": 1}, _song_event()
    )
    assert not goal_matches_event(
        {"type": "song_completed", "min_score": 2000, "target": 1}, _song_event()
    )


def test_goal_matches_songs_played_total():
    goal = {"type": "songs_played_total", "target": 3}
    assert goal_matches_event(goal, _song_event(instrument="bass", accuracy=0.1))
    assert not goal_matches_event(goal, {"type": "minigame_run", "payload": {}})


def test_diagnostic_plays_do_not_count_as_regular_songs():
    # The calibration sloppak must not feed song challenges/quests — finishing
    # onboarding at 100% yields rank 1 exactly, not rank 1 + first-challenge
    # completions (it IS a perfect guitar play, after all).
    diag = _song_event(filename="diagnostics-builtin/diag.sloppak",
                       is_diagnostic=True, accuracy=1.0)
    assert not goal_matches_event(
        {"type": "song_completed", "instrument": "guitar", "target": 1}, diag)
    assert not goal_matches_event(
        {"type": "song_completed", "min_accuracy": 0.8, "target": 1}, diag)
    assert not goal_matches_event({"type": "songs_played_total", "target": 3}, diag)
    # …unless a goal explicitly targets the diagnostic by filename.
    assert goal_matches_event(
        {"type": "song_completed", "filename": "diagnostics-builtin/diag.sloppak", "target": 1},
        diag)


def test_diagnostic_play_still_completes_calibration_but_no_challenges():
    outcome = evaluate_event(
        _song_event(is_diagnostic=True, accuracy=1.0),
        _content(),
        _snapshot(calibration_status="pending"),
    )
    assert outcome["calibration_completed"] is True
    assert outcome["challenges"] == []
    assert outcome["level_ups"] == []


def test_goal_matches_minigame():
    event = {"type": "minigame_run", "payload": {"game_id": "chord_sprint", "score": 500}}
    assert goal_matches_event({"type": "minigame_run", "target": 1}, event)
    assert goal_matches_event(
        {"type": "minigame_run", "game_id": "chord_sprint", "min_score": 500, "target": 1}, event
    )
    assert not goal_matches_event(
        {"type": "minigame_run", "game_id": "flappy_bend", "target": 1}, event
    )
    assert not goal_matches_event(
        {"type": "minigame_run", "min_score": 501, "target": 1}, event
    )


def test_goal_matches_quest_completed():
    event = {"type": "quest_completed", "payload": {"period_type": "daily", "quest_id": "d.x"}}
    assert goal_matches_event({"type": "quest_completed", "target": 3}, event)
    assert goal_matches_event({"type": "quest_completed", "period": "daily", "target": 3}, event)
    assert not goal_matches_event(
        {"type": "quest_completed", "period": "weekly", "target": 3}, event
    )


def test_threshold_goals():
    assert threshold_goal_met({"type": "streak_reached", "days": 7}, {"streak": 7})
    assert not threshold_goal_met({"type": "streak_reached", "days": 7}, {"streak": 6})
    assert threshold_goal_met({"type": "db_earned", "amount": 100}, {"xp_total": 100})
    assert not threshold_goal_met({"type": "db_earned", "amount": 100}, {"xp_total": 99})
    assert not threshold_goal_met({"type": "song_completed", "target": 1}, {})


# ---------------------------------------------------------------------------
# evaluate_event
# ---------------------------------------------------------------------------


def _content(levels=None, daily_pool=None, weekly_pool=None):
    """Small in-memory content fixture."""
    levels = levels or [
        {
            "level": 1,
            "required": 2,
            "challenges": [
                {
                    "id": "guitar.l1.any",
                    "title": "Any",
                    "description": "",
                    "goal": {"type": "song_completed", "instrument": "guitar", "target": 1},
                },
                {
                    "id": "guitar.l1.acc",
                    "title": "Acc",
                    "description": "",
                    "goal": {
                        "type": "song_completed",
                        "instrument": "guitar",
                        "min_accuracy": 0.8,
                        "target": 1,
                    },
                },
                {
                    "id": "guitar.l1.three",
                    "title": "Three",
                    "description": "",
                    "goal": {"type": "song_completed", "target": 3},
                },
            ],
        },
        {
            "level": 2,
            "required": 1,
            "challenges": [
                {
                    "id": "guitar.l2.distinct",
                    "title": "Distinct",
                    "description": "",
                    "goal": {"type": "song_completed", "distinct": True, "target": 2},
                }
            ],
        },
    ]
    paths = {"guitar": {"id": "guitar", "name": "Guitar", "icon": "", "order": 1, "levels": levels}}
    index = {}
    for entry in levels:
        for ch in entry["challenges"]:
            index[ch["id"]] = {"path_id": "guitar", "level": entry["level"], "challenge": ch}
    return {
        "paths": paths,
        "challenge_index": index,
        "quests": {
            "daily": {"count": 1, "pool": {q["id"]: q for q in (daily_pool or [])}},
            "weekly": {"count": 1, "pool": {q["id"]: q for q in (weekly_pool or [])}},
        },
        "shop": {},
    }


def _snapshot(**overrides):
    snap = {
        "calibration_status": "completed",
        "paths": {"guitar": 0},
        "challenges": {},
        "quests": [],
        "streak": 0,
        "xp_total": 0,
    }
    snap.update(overrides)
    return snap


def test_evaluate_event_increments_and_completes_challenges():
    outcome = evaluate_event(_song_event(accuracy=0.95), _content(), _snapshot())
    by_id = {c["challenge_id"]: c for c in outcome["challenges"]}
    assert by_id["guitar.l1.any"]["completed"] is True
    assert by_id["guitar.l1.acc"]["completed"] is True
    assert by_id["guitar.l1.three"]["count"] == 1
    assert by_id["guitar.l1.three"]["completed"] is False
    # Two completions in one event meet required=2 -> level up.
    assert outcome["level_ups"] == [{"path_id": "guitar", "new_level": 1}]


def test_evaluate_event_no_levelup_below_required():
    outcome = evaluate_event(_song_event(accuracy=0.5), _content(), _snapshot())
    by_id = {c["challenge_id"]: c for c in outcome["challenges"]}
    assert by_id["guitar.l1.any"]["completed"] is True
    assert "guitar.l1.acc" not in by_id
    assert outcome["level_ups"] == []


def test_evaluate_event_counts_prior_completions_toward_levelup():
    snapshot = _snapshot(challenges={"guitar.l1.acc": {"count": 1, "completed": True}})
    outcome = evaluate_event(_song_event(accuracy=0.5), _content(), snapshot)
    assert outcome["level_ups"] == [{"path_id": "guitar", "new_level": 1}]


def test_evaluate_event_distinct_dedupes_replays():
    content = _content()
    snapshot = _snapshot(paths={"guitar": 1})  # working level-2 set
    first = evaluate_event(_song_event(filename="a.archive"), content, snapshot)
    ch = first["challenges"][0]
    assert ch["count"] == 1 and not ch["completed"]
    assert ch["detail"] == {"seen": ["a.archive"]}

    snapshot["challenges"] = {
        "guitar.l2.distinct": {"count": 1, "completed": False, "detail": ch["detail"]}
    }
    replay = evaluate_event(_song_event(filename="a.archive"), content, snapshot)
    assert replay["challenges"] == []  # same song again: no advance

    other = evaluate_event(_song_event(filename="b.archive"), content, snapshot)
    ch2 = other["challenges"][0]
    assert ch2["count"] == 2 and ch2["completed"]
    assert other["level_ups"] == [{"path_id": "guitar", "new_level": 2}]


def test_evaluate_event_default_counts_replays():
    # guitar.l1.three has no distinct flag: the same song three times completes it.
    content = _content()
    snapshot = _snapshot(challenges={"guitar.l1.three": {"count": 2, "completed": False}})
    outcome = evaluate_event(_song_event(filename="same.archive", accuracy=0.1), content, snapshot)
    by_id = {c["challenge_id"]: c for c in outcome["challenges"]}
    assert by_id["guitar.l1.three"]["count"] == 3
    assert by_id["guitar.l1.three"]["completed"] is True


def test_evaluate_event_threshold_challenges_complete_on_any_event():
    levels = [
        {
            "level": 1,
            "required": 1,
            "challenges": [
                {
                    "id": "guitar.l1.streak",
                    "title": "Streak",
                    "description": "",
                    "goal": {"type": "streak_reached", "days": 3},
                }
            ],
        }
    ]
    content = _content(levels=levels)
    quiet = evaluate_event({"type": "minigame_run", "payload": {}}, content, _snapshot(streak=2))
    assert quiet["challenges"] == []
    outcome = evaluate_event({"type": "minigame_run", "payload": {}}, content, _snapshot(streak=3))
    assert outcome["challenges"][0]["completed"] is True
    assert outcome["level_ups"] == [{"path_id": "guitar", "new_level": 1}]


def test_evaluate_event_quests():
    daily = [
        {
            "id": "d.two",
            "title": "Two songs",
            "description": "",
            "reward_db": 50,
            "goal": {"type": "song_completed", "target": 2},
        }
    ]
    content = _content(daily_pool=daily)
    quests = [
        {"period_type": "daily", "quest_id": "d.two", "count": 0, "completed": False,
         "reward_db": 50, "detail": None},
        {"period_type": "daily", "quest_id": "d.gone", "count": 0, "completed": False,
         "reward_db": 10, "detail": None},  # no longer in pool: ignored
    ]
    snapshot = _snapshot(quests=quests)
    first = evaluate_event(_song_event(), content, snapshot)
    assert len(first["quests"]) == 1
    q = first["quests"][0]
    assert (q["quest_id"], q["count"], q["completed"]) == ("d.two", 1, False)

    snapshot["quests"][0]["count"] = 1
    second = evaluate_event(_song_event(), content, snapshot)
    q = second["quests"][0]
    assert q["completed"] is True and q["reward_db"] == 50


def test_evaluate_event_quest_completion_feeds_challenges():
    levels = [
        {
            "level": 1,
            "required": 1,
            "challenges": [
                {
                    "id": "guitar.l1.quests",
                    "title": "Quests",
                    "description": "",
                    "goal": {"type": "quest_completed", "period": "daily", "target": 1},
                }
            ],
        }
    ]
    content = _content(levels=levels)
    event = {"type": "quest_completed", "payload": {"period_type": "daily", "quest_id": "d.x"}}
    outcome = evaluate_event(event, content, _snapshot())
    assert outcome["challenges"][0]["completed"] is True
    assert outcome["level_ups"] == [{"path_id": "guitar", "new_level": 1}]


def test_evaluate_event_drum_timing_pack_does_not_complete_calibration():
    """INIT-004/SPEC-004: the bundled 4/4 rock chart is not the guitar diagnostic."""
    import builtin_content

    drums = builtin_content.builtin_drum_timing_filename()
    guitar = builtin_content.builtin_diagnostic_filename()
    assert drums != guitar
    outcome = evaluate_event(
        _song_event(filename=drums, is_diagnostic=False, accuracy=1.0),
        _content(),
        _snapshot(calibration_status="pending"),
    )
    assert outcome["calibration_completed"] is False


def test_evaluate_event_calibration():
    content = _content()
    diag = _song_event(is_diagnostic=True, accuracy=1.0)
    assert evaluate_event(diag, content, _snapshot(calibration_status="pending"))[
        "calibration_completed"
    ]
    # A skipped player can still upgrade to completed.
    assert evaluate_event(diag, content, _snapshot(calibration_status="skipped"))[
        "calibration_completed"
    ]
    assert not evaluate_event(diag, content, _snapshot(calibration_status="completed"))[
        "calibration_completed"
    ]
    near_miss = _song_event(is_diagnostic=True, accuracy=0.99)
    assert not evaluate_event(near_miss, content, _snapshot(calibration_status="pending"))[
        "calibration_completed"
    ]
    not_diag = _song_event(accuracy=1.0)
    assert not evaluate_event(not_diag, content, _snapshot(calibration_status="pending"))[
        "calibration_completed"
    ]


def test_evaluate_event_ignores_unselected_paths():
    outcome = evaluate_event(_song_event(), _content(), _snapshot(paths={}))
    assert outcome["challenges"] == []
    assert outcome["level_ups"] == []


def test_evaluate_event_at_max_level_is_quiet():
    outcome = evaluate_event(_song_event(), _content(), _snapshot(paths={"guitar": 2}))
    assert outcome["challenges"] == []
    assert outcome["level_ups"] == []


# ---------------------------------------------------------------------------
# Rank / wallet / helpers
# ---------------------------------------------------------------------------


def test_mastery_rank():
    assert mastery_rank("pending", {}) == 0
    assert mastery_rank(None, {}) == 0
    assert mastery_rank("skipped", {}) == 1
    assert mastery_rank("completed", {}) == 1
    assert mastery_rank("completed", {"guitar": 2, "bass": 1}) == 4
    assert mastery_rank("pending", {"guitar": 2}) == 2  # paths count even pre-calibration


def test_wallet_balance():
    assert wallet_balance(1000, 250) == 750
    assert wallet_balance(100, 500) == 0  # source reset below spent: clamp
    assert wallet_balance(None, None) == 0


def test_active_challenges_and_max_level():
    content = _content()
    assert [c["id"] for c in active_challenges(content, "guitar", 0)] == [
        "guitar.l1.any",
        "guitar.l1.acc",
        "guitar.l1.three",
    ]
    assert [c["id"] for c in active_challenges(content, "guitar", 1)] == ["guitar.l2.distinct"]
    assert active_challenges(content, "guitar", 2) == []  # max level
    assert active_challenges(content, "nope", 0) == []
    assert path_max_level(content, "guitar") == 2
    assert path_max_level(content, "nope") == 0
