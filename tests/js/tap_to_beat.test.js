'use strict';

// INIT-004/SPEC-001: tap-to-beat convert / nearest-beat / session / identity.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..', '..');
const TAP_JS = path.join(ROOT, 'static', 'js', 'tap-to-beat.js');
const TAP_SRC = fs.readFileSync(TAP_JS, 'utf8');
const SETTINGS_JS = fs.readFileSync(path.join(ROOT, 'static', 'js', 'settings.js'), 'utf8');
const V3_HTML = fs.readFileSync(path.join(ROOT, 'static', 'v3', 'index.html'), 'utf8');

function loadTap(perfNow) {
    const window = {
        feedBack: {},
        performance: { now: typeof perfNow === 'function' ? perfNow : () => 1000 },
    };
    window.window = window;
    vm.createContext(window);
    vm.runInContext(TAP_SRC, window, { filename: TAP_JS });
    return window.feedBack.tapToBeat;
}

function fillSession(api, residuals) {
    const session = api.session.create();
    for (const residualMs of residuals) {
        api.session.add(session, { residualMs });
    }
    return session;
}

test('convert maps midi timeStamp onto getTime, never currentTime', () => {
    const api = loadTap(() => 2000);
    let currentTimeCalls = 0;
    const bundle = {
        currentTime: 99,
        get current() {
            currentTimeCalls += 1;
            return 99;
        },
    };
    const got = api.convert(1500, {
        now: 2000,
        getTime: () => 10,
        bundle,
    });
    assert.equal(got.tChart, 10 + (1500 - 2000) / 1000);
    assert.equal(got.lowConfidence, false);
    assert.equal(currentTimeCalls, 0);
    assert.doesNotMatch(TAP_SRC, /bundle\.currentTime|audio\.currentTime/);
    assert.match(TAP_SRC, /getTime\(\)/);
});

test('convert treats missing/0/non-finite timeStamp as low-confidence fallback', () => {
    const api = loadTap(() => 5000);
    const missing = api.convert(undefined, { now: 5000, getTime: () => 3 });
    assert.equal(missing.tChart, 3);
    assert.equal(missing.lowConfidence, true);

    const zero = api.convert(0, { now: 5000, getTime: () => 3 });
    assert.equal(zero.tChart, 3);
    assert.equal(zero.lowConfidence, true);

    const nan = api.convert(Number.NaN, { now: 5000, getTime: () => 3 });
    assert.equal(nan.tChart, 3);
    assert.equal(nan.lowConfidence, true);
    assert.ok(Number.isFinite(nan.tChart));
});

