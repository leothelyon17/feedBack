"""Build the FeedBack Diagnostic — Basic Drums feedpak.

A short, generated, non-copyrighted 4/4 rock beat (kick / snare / closed hat)
for timing-offset checks. Click-and-beat backing only — no external audio.

This pack is a suggested library song, not the guitar Mastery Rank diagnostic
(INIT-004/SPEC-004). It does not carry a `diagnostic:` manifest key.

Run from the feedBack repo root:

    python3 docs/diagnostics/build_diagnostic_basic_drums.py

Output (zip archive):

    docs/diagnostics/feedBack-diagnostic-basic-drums.feedpak
"""

from __future__ import annotations

import json
import math
import shutil
import struct
import subprocess
import sys
import wave
import zipfile
from pathlib import Path

try:
    import yaml
except ImportError:
    yaml = None


def _yaml_scalar(v):
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, int):
        return str(v)
    if isinstance(v, float):
        return repr(v)
    if v is None:
        return "null"
    s = str(v)
    if any(c in s for c in ':{}[]&*#?|-<>=!%@`"') or s.strip() != s:
        return json.dumps(s, ensure_ascii=False)
    return s


def _yaml_lines(obj, indent=0):
    prefix = "  " * indent
    lines = []
    if isinstance(obj, dict):
        for k, v in obj.items():
            if isinstance(v, dict):
                lines.append(f"{prefix}{k}:")
                lines.extend(_yaml_lines(v, indent + 1))
            elif isinstance(v, list):
                if not v:
                    lines.append(f"{prefix}{k}: []")
                elif all(isinstance(x, dict) for x in v):
                    lines.append(f"{prefix}{k}:")
                    for item in v:
                        lines.append(f"{prefix}  -")
                        for ik, iv in item.items():
                            if isinstance(iv, (dict, list)):
                                lines.append(f"{prefix}    {ik}:")
                                lines.extend(_yaml_lines(iv, indent + 3))
                            else:
                                lines.append(f"{prefix}    {ik}: {_yaml_scalar(iv)}")
                else:
                    lines.append(f"{prefix}{k}:")
                    for item in v:
                        lines.append(f"{prefix}  - {_yaml_scalar(item)}")
            else:
                lines.append(f"{prefix}{k}: {_yaml_scalar(v)}")
    elif isinstance(obj, list):
        for item in obj:
            if isinstance(item, dict):
                lines.append(f"{prefix}-")
                for k, v in item.items():
                    if isinstance(v, (dict, list)):
                        lines.append(f"{prefix}  {k}:")
                        lines.extend(_yaml_lines(v, indent + 2))
                    else:
                        lines.append(f"{prefix}  {k}: {_yaml_scalar(v)}")
            else:
                lines.append(f"{prefix}- {_yaml_scalar(item)}")
    return lines


def dump_manifest_yaml(manifest: dict) -> str:
    if yaml is not None:
        return yaml.safe_dump(manifest, sort_keys=False, allow_unicode=True)
    return "\n".join(_yaml_lines(manifest)) + "\n"


# ── Chart timing (INIT-004/SPEC-004) ────────────────────────────────────────
BPM = 100.0
SECONDS_PER_BEAT = 60.0 / BPM
BEATS_PER_BAR = 4
BAR_S = BEATS_PER_BAR * SECONDS_PER_BEAT

COUNT_IN_BARS = 1
GROOVE_BARS = 8
OUTRO_BARS = 1
SR = 44100


def _sine_burst(freq_hz, duration_s, amplitude):
    n = int(SR * duration_s)
    out = []
    fade = max(1, int(0.004 * SR))
    for i in range(n):
        env = 1.0
        if i < fade:
            env = i / fade
        elif i >= n - fade:
            env = (n - 1 - i) / fade
        s = math.sin(2 * math.pi * freq_hz * (i / SR)) * amplitude * env
        out.append(s)
    return out


