'use strict';

// INIT-006/SPEC-004: probe AudioContext for a seeded audio-latency hint.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..', '..');
const HINT_JS = path.join(ROOT, 'static', 'js', 'audio-latency-hint.js');
const HINT_SRC = fs.readFileSync(HINT_JS, 'utf8');
const MIDI_DEVICES_JS = fs.readFileSync(
    path.join(ROOT, 'static', 'capabilities', 'midi-devices.js'),
    'utf8',
);
const V3_HTML = fs.readFileSync(path.join(ROOT, 'static', 'v3', 'index.html'), 'utf8');

function loadHint(extras) {
    const window = Object.assign({
        feedBack: {},
        _juceMode: false,
        AudioContext: undefined,
        webkitAudioContext: undefined,
    }, extras || {});
    window.window = window;
    vm.createContext(window);
    vm.runInContext(HINT_SRC, window, { filename: HINT_JS });
    return window.feedBack.audioLatencyHint;
}

function mockAudioContext({ base, output, throwOnNew, closeImpl }) {
    let constructed = 0;
    const closes = [];
    function AudioContext() {
        constructed += 1;
        if (throwOnNew) throw new Error('AudioContext unavailable');
        if (base !== undefined) this.baseLatency = base;
        if (output !== undefined) this.outputLatency = output;
        this.close = closeImpl || function close() {
            closes.push(this);
            return Promise.resolve();
        };
    }
    AudioContext.constructed = () => constructed;
    AudioContext.closes = closes;
    return AudioContext;
}

test('ac-1: finite outputLatency shows base+output ms labeled estimate', () => {
    const api = loadHint();
    const Ctor = mockAudioContext({ base: 0.005, output: 0.012 });
    const result = api.probeWebAudio(Ctor);
    assert.equal(result.state, 'estimate');
    assert.equal(result.ms, 17);
    assert.match(result.text, /17 ms \(estimate\)/);
    assert.doesNotMatch(result.text, /NaN/i);
    assert.equal(Ctor.constructed(), 1);
    assert.equal(Ctor.closes.length, 1);
});

test('ac-1: either trusted term is enough (sum of available)', () => {
    const api = loadHint();
    const outputOnly = api.probeWebAudio(mockAudioContext({ output: 0.02 }));
    assert.equal(outputOnly.state, 'estimate');
    assert.equal(outputOnly.ms, 20);
    assert.match(outputOnly.text, /estimate/);

    const baseOnly = api.probeWebAudio(mockAudioContext({ base: 0.008 }));
    assert.equal(baseOnly.state, 'estimate');
    assert.equal(baseOnly.ms, 8);
});

test('ac-2: missing outputLatency and baseLatency → not-reported; no NaN', () => {
    const api = loadHint();
    const result = api.probeWebAudio(mockAudioContext({}));
    assert.equal(result.state, 'not-reported');
    assert.equal(result.ms, null);
    assert.equal(result.text, 'Not reported');
    assert.doesNotMatch(result.text, /NaN/i);
});

test('ac-2: missing constructor → not-reported', () => {
    const api = loadHint();
    const result = api.probeWebAudio(undefined);
    assert.equal(result.state, 'not-reported');
    assert.equal(result.text, 'Not reported');
});

test('ac-2: NaN and Infinity are not-reported; no silent 0-as-truth', () => {
    const api = loadHint();
    const nan = api.probeWebAudio(mockAudioContext({ base: Number.NaN, output: Number.NaN }));
    assert.equal(nan.state, 'not-reported');
    assert.doesNotMatch(nan.text, /NaN/i);

    const inf = api.probeWebAudio(mockAudioContext({
        base: Number.POSITIVE_INFINITY,
        output: Number.NEGATIVE_INFINITY,
    }));
    assert.equal(inf.state, 'not-reported');
    assert.doesNotMatch(inf.text, /NaN|Infinity/i);

    const zero = api.probeWebAudio(mockAudioContext({ base: 0, output: 0 }));
    assert.equal(zero.state, 'not-reported');
    assert.equal(zero.ms, null);
    assert.notEqual(zero.text, '0 ms (estimate)');
});

test('ac-2: constructor throw → not-reported and no leak', () => {
    const api = loadHint();
    const Ctor = mockAudioContext({ throwOnNew: true });
    const result = api.probeWebAudio(Ctor);
    assert.equal(result.state, 'not-reported');
    assert.equal(Ctor.constructed(), 1);
    assert.equal(Ctor.closes.length, 0);
});

test('ac-3: confirmHint writes audio_latency_hint_ms and leaves offset_ms unchanged', async () => {
    const api = loadHint();
    const writes = [];
    const midiDevices = {
        writeTiming(timing) {
            writes.push(timing);
            return Promise.resolve({ timing });
        },
        getActive() {
            return {
                id: 'living-room-ekit',
                timing: { offset_ms: 18, origin: 'localhost', audio_backend: 'html5' },
            };
        },
    };
    await api.confirmHint({ hintMs: 17, midiDevices });
    assert.equal(writes.length, 1);
    assert.equal(writes[0].offset_ms, 18);
    assert.equal(writes[0].audio_latency_hint_ms, 17);
    assert.equal(writes[0].origin, 'localhost');
    assert.equal(writes[0].audio_backend, 'html5');
    assert.equal(writes[0].offset_ms + writes[0].audio_latency_hint_ms !== writes[0].offset_ms, true);
    assert.equal(Object.prototype.hasOwnProperty.call(writes[0], 'av_offset_ms'), false);
});