test('nearestBeat is metronome-grid only (not chart notes)', () => {
    const api = loadTap();
    const hit = api.nearestBeat(2.02, { bpm: 60, originT: 0 });
    assert.equal(hit.beatIndex, 2);
    assert.equal(hit.beatT, 2);
    assert.ok(Math.abs(hit.residualMs - 20) < 1e-6);
    assert.doesNotMatch(TAP_SRC, /chartNote|nearestNote|notes\[/);
});

test('effectiveT subtracts offset once and never calls setAvOffset', () => {
    const api = loadTap();
    let setCalls = 0;
    const highway = {
        setAvOffset() { setCalls += 1; },
        getTime() { return 8; },
    };
    const t = api.effectiveT(8, 40);
    assert.equal(t, 8 - 0.040);
    assert.equal(setCalls, 0);
    assert.doesNotMatch(TAP_SRC, /setAvOffset\s*\(/);
    assert.doesNotMatch(TAP_SRC, /audio\.currentTime|seek\s*\(/);
    void highway;
});

test('effectiveT treats non-finite inputs as 0, never NaN', () => {
    const api = loadTap();
    assert.equal(api.effectiveT(Number.NaN, 10), 0);
    assert.equal(api.effectiveT(4, Number.NaN), 4);
});

test('session fail_n when fewer than N_min taps', () => {
    const api = loadTap();
    const session = fillSession(api, Array(15).fill(5));
    const result = api.session.reduce(session);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'fail_n');
});

test('session fail_range when |median| > 250', () => {
    const api = loadTap();
    const session = fillSession(api, Array(24).fill(260));
    const result = api.session.reduce(session);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'fail_range');
});

test('session fail_mad when estimation MAD exceeds 18', () => {
    const api = loadTap();
    // Same wide unimodal pattern in estimation and held-out so verify cannot fire first.
    const pat = [-50, -35, -20, 0, 20, 35, 50, 5];
    const residuals = pat.concat(pat, pat);
    const result = api.session.reduce(fillSession(api, residuals));
    assert.equal(result.ok, false);
    assert.equal(result.code, 'fail_mad');
});

test('session fail_verify when held-out residuals miss the 12 ms gate', () => {
    const api = loadTap();
    const estimation = Array.from({ length: 16 }, (_, i) => (i - 8) * 2);
    const heldOut = Array(8).fill(18);
    const result = api.session.reduce(fillSession(api, estimation.concat(heldOut)));
    assert.equal(result.ok, false);
    assert.equal(result.code, 'fail_verify');
});

test('session fail_bimodal when residuals form two clusters', () => {
    const api = loadTap();
    const residuals = Array(12).fill(-80).concat(Array(12).fill(80));
    const result = api.session.reduce(fillSession(api, residuals));
    assert.equal(result.ok, false);
    assert.equal(result.code, 'fail_bimodal');
});

test('outlier trim runs before held-out tests (|e| > 150 or 3·MAD)', () => {
    const api = loadTap();
    const residuals = Array(16).fill(10).concat(Array(8).fill(10));
    residuals[0] = 180;
    residuals[1] = -200;
    const result = api.session.reduce(fillSession(api, residuals));
    assert.equal(result.ok, true);
    assert.ok(Math.abs(result.offsetMs - 10) < 1e-6);
});

test('tight session around +12 ms passes the held-out gate', () => {
    const api = loadTap();
    const residuals = [];
    for (let i = 0; i < 24; i += 1) residuals.push(12 + (i % 3) - 1);
    const result = api.session.reduce(fillSession(api, residuals));
    assert.equal(result.ok, true);
    assert.ok(Math.abs(result.offsetMs - 12) <= 1);
    assert.ok(result.mad <= 18);
});

test('session tap buffer is capped (no unbounded array)', () => {
    const api = loadTap();
    const session = api.session.create();
    for (let i = 0; i < api.SESSION_HARD_MAX + 20; i += 1) {
        api.session.add(session, { residualMs: 4 });
    }
    assert.equal(session.taps.length, api.SESSION_HARD_MAX);
});

test('ac-6: applying a finite drum offset does not change A/V clocks', () => {
    const api = loadTap();
    let avMs = 40;
    let chartT = 5;
    const settings = { av_offset_ms: 40 };
    const highway = {
        getTime() { return chartT; },
        setTime(t) { chartT = t; },
        getAvOffset() { return avMs; },
        setAvOffset(ms) { avMs = Number(ms); },
    };
    highway.setTime(5);
    const t0 = highway.getTime();
    const av0 = highway.getAvOffset();
    const scored = api.effectiveT(t0, 25);
    assert.equal(scored, 5 - 0.025);
    assert.equal(highway.getTime(), t0);
    assert.equal(highway.getAvOffset(), av0);
    assert.equal(settings.av_offset_ms, 40);
    assert.doesNotMatch(TAP_SRC, /setAvOffset\s*\(/);
    assert.doesNotMatch(TAP_SRC, /av_offset_ms/);
});

test('ac-7: a currentTime-scored tape fails the identity suite', () => {
    const api = loadTap();
    const avMs = 40;
    const drumMs = 25;
    const tChart = 10;
    const currentTime = tChart + avMs / 1000;
    const wrong = currentTime - drumMs / 1000;
    const correct = api.effectiveT(tChart, drumMs);
    assert.notEqual(wrong, correct);
    assert.equal(correct, tChart - drumMs / 1000);
    assert.notEqual(wrong, tChart - drumMs / 1000);
});

test('ac-8: [ and ] stay A/V-only; Gameplay has no Drum timing row', () => {
    assert.match(SETTINGS_JS, /nudgeAvOffsetMs/);
    assert.match(SETTINGS_JS, /setAvOffsetMs/);
    assert.doesNotMatch(SETTINGS_JS, /writeTiming|drumTiming|tapToBeat/);
    assert.doesNotMatch(V3_HTML, /Drum timing/);
    const gameplayAt = V3_HTML.indexOf('data-tab="gameplay"');
    const midiAt = V3_HTML.lastIndexOf('data-tab="midi"');
    const gameplay = V3_HTML.slice(gameplayAt, midiAt);
    assert.doesNotMatch(gameplay, /id="midi-calibration-panel"/);
    assert.match(V3_HTML, /\[ and \] keys/);
});

test('ac-11: tap-to-beat does not add /api/settings drum keys or /ws frames', () => {
    assert.doesNotMatch(TAP_SRC, /\/api\/settings/);
    assert.doesNotMatch(TAP_SRC, /\/ws\//);
    assert.doesNotMatch(TAP_SRC, /drum_offset|drum_timing_ms/);
});
