"""Tests for one-shot builtin drum-timing feedpak seeding into DLC.

INIT-004/SPEC-004: dedicated copy-when-missing helper, independent of
``.starter-content-seeded``.
"""

from __future__ import annotations

import importlib
import os
import sys
import zipfile
from pathlib import Path

import builtin_content
import pytest
import sloppak as sloppak_mod
import yaml


@pytest.fixture()
def server_mod(tmp_path, monkeypatch, isolate_logging):
    monkeypatch.setenv("CONFIG_DIR", str(tmp_path / "config"))
    (tmp_path / "config").mkdir()
    monkeypatch.delenv("DLC_DIR", raising=False)
    sys.modules.pop("server", None)
    mod = importlib.import_module("server")
    yield mod


def _source(server_mod):
    return (
        server_mod._feedBack_server_root()
        / builtin_content.BUILTIN_DRUM_TIMING_SOURCES[0][1]
    )


def _dest(server_mod, dlc):
    return (
        dlc
        / builtin_content.BUILTIN_STARTER_SUBDIR
        / builtin_content.BUILTIN_DRUM_TIMING_SOURCES[0][0]
    )


def test_drum_timing_id_is_starter_not_guitar_diagnostic():
    assert builtin_content.builtin_drum_timing_filename() == (
        "starter/feedBack-diagnostic-basic-drums.feedpak"
    )
    assert builtin_content.builtin_diagnostic_filename() == (
        "diagnostics-builtin/feedBack-diagnostic-basic-guitar.sloppak"
    )
    dest_names = {name for name, _ in builtin_content.BUILTIN_DIAGNOSTIC_SOURCES}
    assert "feedBack-diagnostic-basic-drums.feedpak" not in dest_names
    rels = {rel for _, rel in builtin_content.BUILTIN_DIAGNOSTIC_SOURCES}
    assert "docs/diagnostics/feedBack-diagnostic-basic-drums.feedpak" not in rels


def test_bundled_source_exists_and_is_a_zip(server_mod):
    source = _source(server_mod)
    assert source.is_file(), f"committed feedpak missing: {source}"
    assert zipfile.is_zipfile(source)


def test_bundled_pack_is_44_rock_drums_without_diagnostic_key(tmp_path, server_mod):
    source = _source(server_mod)
    if not source.is_file():
        pytest.skip(f"drum timing source not present: {source}")
    cache = tmp_path / "cache"
    cache.mkdir()
    loaded = sloppak_mod.load_song(source.name, source.parent, cache)
    assert loaded.drum_tab is not None
    hits = loaded.drum_tab.get("hits") or []
    pieces = {h.get("p") for h in hits if isinstance(h, dict)}
    assert {"kick", "snare", "hh_closed"} <= pieces
    assert len(hits) > 8
    with zipfile.ZipFile(source) as zf:
        manifest = yaml.safe_load(zf.read("manifest.yaml"))
    assert "diagnostic" not in manifest
    assert manifest.get("drum_tab") == "drum_tab.json"


def test_seed_copies_when_dest_missing(tmp_path, server_mod):
    dlc = tmp_path / "dlc"
    dlc.mkdir()
    source = _source(server_mod)
    if not source.is_file():
        pytest.skip(f"drum timing source not present: {source}")

    builtin_content.seed_builtin_drum_timing_content(
        server_mod._feedBack_server_root(), dlc
    )

    dest = _dest(server_mod, dlc)
    assert dest.is_file()
    assert dest.stat().st_size == source.stat().st_size
    assert (server_mod.CONFIG_DIR / builtin_content.DRUM_TIMING_SEED_MARKER).is_file()
    assert dest.resolve().is_relative_to((dlc / builtin_content.BUILTIN_STARTER_SUBDIR).resolve())


def test_seed_skips_when_dest_already_present(tmp_path, server_mod):
    dlc = tmp_path / "dlc"
    dlc.mkdir()
    dest = _dest(server_mod, dlc)
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(b"user's own drums pack")

    builtin_content.seed_builtin_drum_timing_content(
        server_mod._feedBack_server_root(), dlc
    )

    assert dest.read_bytes() == b"user's own drums pack"
    assert (server_mod.CONFIG_DIR / builtin_content.DRUM_TIMING_SEED_MARKER).is_file()