def _noise_burst(duration_s, amplitude, seed=1):
    """Deterministic cheap noise for snare body (no random)."""
    n = int(SR * duration_s)
    out = []
    fade = max(1, int(0.003 * SR))
    x = seed
    for i in range(n):
        x = (1103515245 * x + 12345) & 0x7FFFFFFF
        noise = (x / 0x7FFFFFFF) * 2.0 - 1.0
        env = 1.0
        if i < fade:
            env = i / fade
        elif i >= n - fade:
            env = (n - 1 - i) / fade
        # Exponential decay so it reads as a hit, not a burst of static.
        env *= math.exp(-i / max(1, n * 0.35))
        out.append(noise * amplitude * env)
    return out


def _mix(buf, samples, t):
    i0 = int(t * SR)
    n_total = len(buf)
    for j, v in enumerate(samples):
        idx = i0 + j
        if 0 <= idx < n_total:
            buf[idx] += v


def write_beat_wav(path: Path, total_duration_s: float, count_in_s: float):
    """Metronome click plus kick/snare/hat bursts aligned to the drum tab."""
    n_total = int(math.ceil(total_duration_s * SR))
    buf = [0.0] * n_total

    click_dur = 0.04
    downbeat_tone = 1500
    upbeat_tone = 1000
    count_in_amp_scale = 0.35

    beat_idx = 0
    t = 0.0
    while t < total_duration_s - click_dur:
        is_downbeat = (beat_idx % BEATS_PER_BAR) == 0
        amp = 0.16 if is_downbeat else 0.08
        if t < count_in_s:
            amp *= count_in_amp_scale
        _mix(
            buf,
            _sine_burst(downbeat_tone if is_downbeat else upbeat_tone, click_dur, amp),
            t,
        )
        t += SECONDS_PER_BEAT
        beat_idx += 1

    eighth = SECONDS_PER_BEAT / 2.0
    groove_start = count_in_s
    groove_end = count_in_s + GROOVE_BARS * BAR_S
    t = groove_start
    eighth_idx = 0
    while t < groove_end - 0.01:
        beat_in_bar = eighth_idx % 8
        _mix(buf, _sine_burst(9000, 0.018, 0.07), t)  # closed hat
        if beat_in_bar in (0, 4):
            _mix(buf, _sine_burst(60, 0.09, 0.38), t)  # kick
        if beat_in_bar in (2, 6):
            _mix(buf, _noise_burst(0.06, 0.22, seed=beat_in_bar + 7), t)
            _mix(buf, _sine_burst(180, 0.05, 0.16), t)  # snare
        t += eighth
        eighth_idx += 1

    pcm = bytearray()
    for v in buf:
        s = max(-1.0, min(1.0, v))
        pcm.extend(struct.pack("<h", int(s * 32700)))

    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(bytes(pcm))


def _hit(t, piece, velocity=100):
    return {"t": round(t, 3), "p": piece, "v": velocity}


def build_chart():
    count_in_s = COUNT_IN_BARS * BAR_S
    groove_s = GROOVE_BARS * BAR_S
    end_t = (COUNT_IN_BARS + GROOVE_BARS + OUTRO_BARS) * BAR_S

    hits = []
    eighth = SECONDS_PER_BEAT / 2.0
    t = count_in_s
    eighth_idx = 0
    while t < count_in_s + groove_s - 0.01:
        beat_in_bar = eighth_idx % 8
        hits.append(_hit(t, "hh_closed", 80 if beat_in_bar % 2 else 100))
        if beat_in_bar in (0, 4):
            hits.append(_hit(t, "kick", 110))
        if beat_in_bar in (2, 6):
            hits.append(_hit(t, "snare", 108))
        t += eighth
        eighth_idx += 1

    hits.sort(key=lambda h: (h["t"], h["p"]))

    drum_tab = {
        "version": 1,
        "name": "Drums",
        "kit": [
            {"id": "kick", "name": "Kick"},
            {"id": "snare", "name": "Snare"},
            {"id": "hh_closed", "name": "Closed Hat"},
        ],
        "hits": hits,
    }

    # Official keys only — no `diagnostic:` (INIT-004/SPEC-004, REQ-018).
    manifest = {
        "title": "FeedBack Diagnostic — Basic Drums",
        "artist": "FeedBack",
        "album": "Timing Calibration",
        "year": 2026,
        "duration": round(end_t, 3),
        "drum_tab": "drum_tab.json",
        "stems": [{
            "id": "full",
            "file": "stems/full.ogg",
            "default": True,
        }],
        "arrangements": [{
            "id": "drums",
            "name": "Drums",
            "type": "drums",
            "drum_tab": "drum_tab.json",
        }],
    }

    return manifest, drum_tab, end_t, count_in_s


