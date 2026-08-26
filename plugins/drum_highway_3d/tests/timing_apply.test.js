'use strict';
// INIT-004/SPEC-005: 3D hit judge uses MIDI timeStamp → getTime → effective_t.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SCREEN_JS = path.join(__dirname, '..', 'screen.js');
const SCREEN_SRC = fs.readFileSync(SCREEN_JS, 'utf8');

function load(extras) {
    const window = {
        console,
        location: { protocol: 'http:', host: 'localhost' },
        slopsmith: {},
        feedBack: {},
        performance: { now: () => 1000 },
        highway: {
            getTime: () => 0,
            getAvOffset: () => 0,
            setAvOffset() { throw new Error('setAvOffset must not be called'); },
        },
    };
    if (extras) Object.assign(window, extras);
    window.window = window;
    window.globalThis = window;
    const context = vm.createContext(window);
    vm.runInContext(SCREEN_SRC, context, { filename: 'screen.js' });
    return {
        window,
        __test: window.slopsmithViz_drum_highway_3d.__test,
        factory: window.slopsmithViz_drum_highway_3d,
    };
}

function snareNotes(t) {
    return [{ t: t == null ? 1.0 : t, lane: 1 }];
}

function mockTap() {
    return {
        convert(midiTimeStamp, opts) {
            const now = Number(opts && opts.now);
            const chartT = Number(typeof (opts && opts.getTime) === 'function' ? opts.getTime() : 0);
            const base = Number.isFinite(chartT) ? chartT : 0;
            let ts = Number(midiTimeStamp);
            let lowConfidence = false;
            if (!Number.isFinite(ts) || ts === 0) {
                ts = now;
                lowConfidence = true;
            }
            const tChart = base + (ts - now) / 1000;
            return {
                tChart: Number.isFinite(tChart) ? tChart : base,
                lowConfidence,
            };
        },
        effectiveT(tChart, offsetMs) {
            const t = Number(tChart);
            if (!Number.isFinite(t)) return 0;
            const off = Number(offsetMs);
            const safeOff = Number.isFinite(off) ? off : 0;
            return t - safeOff / 1000;
        },
    };
}