def test_seed_does_not_resurrect_user_deleted_dest(tmp_path, server_mod):
    dlc = tmp_path / "dlc"
    dlc.mkdir()
    source = _source(server_mod)
    if not source.is_file():
        pytest.skip(f"drum timing source not present: {source}")

    builtin_content.seed_builtin_drum_timing_content(
        server_mod._feedBack_server_root(), dlc
    )
    dest = _dest(server_mod, dlc)
    assert dest.is_file()
    dest.unlink()

    builtin_content.seed_builtin_drum_timing_content(
        server_mod._feedBack_server_root(), dlc
    )
    assert not dest.exists()


def test_seed_still_copies_when_starter_marker_already_set(tmp_path, server_mod):
    dlc = tmp_path / "dlc"
    dlc.mkdir()
    source = _source(server_mod)
    if not source.is_file():
        pytest.skip(f"drum timing source not present: {source}")

    marker = server_mod.CONFIG_DIR / builtin_content.STARTER_SEED_MARKER
    marker.write_bytes(b"1\n")

    builtin_content.seed_builtin_drum_timing_content(
        server_mod._feedBack_server_root(), dlc
    )

    dest = _dest(server_mod, dlc)
    assert dest.is_file()
    assert dest.stat().st_size == source.stat().st_size
    assert (server_mod.CONFIG_DIR / builtin_content.DRUM_TIMING_SEED_MARKER).is_file()


def test_seed_refuses_symlinked_seed_directory(tmp_path, server_mod):
    dlc = tmp_path / "dlc"
    dlc.mkdir()
    source = _source(server_mod)
    if not source.is_file():
        pytest.skip(f"drum timing source not present: {source}")

    outside_dir = tmp_path / "outside"
    outside_dir.mkdir()
    (dlc / builtin_content.BUILTIN_STARTER_SUBDIR).symlink_to(outside_dir)

    builtin_content.seed_builtin_drum_timing_content(
        server_mod._feedBack_server_root(), dlc
    )

    assert list(outside_dir.iterdir()) == []
    assert not (server_mod.CONFIG_DIR / builtin_content.DRUM_TIMING_SEED_MARKER).exists()


def test_seed_missing_source_does_not_raise(tmp_path, server_mod, monkeypatch):
    dlc = tmp_path / "dlc"
    dlc.mkdir()
    monkeypatch.setattr(
        builtin_content,
        "BUILTIN_DRUM_TIMING_SOURCES",
        [("missing.feedpak", "docs/diagnostics/does-not-exist.feedpak")],
    )

    builtin_content.seed_builtin_drum_timing_content(
        server_mod._feedBack_server_root(), dlc
    )

    assert not (dlc / builtin_content.BUILTIN_STARTER_SUBDIR / "missing.feedpak").exists()
    assert not (server_mod.CONFIG_DIR / builtin_content.DRUM_TIMING_SEED_MARKER).exists()


def test_seed_refuses_dest_name_that_escapes_starter(tmp_path, server_mod, monkeypatch):
    dlc = tmp_path / "dlc"
    dlc.mkdir()
    rel = builtin_content.BUILTIN_DRUM_TIMING_SOURCES[0][1]
    monkeypatch.setattr(
        builtin_content,
        "BUILTIN_DRUM_TIMING_SOURCES",
        [("../escape.feedpak", rel)],
    )

    builtin_content.seed_builtin_drum_timing_content(
        server_mod._feedBack_server_root(), dlc
    )

    assert not (dlc / "escape.feedpak").exists()
    assert not (tmp_path / "escape.feedpak").exists()
    starter = dlc / builtin_content.BUILTIN_STARTER_SUBDIR
    if starter.exists():
        assert list(starter.iterdir()) == []
    assert not (server_mod.CONFIG_DIR / builtin_content.DRUM_TIMING_SEED_MARKER).exists()


def test_seed_dest_stays_in_dir_rejects_separators():
    assert builtin_content._seed_dest_stays_in_dir(
        "feedBack-diagnostic-basic-drums.feedpak"
    )
    assert not builtin_content._seed_dest_stays_in_dir("../escape.feedpak")
    assert not builtin_content._seed_dest_stays_in_dir("sub/pack.feedpak")
    assert not builtin_content._seed_dest_stays_in_dir("..\\escape.feedpak")
    assert not builtin_content._seed_dest_stays_in_dir("")
    assert not builtin_content._seed_dest_stays_in_dir(".")
    assert not builtin_content._seed_dest_stays_in_dir("..")