def _build_zip(src_dir: Path, zip_path: Path):
    if zip_path.exists():
        zip_path.unlink()
    with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for p in sorted(src_dir.rglob("*")):
            if p.is_file():
                rel = p.relative_to(src_dir).as_posix()
                info = zipfile.ZipInfo(filename=rel, date_time=(1980, 1, 1, 0, 0, 0))
                info.compress_type = zipfile.ZIP_DEFLATED
                info.external_attr = (0o644 & 0xFFFF) << 16
                info.create_system = 3
                zf.writestr(info, p.read_bytes())


def _encode_ogg(wav_path: Path, ogg_path: Path):
    encoder_cmds = [
        ["-c:a", "libvorbis", "-q:a", "5"],
        ["-strict", "-2", "-ac", "2", "-c:a", "vorbis", "-q:a", "5"],
    ]
    last_err = None
    for enc_args in encoder_cmds:
        try:
            subprocess.run(
                ["ffmpeg", "-y", "-loglevel", "error",
                 "-i", str(wav_path),
                 *enc_args,
                 str(ogg_path)],
                check=True,
                stderr=subprocess.DEVNULL if enc_args != encoder_cmds[-1] else None,
            )
            return
        except FileNotFoundError as e:
            raise RuntimeError(
                "ffmpeg not found — install ffmpeg to build the OGG stem."
            ) from e
        except subprocess.CalledProcessError as e:
            last_err = e
    raise RuntimeError(
        "ffmpeg failed to encode stems/full.ogg — tried libvorbis and vorbis encoders."
    ) from last_err


def build(output_zip: Path) -> dict:
    manifest, drum_tab, end_t, count_in_s = build_chart()

    staging = output_zip.parent / "_diag_basic_drums_staging"
    if staging.exists():
        shutil.rmtree(staging)
    staging.mkdir(parents=True)
    (staging / "stems").mkdir()

    (staging / "manifest.yaml").write_text(
        dump_manifest_yaml(manifest),
        encoding="utf-8",
    )
    (staging / "drum_tab.json").write_text(
        json.dumps(drum_tab, separators=(",", ":")),
        encoding="utf-8",
    )

    wav_path = staging / "stems" / "full.wav"
    write_beat_wav(wav_path, end_t, count_in_s)
    ogg_path = staging / "stems" / "full.ogg"
    try:
        _encode_ogg(wav_path, ogg_path)
    except Exception:
        shutil.rmtree(staging, ignore_errors=True)
        raise
    wav_path.unlink()

    _build_zip(staging, output_zip)
    shutil.rmtree(staging, ignore_errors=True)

    pieces = sorted({h["p"] for h in drum_tab["hits"]})
    return {
        "output": output_zip,
        "duration_s": end_t,
        "hits": len(drum_tab["hits"]),
        "pieces": pieces,
        "stem": "stems/full.ogg",
        "size_bytes": output_zip.stat().st_size,
    }


def main():
    repo_root = Path(__file__).resolve().parents[2]
    default_out = Path(__file__).resolve().parent / "feedBack-diagnostic-basic-drums.feedpak"
    out = Path(sys.argv[1]) if len(sys.argv) > 1 else default_out
    if not out.is_absolute():
        out = repo_root / out

    stats = build(out)
    print(f'Built {stats["output"]}')
    print(f'  Duration:  {stats["duration_s"]:.1f} s')
    print(f'  Hits:      {stats["hits"]}')
    print(f'  Pieces:    {", ".join(stats["pieces"])}')
    print(f'  Stem:      {stats["stem"]}')
    print(f'  Size:      {stats["size_bytes"]} bytes')


if __name__ == "__main__":
    main()
