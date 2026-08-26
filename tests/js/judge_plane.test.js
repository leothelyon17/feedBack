'use strict';

// INIT-006/SPEC-002: named judge plane vs render plane, A/V independence.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..', '..');
const HIGHWAY_JS = path.join(ROOT, 'static', 'highway.js');
const TAP_JS = path.join(ROOT, 'static', 'js', 'tap-to-beat.js');
const TAP_SRC = fs.readFileSync(TAP_JS, 'utf8');
const HIGHWAY_SRC = fs.readFileSync(HIGHWAY_JS, 'utf8');

const HIT_WINDOW_MS = 50;

function extractBlock(src, signature) {
    const start = src.indexOf(signature);
    assert.ok(start !== -1, `signature '${signature}' not found`);
    const openBrace = src.indexOf('{', start);
    assert.ok(openBrace !== -1, `opening brace after '${signature}' not found`);
    let depth = 1;
    let i = openBrace + 1;
    while (i < src.length && depth > 0) {
        const ch = src[i];
        if (ch === '{') depth += 1;
        else if (ch === '}') depth -= 1;
        i += 1;
    }
    assert.ok(depth === 0, `unbalanced braces after '${signature}'`);
    return src.slice(start, i);
}

function cleanup(s) {
    return s.replace(/,?\s*$/, '');
}

function buildClockSandbox(perfNowImpl) {
    const hwState = {
        chartTime: 0,
        currentTime: 0,
        avOffsetSec: 0,
        songOffset: 0,
        _chartAnchorAudioT: NaN,
        _chartAnchorPerfNow: NaN,
        _chartLastAdvanceAt: 0,
        _chartObservedRate: 1,
    };
    const sandbox = {
        hwState,
        _CHART_MAX_INTERP_MS: 100,
        performance: { now: perfNowImpl },
    };
    vm.createContext(sandbox);
    vm.runInContext(`
        globalThis.setTime = function ${cleanup(extractBlock(HIGHWAY_SRC, 'setTime(t) {'))};
        globalThis.getTime = function ${cleanup(extractBlock(HIGHWAY_SRC, 'getTime() {'))};
        globalThis.setAvOffset = function ${cleanup(extractBlock(HIGHWAY_SRC, 'setAvOffset(ms) {'))};
        globalThis.getJudgeTime = function ${cleanup(extractBlock(HIGHWAY_SRC, 'getJudgeTime() {'))};
    `, sandbox);
    return sandbox;
}

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

function drumVerdict(hitT, noteT) {
    const errMs = (hitT - noteT) * 1000;
    return {
        hit: Math.abs(errMs) <= HIT_WINDOW_MS,
        sign: Math.sign(errMs) || 0,
        errMs,
    };
}

test('getJudgeTime is a named alias of getTime and does not add avOffsetSec', () => {
    const body = extractBlock(HIGHWAY_SRC, 'getJudgeTime() {');
    assert.match(body, /this\.getTime\s*\(/);
    assert.doesNotMatch(body, /avOffsetSec|currentTime/);
    assert.match(HIGHWAY_SRC, /getJudgeTime\(\)\s*\{\s*return this\.getTime\(\);\s*\}/);
});

test('ac-1: currentTime is getJudgeTime plus avOffsetSec; getJudgeTime stays chart-aligned', () => {
    let now = 1000;
    const sb = buildClockSandbox(() => now);
    sb.setTime(10);
    now = 1000;
    const judge0 = sb.getJudgeTime();
    const time0 = sb.getTime();
    assert.equal(judge0, time0);
    assert.equal(sb.hwState.currentTime, judge0);

    sb.setAvOffset(80);
    const judge1 = sb.getJudgeTime();
    assert.equal(judge1, judge0, 'A/V offset must not move the judge plane');
    assert.equal(sb.getTime(), judge0);
    assert.equal(sb.hwState.currentTime, judge1 + 0.080);
    assert.notEqual(sb.hwState.currentTime, judge1, 'gem draw time (currentTime) must move');
});

test('ac-2: non-zero av offset moves gem draw time and leaves a MIDI drum verdict unchanged', () => {
    const api = loadTap(() => 2000);
    let now = 1000;
    const sb = buildClockSandbox(() => now);
    sb.setTime(10);
    now = 1000;
    const noteT = 10;
    const midiStamp = 1980;
    const perfNow = 2000;

    const convertJudge = (getTimeFn) => api.convert(midiStamp, {
        now: perfNow,
        getTime: getTimeFn,
        bundle: { currentTime: sb.hwState.currentTime },
    });

    const before = convertJudge(() => sb.getJudgeTime());
    const verdictBefore = drumVerdict(before.tChart, noteT);
    const drawBefore = sb.hwState.currentTime;

    sb.setAvOffset(80);
    const after = convertJudge(() => sb.getJudgeTime());
    const verdictAfter = drumVerdict(after.tChart, noteT);
    const drawAfter = sb.hwState.currentTime;

    assert.equal(after.tChart, before.tChart);
    assert.equal(verdictAfter.hit, verdictBefore.hit);
    assert.equal(verdictAfter.sign, verdictBefore.sign);
    assert.equal(verdictBefore.hit, true);
    assert.equal(verdictBefore.sign, -1);
    assert.equal(drawBefore, 10);
    assert.equal(drawAfter, 10.080);
    assert.notEqual(drawAfter, drawBefore);
});

test('ac-2 identity: scoring on bundle.currentTime would change the drum verdict', () => {
    const api = loadTap(() => 2000);
    let now = 1000;
    const sb = buildClockSandbox(() => now);
    sb.setTime(10);
    now = 1000;
    sb.setAvOffset(80);
    const noteT = 10;
    const midiStamp = 1980;
    const perfNow = 2000;

    const correct = api.convert(midiStamp, {
        now: perfNow,
        getTime: () => sb.getJudgeTime(),
        bundle: { currentTime: sb.hwState.currentTime },
    });
    const wrong = api.convert(midiStamp, {
        now: perfNow,
        getTime: () => sb.hwState.currentTime,
        bundle: { currentTime: sb.hwState.currentTime },
    });

    const ok = drumVerdict(correct.tChart, noteT);
    const bad = drumVerdict(wrong.tChart, noteT);
    assert.equal(ok.hit, true);
    assert.equal(ok.sign, -1);
    assert.equal(bad.hit, false);
    assert.equal(bad.sign, 1);
    assert.notEqual(wrong.tChart, correct.tChart);
});
