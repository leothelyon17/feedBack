// INIT-004/SPEC-001: instrument-agnostic tap-to-beat math.
//
// Maps a MIDI DOM timeStamp onto highway.getTime() (heard/scoring clock, not
// the visual A/V plane), finds the nearest metronome-grid click, and reduces
// a held-out session. Applying a drum offset is a subtract-once helper — it
// must not seek audio or write the visual offset.
(function () {
    'use strict';

    window.feedBack = window.feedBack || {};
    if (window.feedBack.tapToBeat && window.feedBack.tapToBeat.version === 1) return;

    const N_MIN = 16;
    const N_VERIFY = 8;
    const GATE_MS = 12;
    const MAD_SOFT = 18;
    const MAD_HARD = 25;
    const OFFSET_MAX_MS = 250;
    const OUTLIER_ABS_MS = 150;
    const OUTLIER_MAD_K = 3;
    // Cap: estimation + held-out plus a short overrun so a long ritual cannot grow forever.
    const SESSION_HARD_MAX = N_MIN + N_VERIFY + 16;

    function _finite(n, fallback) {
        const v = Number(n);
        return Number.isFinite(v) ? v : fallback;
    }

    function _median(values) {
        if (!values.length) return 0;
        const sorted = values.slice().sort((a, b) => a - b);
        const mid = Math.floor(sorted.length / 2);
        if (sorted.length % 2) return sorted[mid];
        return (sorted[mid - 1] + sorted[mid]) / 2;
    }

    function _mad(values) {
        const med = _median(values);
        return _median(values.map((v) => Math.abs(v - med)));
    }

    function _chartTime(getTimeFn) {
        if (typeof getTimeFn === 'function') {
            const t = Number(getTimeFn());
            return Number.isFinite(t) ? t : 0;
        }
        const hw = window.highway;
        if (hw && typeof hw.getTime === 'function') {
            const t = Number(hw.getTime());
            return Number.isFinite(t) ? t : 0;
        }
        return 0;
    }

    function _nowMs(explicit) {
        if (explicit != null) {
            const n = Number(explicit);
            if (Number.isFinite(n)) return n;
        }
        if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
            const n = Number(performance.now());
            if (Number.isFinite(n)) return n;
        }
        return 0;
    }

    // tChart = getTime() + (midiTimeStamp - now) / 1000. Missing/0/non-finite
    // stamps fall back to `now` (delta 0) and flag low-confidence so NaN never
    // enters the chart clock.
    function convert(midiTimeStamp, opts) {
        const options = opts && typeof opts === 'object' ? opts : {};
        const now = _nowMs(options.now);
        const chartT = _chartTime(options.getTime);
        let ts = Number(midiTimeStamp);
        let lowConfidence = false;
        if (!Number.isFinite(ts) || ts === 0) {
            ts = now;
            lowConfidence = true;
        }
        const tChart = chartT + (ts - now) / 1000;
        if (!Number.isFinite(tChart)) {
            return { tChart: chartT, lowConfidence: true };
        }
        return { tChart: tChart, lowConfidence: lowConfidence };
    }

    function nearestBeat(tChart, grid) {
        const t = Number(tChart);
        const originT = _finite(grid && grid.originT, 0);
        const bpm = Number(grid && grid.bpm);
        let period = Number.isFinite(bpm) && bpm > 0 ? 60 / bpm : Number(grid && grid.periodSec);
        if (!Number.isFinite(t) || !Number.isFinite(period) || period <= 0) {
            return { beatT: originT, residualMs: 0, beatIndex: 0 };
        }
        const beatIndex = Math.round((t - originT) / period);
        const beatT = originT + beatIndex * period;
        return { beatT: beatT, residualMs: (t - beatT) * 1000, beatIndex: beatIndex };
    }

    // Subtract the device offset once. Never seeks; never writes A/V.
    function effectiveT(tChart, offsetMs) {
        const t = Number(tChart);
        if (!Number.isFinite(t)) return 0;
        const off = Number(offsetMs);
        const safeOff = Number.isFinite(off) ? off : 0;
        return t - (safeOff / 1000);
    }

    function createSession() {
        return { taps: [] };
    }

    function addTap(session, tap) {
        if (!session || !Array.isArray(session.taps)) return session;
        const residualMs = Number(tap && tap.residualMs);
        if (!Number.isFinite(residualMs)) return session;
        if (session.taps.length >= SESSION_HARD_MAX) return session;
        session.taps.push({
            residualMs: residualMs,
            tChart: _finite(tap && tap.tChart, 0),
            beatT: _finite(tap && tap.beatT, 0),
        });
        return session;
    }

    function recordTap(session, tChart, grid) {
        const hit = nearestBeat(tChart, grid);
        return addTap(session, {
            residualMs: hit.residualMs,
            tChart: tChart,
            beatT: hit.beatT,
        });
    }

    function _isBimodal(values) {
        if (values.length < 8) return false;
        const sorted = values.slice().sort((a, b) => a - b);
        let maxGap = 0;
        let gapAt = -1;
        for (let i = 1; i < sorted.length; i += 1) {
            const gap = sorted[i] - sorted[i - 1];
            if (gap > maxGap) {
                maxGap = gap;
                gapAt = i;
            }
        }
        const left = sorted.slice(0, gapAt);
        const right = sorted.slice(gapAt);
        if (left.length < 3 || right.length < 3) return false;
        const spread = Math.abs(_median(right) - _median(left));
        return spread > 40 && maxGap > 25;
    }

    function reduceSession(session) {
        const taps = session && Array.isArray(session.taps) ? session.taps : [];
        const residuals = taps.map((t) => t.residualMs).filter((v) => Number.isFinite(v));
        if (residuals.length < N_MIN) {
            return { ok: false, code: 'fail_n', n: residuals.length };
        }

        const rawMedian = _median(residuals);
        if (Math.abs(rawMedian) > OFFSET_MAX_MS) {
            return { ok: false, code: 'fail_range', offsetMs: rawMedian, n: residuals.length };
        }

        const rawMad = _mad(residuals);
        const kept = residuals.filter((e) => {
            if (Math.abs(e) > OUTLIER_ABS_MS) return false;
            if (rawMad > 0 && Math.abs(e - rawMedian) > OUTLIER_MAD_K * rawMad) return false;
            return true;
        });
        if (kept.length < N_MIN) {
            return { ok: false, code: 'fail_n', n: kept.length };
        }

        if (_isBimodal(kept)) {
            return { ok: false, code: 'fail_bimodal', n: kept.length };
        }

        const heldOut = kept.slice(-N_VERIFY);
        const estimation = kept.slice(0, kept.length - N_VERIFY);
        if (estimation.length < (N_MIN - N_VERIFY)) {
            return { ok: false, code: 'fail_n', n: kept.length };
        }

        const offsetMs = _median(estimation);
        if (Math.abs(offsetMs) > OFFSET_MAX_MS) {
            return { ok: false, code: 'fail_range', offsetMs: offsetMs, n: kept.length };
        }

        const estMad = _mad(estimation);
        if (estMad > MAD_SOFT || estMad > MAD_HARD) {
            return { ok: false, code: 'fail_mad', mad: estMad, offsetMs: offsetMs, n: kept.length };
        }

        const heldAbs = heldOut.map((e) => Math.abs(e - offsetMs));
        const heldMed = _median(heldAbs);
        if (heldMed > GATE_MS) {
            return { ok: false, code: 'fail_verify', gateMs: heldMed, offsetMs: offsetMs, n: kept.length };
        }

        return {
            ok: true,
            offsetMs: offsetMs,
            mad: estMad,
            n: kept.length,
            heldOutMedianAbs: heldMed,
        };
    }

    const api = {
        version: 1,
        N_MIN: N_MIN,
        N_VERIFY: N_VERIFY,
        GATE_MS: GATE_MS,
        MAD_SOFT: MAD_SOFT,
        MAD_HARD: MAD_HARD,
        OFFSET_MAX_MS: OFFSET_MAX_MS,
        OUTLIER_ABS_MS: OUTLIER_ABS_MS,
        OUTLIER_MAD_K: OUTLIER_MAD_K,
        SESSION_HARD_MAX: SESSION_HARD_MAX,
        convert: convert,
        nearestBeat: nearestBeat,
        effectiveT: effectiveT,
        session: {
            create: createSession,
            add: addTap,
            record: recordTap,
            reduce: reduceSession,
        },
    };

    window.feedBack.tapToBeat = api;
    if (window.slopsmith && window.slopsmith !== window.feedBack) {
        window.slopsmith.tapToBeat = api;
    }
    if (window.feedback && window.feedback !== window.feedBack) {
        window.feedback.tapToBeat = api;
    }
})();