test('ac-1: hit judge uses MIDI timeStamp → getTime → effective_t, not currentTime', () => {
    assert.match(SCREEN_SRC, /_judgeDrumHit/);
    assert.match(SCREEN_SRC, /_judgeTimeFromMidi/);
    assert.doesNotMatch(SCREEN_SRC, /const t = _latestTime/);
    const handle = SCREEN_SRC.match(/function _handleDrumHit\([\s\S]*?\n        function _updateMissed/);
    assert.ok(handle, '_handleDrumHit source not found');
    assert.match(handle[0], /_judgeDrumHit/);
    assert.doesNotMatch(handle[0], /bundle\.currentTime/);
    assert.doesNotMatch(handle[0], /_latestTime/);

    const { __test } = load();
    const hit = __test._judgeDrumHit(38, 1000, {
        notes: snareNotes(1.0),
        hitKeys: new Set(),
        getTime: () => 1.0,
        now: 1000,
        offsetMs: 0,
        currentTime: 99,
    });
    assert.equal(hit.kind, 'hit');
    assert.equal(hit.t, 1.0);
});

test('ac-1: discarded timeStamp vs consumed timeStamp disagree when A/V is non-zero', () => {
    const { __test } = load();
    const tChart = 5;
    const avMs = 80;
    const currentTime = tChart + avMs / 1000;
    const consumed = __test._judgeTimeFromMidi(2000, {
        getTime: () => tChart,
        now: 2000,
        offsetMs: 0,
    });
    assert.notEqual(currentTime, consumed);
    assert.equal(consumed, tChart);
});

test('ac-2: absent feedBack.drumTiming ⇒ offset 0; no throw', () => {
    const { window, __test } = load();
    delete window.feedBack.drumTiming;
    assert.equal(__test._readDrumOffsetMs(), 0);
    assert.doesNotThrow(() => __test._judgeTimeFromMidi(100, { getTime: () => 1, now: 100 }));
    window.feedBack.drumTiming = {
        getOffsetMs() { throw new Error('boom'); },
    };
    assert.equal(__test._readDrumOffsetMs(), 0);
    window.feedBack.drumTiming = {};
    assert.equal(__test._readDrumOffsetMs(), 0);
    window.feedBack.drumTiming = {
        getOffsetMs() { return Number.NaN; },
    };
    assert.equal(__test._readDrumOffsetMs(), 0);
});

test('ac-3: never writes av_offset_ms / never calls setAvOffset', () => {
    assert.doesNotMatch(SCREEN_SRC, /setAvOffset\s*\(/);
    assert.doesNotMatch(SCREEN_SRC, /av_offset_ms/);
});

test('ac-4: HIT_TOLERANCE_S remains 0.05', () => {
    const { __test } = load();
    assert.equal(__test.HIT_TOLERANCE_S, 0.05);
    assert.match(SCREEN_SRC, /const HIT_TOLERANCE_S = 0\.05/);
    assert.doesNotMatch(SCREEN_SRC, /HIT_TOLERANCE_S\s*=\s*0\.(?!05)\d/);
});

test('ac-5: finite drum offset does not change getAvOffset() / getTime()', () => {
    let chart = 5;
    let avMs = 80;
    const { window, __test } = load({
        highway: {
            getTime() { return chart; },
            getAvOffset() { return avMs; },
            setAvOffset(ms) { avMs = Number(ms); },
        },
    });
    const before = window.highway.getTime();
    const av = window.highway.getAvOffset();
    __test._judgeTimeFromMidi(100, {
        getTime: () => window.highway.getTime(),
        now: 100,
        offsetMs: 40,
    });
    __test._applyDrumOffsetSec(before + 0.08, 40);
    assert.equal(window.highway.getTime(), before);
    assert.equal(window.highway.getAvOffset(), av);
    assert.equal(chart, 5);
    assert.equal(avMs, 80);
});

test('ac-6: guitar highway_3d is not imported from this plugin', () => {
    assert.doesNotMatch(SCREEN_SRC, /(?:import|require)\s*\(?['"][^'"]*highway_3d/);
    assert.doesNotMatch(SCREEN_SRC, /feedBackViz_highway_3d/);
});

test('uses tapToBeat.convert + effectiveT when present', () => {
    const { window, __test } = load();
    const calls = [];
    window.feedBack.tapToBeat = {
        convert(ts, opts) {
            calls.push(['convert', ts, opts.now]);
            return { tChart: 7, lowConfidence: false };
        },
        effectiveT(tChart, offsetMs) {
            calls.push(['effectiveT', tChart, offsetMs]);
            return tChart - offsetMs / 1000;
        },
    };
    const t = __test._judgeTimeFromMidi(123, { getTime: () => 99, now: 50, offsetMs: 40 });
    assert.equal(t, 6.96);
    assert.equal(calls[0][0], 'convert');
    assert.equal(calls[1][0], 'effectiveT');
});

test('fallback math when tapToBeat is missing matches SPEC-001 convert', () => {
    const { window, __test } = load();
    assert.equal(window.feedBack.tapToBeat, undefined);
    const t = __test._judgeTimeFromMidi(1500, { getTime: () => 10, now: 2000, offsetMs: 0 });
    assert.equal(t, 10 + (1500 - 2000) / 1000);
});

test('timeStamp missing/0 falls back like SPEC-001 (low-confidence now)', () => {
    const { window, __test } = load();
    const opts = { getTime: () => 3, now: 5000, offsetMs: 0 };
    assert.equal(__test._judgeTimeFromMidi(0, opts), 3);
    assert.equal(__test._judgeTimeFromMidi(undefined, opts), 3);
    assert.equal(__test._judgeTimeFromMidi(Number.NaN, opts), 3);
    window.feedBack.tapToBeat = mockTap();
    assert.equal(__test._judgeTimeFromMidi(0, opts), 3);
});

test('non-finite judge time skips the hit', () => {
    const { window, __test } = load();
    window.feedBack.tapToBeat = {
        convert() { return { tChart: Number.NaN }; },
        effectiveT() { return Number.NaN; },
    };
    const skipT = __test._judgeDrumHit(38, 1, {
        notes: snareNotes(1),
        hitKeys: new Set(),
        getTime: () => 1,
        now: 1,
        offsetMs: 0,
    });
    assert.equal(skipT.kind, 'skip');
    assert.equal(skipT.reason, 'non-finite-t');

    delete window.feedBack.tapToBeat;
    const skipEmpty = __test._judgeDrumHit(38, 1, {
        notes: [],
        hitKeys: new Set(),
        getTime: () => 1,
        now: 1,
    });
    assert.equal(skipEmpty.kind, 'skip');
    assert.equal(skipEmpty.reason, 'empty-chart');
});

test('offset 0 is bit-identical to getTime when the stamp maps cleanly', () => {
    const { __test } = load();
    const tChart = 3.5;
    assert.equal(__test._judgeTimeFromMidi(100, { getTime: () => tChart, now: 100, offsetMs: 0 }), tChart);
});

test('late pad becomes a hit after a positive offset', () => {
    const { __test } = load();
    const notes = snareNotes(1.0);
    const late = {
        notes,
        hitKeys: new Set(),
        getTime: () => 1.08,
        now: 1080,
        midiTimeStamp: 1080,
    };
    assert.equal(__test._judgeDrumHit(38, 1080, { ...late, offsetMs: 0 }).kind, 'miss');
    assert.equal(__test._judgeDrumHit(38, 1080, { ...late, offsetMs: 80 }).kind, 'hit');
});

test('midi payload forwards timeStamp; raw bytes still wrap', () => {
    const { __test } = load();
    const payload = __test._midiPayloadToEvent({ data: [0x90, 38, 100], timeStamp: 1234 });
    assert.deepEqual(Array.from(payload.data), [0x90, 38, 100]);
    assert.equal(payload.timeStamp, 1234);
    const raw = __test._midiPayloadToEvent([0x90, 36, 80]);
    assert.deepEqual(Array.from(raw.data), [0x90, 36, 80]);
    assert.equal(raw.timeStamp, 0);
});

test('_midiOnMessage forwards timeStamp onto the active instance', () => {
    const { __test } = load();
    const hits = [];
    __test._setActiveInstance({
        _handleDrumHit(note, vel, ts) { hits.push([note, vel, ts]); },
    });
    __test._midiOnMessage({ data: [0x90, 38, 100], timeStamp: 2500 });
    assert.deepEqual(hits, [[38, 100, 2500]]);
});

test('convert throw and effectiveT throw skip as non-finite', () => {
    const { window, __test } = load();
    window.feedBack.tapToBeat = {
        convert() { throw new Error('convert'); },
        effectiveT() { return 1; },
    };
    assert.ok(Number.isNaN(__test._judgeTimeFromMidi(1, { getTime: () => 1, now: 1, offsetMs: 0 })));
    window.feedBack.tapToBeat = {
        convert() { return { tChart: 1 }; },
        effectiveT() { throw new Error('effective'); },
    };
    assert.ok(Number.isNaN(__test._judgeTimeFromMidi(1, { getTime: () => 1, now: 1, offsetMs: 0 })));
});

test('non-finite offsetMs argument is treated as 0', () => {
    const { __test } = load();
    assert.equal(__test._judgeTimeFromMidi(100, { getTime: () => 4, now: 100, offsetMs: Number.NaN }), 4);
});

test('unmapped MIDI skips without consuming a chart note', () => {
    const { __test } = load();
    const hitKeys = new Set();
    const skip = __test._judgeDrumHit(1, 1000, {
        notes: snareNotes(1.0),
        hitKeys,
        getTime: () => 1.0,
        now: 1000,
        offsetMs: 0,
    });
    assert.equal(skip.kind, 'skip');
    assert.equal(skip.reason, 'unmapped');
    assert.equal(hitKeys.size, 0);
});

test('already-hit note is a miss on a second strike in the same window', () => {
    const { __test } = load();
    const notes = snareNotes(1.0);
    const hitKeys = new Set();
    const first = __test._judgeDrumHit(38, 1000, {
        notes, hitKeys, getTime: () => 1.0, now: 1000, offsetMs: 0,
    });
    assert.equal(first.kind, 'hit');
    const second = __test._judgeDrumHit(38, 1000, {
        notes, hitKeys, getTime: () => 1.0, now: 1000, offsetMs: 0,
    });
    assert.equal(second.kind, 'miss');
});

test('_applyDrumOffsetSec returns NaN for non-finite clock', () => {
    const { __test } = load();
    assert.ok(Number.isNaN(__test._applyDrumOffsetSec(Number.NaN, 40)));
    assert.equal(__test._applyDrumOffsetSec(2, 40), 1.96);
    assert.equal(__test._applyDrumOffsetSec(2, Number.NaN), 2);
});

test('_highwayGetTime degrades to 0 when highway is missing', () => {
    const { window, __test } = load();
    delete window.highway;
    assert.equal(__test._highwayGetTime(), 0);
    window.highway = {
        getTime() { throw new Error('boom'); },
    };
    assert.equal(__test._highwayGetTime(), 0);
    window.highway = { getTime() { return Number.NaN; } };
    assert.equal(__test._highwayGetTime(), 0);
    window.highway = { getTime() { return 2.5; } };
    assert.equal(__test._highwayGetTime(), 2.5);
});

test('_nowMs prefers performance.now when finite', () => {
    const { window, __test } = load({ performance: { now: () => 42 } });
    assert.equal(__test._nowMs(), 42);
    window.performance.now = () => Number.NaN;
    assert.equal(__test._nowMs(), 0);
});

test('null snapshot skips as empty-chart', () => {
    const { __test } = load();
    const empty = __test._judgeDrumHit(38, 1, null);
    assert.equal(empty.kind, 'skip');
    assert.equal(empty.reason, 'empty-chart');
});

test('finite getOffsetMs is consumed; missing feedBack is 0', () => {
    const { window, __test } = load();
    window.feedBack.drumTiming = { getOffsetMs() { return 22; } };
    assert.equal(__test._readDrumOffsetMs(), 22);
    delete window.feedBack;
    assert.equal(__test._readDrumOffsetMs(), 0);
});

test('_judgeTimeFromMidi degrades when opts/getTime/now omitted', () => {
    const { window, __test } = load({
        highway: { getTime() { return 4; } },
        performance: { now: () => 100 },
    });
    window.feedBack.drumTiming = { getOffsetMs() { return 0; } };
    assert.equal(__test._judgeTimeFromMidi(100), 4);
    window.highway = {};
    assert.equal(__test._highwayGetTime(), 0);
});

test('tap.convert without effectiveT subtracts offset locally', () => {
    const { window, __test } = load();
    window.feedBack.tapToBeat = {
        convert() { return { tChart: 8 }; },
    };
    assert.equal(__test._judgeTimeFromMidi(1, { getTime: () => 1, now: 1, offsetMs: 40 }), 7.96);
});

test('convert returning no tChart is non-finite and skips', () => {
    const { window, __test } = load();
    window.feedBack.tapToBeat = {
        convert() { return null; },
        effectiveT() { return 1; },
    };
    assert.ok(Number.isNaN(__test._judgeTimeFromMidi(1, { getTime: () => 1, now: 1, offsetMs: 0 })));
});

test('effectiveT returning NaN after finite tChart skips', () => {
    const { window, __test } = load();
    window.feedBack.tapToBeat = {
        convert() { return { tChart: 1 }; },
        effectiveT() { return Number.NaN; },
    };
    assert.ok(Number.isNaN(__test._judgeTimeFromMidi(1, { getTime: () => 1, now: 1, offsetMs: 0 })));
});

test('_convertMidiFallback covers missing getTime and non-finite chart time', () => {
    const { __test } = load();
    assert.equal(__test._convertMidiFallback(100, null, 100), 0);
    assert.equal(__test._convertMidiFallback(100, () => Number.NaN, 100), 0);
    assert.equal(__test._convertMidiFallback(Number.POSITIVE_INFINITY, () => 3, Number.POSITIVE_INFINITY), 3);
});

test('_nowMs is 0 when performance.now is missing', () => {
    const { window, __test } = load({ performance: {} });
    assert.equal(__test._nowMs(), 0);
    delete window.performance;
    assert.equal(__test._nowMs(), 0);
});

test('chart notes outside the window or on another lane miss', () => {
    const { __test } = load();
    const missEarly = __test._judgeDrumHit(38, 1000, {
        notes: [{ t: 0.9, lane: 1 }],
        hitKeys: new Set(),
        getTime: () => 1.0,
        now: 1000,
        offsetMs: 0,
    });
    assert.equal(missEarly.kind, 'miss');
    const missLane = __test._judgeDrumHit(38, 1000, {
        notes: [{ t: 1.0, lane: 0 }],
        hitKeys: new Set(),
        getTime: () => 1.0,
        now: 1000,
        offsetMs: 0,
    });
    assert.equal(missLane.kind, 'miss');
    const missLate = __test._judgeDrumHit(38, 1000, {
        notes: [{ t: 1.2, lane: 1 }],
        hitKeys: new Set(),
        getTime: () => 1.0,
        now: 1000,
        offsetMs: 0,
    });
    assert.equal(missLate.kind, 'miss');
});

test('snap.piece overrides MIDI lookup; missing hitKeys still hits', () => {
    const { __test } = load();
    const hit = __test._judgeDrumHit(1, 1000, {
        notes: [{ t: 1.0, lane: 1 }],
        piece: 'snare',
        getTime: () => 1.0,
        now: 1000,
        offsetMs: 0,
    });
    assert.equal(hit.kind, 'hit');
});

test('_midiPayloadToEvent wraps null/undefined as timeStamp 0', () => {
    const { __test } = load();
    assert.equal(__test._midiPayloadToEvent(null).timeStamp, 0);
    assert.equal(__test._midiPayloadToEvent(undefined).data, undefined);
});

test('device input.hit_detection hydrates 3D scoring gate', async () => {
    const { window, __test } = load();
    window.feedBack.midiDevices = {
        version: 1,
        get: async (id) => ({
            id,
            notes: { 38: 'snare' },
            input: { hit_detection: true, midi_channel: 9, synth_volume: 0.4 },
        }),
    };
    window.feedBack.drumInput = {
        update() { return { revision: { clock: 1, origin: 't', sequence: 1 } }; },
        get() { return { hitDetection: false }; },
    };
    assert.equal(__test._inputSettings.hitDetection, false);
    const res = await __test._refetchDeviceNotes('dev-1');
    assert.equal(res.ok, true);
    assert.equal(__test._inputSettings.hitDetection, true);
    assert.equal(__test._inputSettings.midiChannel, 9);
});

test('3D HUD names scoring-off instead of silent 0/0', () => {
    assert.match(SCREEN_SRC, /Hit detection off/);
    assert.match(SCREEN_SRC, /_applyDeviceInput/);
    assert.match(SCREEN_SRC, /hit-detection-off/);
    assert.match(SCREEN_SRC, /empty-chart/);
});