test('ac-3: probe does not call writeTiming; override empty does not persist', async () => {
    const api = loadHint();
    let writes = 0;
    const midiDevices = {
        writeTiming() { writes += 1; },
        getActive() { return { timing: { offset_ms: 10, audio_backend: 'html5' } }; },
    };
    api.probeWebAudio(mockAudioContext({ base: 0.01, output: 0.01 }));
    assert.equal(writes, 0);
    await assert.rejects(
        () => api.confirmHint({ hintMs: Number.NaN, midiDevices }),
        /finite/,
    );
    assert.equal(writes, 0);
});

test('ac-3: confirm without existing offset_ms does not invent 0', async () => {
    const api = loadHint();
    const writes = [];
    const midiDevices = {
        writeTiming(timing) { writes.push(timing); },
        getActive() { return { id: 'kit', timing: {} }; },
    };
    await assert.rejects(
        () => api.confirmHint({ hintMs: 12, midiDevices }),
        /offset_ms/,
    );
    assert.equal(writes.length, 0);
});

test('JUCE backend does not report Web Audio outputLatency', () => {
    const Ctor = mockAudioContext({ base: 0.005, output: 0.04 });
    const api = loadHint({ _juceMode: true, AudioContext: Ctor });
    const result = api.probe({ window: { _juceMode: true, AudioContext: Ctor } });
    assert.equal(result.state, 'not-reported');
    assert.equal(result.source, 'juce');
    assert.equal(Ctor.constructed(), 0);
});

test('JUCE shows an existing device-latency ms field when present', () => {
    const api = loadHint();
    const result = api.probeJuce({ latencyMs: 8.4 });
    assert.equal(result.state, 'estimate');
    assert.equal(result.ms, 8);
    assert.match(result.text, /estimate/);
    assert.equal(api.probeJuce({ latencyMs: 0 }).state, 'not-reported');
    assert.equal(api.probeJuce({}).state, 'not-reported');
});

test('parseOverrideMs uses typed override; empty falls back to estimate only', () => {
    const api = loadHint();
    const estimate = { state: 'estimate', ms: 17 };
    assert.equal(api.parseOverrideMs('22', estimate), 22);
    assert.equal(api.parseOverrideMs('', estimate), 17);
    assert.equal(api.parseOverrideMs('', { state: 'not-reported', ms: null }), null);
    assert.equal(api.parseOverrideMs('NaN', estimate), null);
});

test('mount paints estimate and persists only on confirm click', async () => {
    const writes = [];
    const nodes = {};
    function makeNode(id, extras) {
        const node = Object.assign({
            id,
            textContent: '',
            value: '',
            listeners: {},
            addEventListener(type, fn) { this.listeners[type] = fn; },
        }, extras || {});
        nodes[id] = node;
        return node;
    }
    const panel = makeNode('midi-calibration-panel');
    makeNode('audio-latency-hint-probe');
    makeNode('audio-latency-hint-override', { value: '' });
    const confirm = makeNode('audio-latency-hint-confirm');
    makeNode('audio-latency-hint-status');
    const doc = {
        getElementById(id) {
            if (id === 'midi-calibration-panel') return panel;
            return nodes[id] || null;
        },
    };
    const midiDevices = {
        writeTiming(timing) {
            writes.push(timing);
            return Promise.resolve({ timing });
        },
        getActive() {
            return { timing: { offset_ms: 18, audio_backend: 'html5' } };
        },
    };
    const api = loadHint();
    const Ctor = mockAudioContext({ base: 0.005, output: 0.012 });
    const mounted = api.mount(doc, { AudioContext: Ctor, midiDevices, window: { _juceMode: false } });
    assert.equal(nodes['audio-latency-hint-probe'].textContent, '17 ms (estimate)');
    assert.equal(writes.length, 0);
    confirm.listeners.click();
    await new Promise((r) => setImmediate(r));
    assert.equal(writes.length, 1);
    assert.equal(writes[0].offset_ms, 18);
    assert.equal(writes[0].audio_latency_hint_ms, 17);
    assert.ok(mounted);
});

test('host chrome lives on the MIDI Calibration panel', () => {
    assert.match(V3_HTML, /id="audio-latency-hint"/);
    assert.match(V3_HTML, /id="audio-latency-hint-probe"/);
    assert.match(V3_HTML, /id="audio-latency-hint-override"/);
    assert.match(V3_HTML, /id="audio-latency-hint-confirm"/);
    assert.match(V3_HTML, /\/static\/js\/audio-latency-hint\.js/);
    const calibAt = V3_HTML.indexOf('id="midi-calibration-panel"');
    const hintAt = V3_HTML.indexOf('id="audio-latency-hint"');
    assert.ok(hintAt > calibAt);
    assert.match(V3_HTML, /base latency plus output latency/i);
    assert.match(V3_HTML, /not applied until you confirm/i);
});

test('helper never writes av_offset_ms or folds hint into offset_ms', () => {
    assert.doesNotMatch(HINT_SRC, /av_offset_ms/);
    assert.doesNotMatch(HINT_SRC, /setAvOffset/);
    assert.doesNotMatch(HINT_SRC, /offset_ms\s*\+/);
    assert.match(MIDI_DEVICES_JS, /audio_latency_hint_ms/);
    assert.match(HINT_SRC, /new Ctor\(\)/);
    assert.match(HINT_SRC, /ctx\.close/);
});