def test_seed_deferred_until_dlc_configured(tmp_path, server_mod):
    source = _source(server_mod)
    if not source.is_file():
        pytest.skip(f"drum timing source not present: {source}")

    builtin_content.seed_builtin_drum_timing_content(
        server_mod._feedBack_server_root(), None
    )
    assert not (server_mod.CONFIG_DIR / builtin_content.DRUM_TIMING_SEED_MARKER).exists()

    dlc = tmp_path / "dlc"
    dlc.mkdir()
    builtin_content.seed_builtin_drum_timing_content(
        server_mod._feedBack_server_root(), dlc
    )
    assert _dest(server_mod, dlc).is_file()
    assert (server_mod.CONFIG_DIR / builtin_content.DRUM_TIMING_SEED_MARKER).is_file()


def test_seed_does_not_mark_when_destination_is_a_directory(tmp_path, server_mod):
    dlc = tmp_path / "dlc"
    dlc.mkdir()
    source = _source(server_mod)
    if not source.is_file():
        pytest.skip(f"drum timing source not present: {source}")

    bogus = _dest(server_mod, dlc)
    bogus.parent.mkdir(parents=True, exist_ok=True)
    bogus.mkdir()

    builtin_content.seed_builtin_drum_timing_content(
        server_mod._feedBack_server_root(), dlc
    )

    assert bogus.is_dir()
    assert not (server_mod.CONFIG_DIR / builtin_content.DRUM_TIMING_SEED_MARKER).exists()


def test_seed_skips_when_marker_stat_fails(tmp_path, server_mod, monkeypatch):
    dlc = tmp_path / "dlc"
    dlc.mkdir()
    marker = server_mod.CONFIG_DIR / builtin_content.DRUM_TIMING_SEED_MARKER
    real_lstat = os.lstat

    def _lstat(path, *args, **kwargs):
        if Path(path) == marker:
            raise OSError("permission denied")
        return real_lstat(path, *args, **kwargs)

    monkeypatch.setattr(os, "lstat", _lstat)
    builtin_content.seed_builtin_drum_timing_content(
        server_mod._feedBack_server_root(), dlc
    )
    assert not _dest(server_mod, dlc).exists()
    assert not marker.exists()


def test_seed_tolerates_raced_marker_file(tmp_path, server_mod, monkeypatch):
    dlc = tmp_path / "dlc"
    dlc.mkdir()
    source = _source(server_mod)
    if not source.is_file():
        pytest.skip(f"drum timing source not present: {source}")
    marker = server_mod.CONFIG_DIR / builtin_content.DRUM_TIMING_SEED_MARKER
    real_open = os.open

    def _open(path, flags, *args, **kwargs):
        if Path(path) == marker:
            raise FileExistsError
        return real_open(path, flags, *args, **kwargs)

    monkeypatch.setattr(os, "open", _open)
    builtin_content.seed_builtin_drum_timing_content(
        server_mod._feedBack_server_root(), dlc
    )
    assert _dest(server_mod, dlc).is_file()


def test_seed_logs_when_marker_write_fails(tmp_path, server_mod, monkeypatch):
    dlc = tmp_path / "dlc"
    dlc.mkdir()
    source = _source(server_mod)
    if not source.is_file():
        pytest.skip(f"drum timing source not present: {source}")
    marker = server_mod.CONFIG_DIR / builtin_content.DRUM_TIMING_SEED_MARKER
    real_open = os.open

    def _open(path, flags, *args, **kwargs):
        if Path(path) == marker:
            raise OSError("disk full")
        return real_open(path, flags, *args, **kwargs)

    monkeypatch.setattr(os, "open", _open)
    builtin_content.seed_builtin_drum_timing_content(
        server_mod._feedBack_server_root(), dlc
    )
    assert _dest(server_mod, dlc).is_file()
    assert not marker.exists()


def test_seed_never_raises_on_unexpected_error(tmp_path, server_mod, monkeypatch):
    dlc = tmp_path / "dlc"
    dlc.mkdir()
    monkeypatch.setattr(
        builtin_content,
        "_copy_builtin_packs",
        lambda *a, **k: (_ for _ in ()).throw(RuntimeError("boom")),
    )
    builtin_content.seed_builtin_drum_timing_content(
        server_mod._feedBack_server_root(), dlc
    )
    assert not (server_mod.CONFIG_DIR / builtin_content.DRUM_TIMING_SEED_MARKER).exists()


def test_scan_wires_drum_timing_seed():

    """Startup scan path must wire the dedicated helper (not hitch on starter)."""
    import inspect

    import scan as scan_mod

    src = inspect.getsource(scan_mod.background_scan)
    assert "seed_builtin_drum_timing_content" in src
    starter_at = src.find("seed_builtin_starter_content")
    drums_at = src.find("seed_builtin_drum_timing_content")
    assert starter_at != -1 and drums_at > starter_at
