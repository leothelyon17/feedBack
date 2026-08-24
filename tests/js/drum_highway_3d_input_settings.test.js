'use strict';

// INIT-002/SPEC-004b: 3D highway shared MIDI settings consumption.
// screen.js is vm-loaded (no DOM / WebGL). Settings markup is source-scanned.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SCREEN = path.join(REPO_ROOT, 'plugins', 'drum_highway_3d', 'screen.js');
const SETTINGS = path.join(REPO_ROOT, 'plugins', 'drum_highway_3d', 'settings.html');

function deferred() {
    let resolve, reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}

function makeDrumInput() {
    const subs = [];
    const notified = [];
    const updates = [];
    const state = {
        version: 1,
        revision: { clock: 100, origin: 'test-origin', sequence: 0 },
        deviceEnabled: false,
        midiChannel: -1,
        hitDetection: false,
        synthVolume: 0.7,
    };
    let seq = 0;
    const api = {
        version: 1,
        EVENT: 'feedback:drum-input-change',
        get() {
            return Object.assign({}, state, { revision: Object.assign({}, state.revision) });
        },
        update(partial) {
            updates.push(Object.assign({}, partial));
            const changedKeys = [];
            const src = partial && typeof partial === 'object' ? partial : {};
            for (const key of ['deviceEnabled', 'midiChannel', 'hitDetection', 'synthVolume']) {
                if (Object.prototype.hasOwnProperty.call(src, key) && state[key] !== src[key]) {
                    state[key] = src[key];
                    changedKeys.push(key);
                }
            }
            if (changedKeys.length) {
                seq += 1;
                state.revision = { clock: 1000 + seq, origin: 'test-origin', sequence: seq };
                const detail = {
                    version: 1,
                    revision: Object.assign({}, state.revision),
                    origin: 'test-origin',
                    changedKeys,
                    kitId: null,
                    mutation: null,
                    midiNote: null,
                };
                for (const fn of subs.slice()) fn(detail);
            }
            return api.get();
        },
        subscribe(fn) {
            if (typeof fn !== 'function') return function noop() {};
            subs.push(fn);
            return function unsub() {
                const i = subs.indexOf(fn);
                if (i >= 0) subs.splice(i, 1);
            };
        },
        unsubscribe(fn) {
            const i = subs.indexOf(fn);
            if (i === -1) return false;
            subs.splice(i, 1);
            return true;
        },
        notifyMappingChange(payload) {
            notified.push(payload);
            return { version: 1, revision: { clock: Date.now(), origin: 'test', sequence: notified.length }, changedKeys: [], ...payload };
        },
        _subs: subs,
        _notified: notified,
        _updates: updates,
        _state: state,
        _emit(detail) { for (const fn of subs.slice()) fn(detail); },
    };
    return api;
}

function makeMidiInput() {
    const sources = [
        { sourceId: 'dev1', label: 'Pad One', logicalSourceKey: 'web-midi::dev1' },
        { sourceId: 'dev2', label: 'Pad Two', logicalSourceKey: 'web-midi::dev2' },
    ];
    const listeners = [];
    const handle = {
        addListener(fn) { listeners.push(fn); this._adds += 1; },
        removeListener(fn) {
            const i = listeners.indexOf(fn);
            if (i >= 0) listeners.splice(i, 1);
            this._removes += 1;
        },
        _adds: 0,
        _removes: 0,
        _listeners: listeners,
    };
    const pending = [];
    return {
        version: 1,
        listSources() { return sources.slice(); },
        async discover() { return { outcome: 'handled' }; },
        async select() { this._selects += 1; },
        open(args) {
            const d = deferred();
            pending.push(d);
            this._opens.push(args);
            return d.promise;
        },
        close(args) { this._closes.push(args); },
        _opens: [],
        _closes: [],
        _selects: 0,
        _pending: pending,
        _handle: handle,
        resolveOpen() {
            const d = pending.shift();
            if (d) d.resolve({ handle });
        },
        rejectOpen(err) {
            const d = pending.shift();
            if (d) d.reject(err || new Error('open failed'));
        },
    };
}

function load(opts) {
    const store = (opts && opts.store) || {};
    const drumInput = (opts && opts.drumInput) || makeDrumInput();
    const midiInput = (opts && opts.midiInput) || makeMidiInput();
    const window = {
        console,
        location: { protocol: 'http:', host: 'localhost' },
        slopsmith: { midiInput, on() {}, off() {} },
        feedBack: { drumInput, emit() {}, on() {}, off() {} },
        localStorage: {
            getItem(k) {
                return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null;
            },
            setItem(k, v) { store[k] = String(v); },
            removeItem(k) { delete store[k]; },
        },
        addEventListener() {},
        removeEventListener() {},
        dispatchEvent() { return true; },
        CustomEvent: class CustomEvent {
            constructor(type, init = {}) { this.type = type; this.detail = init.detail; }
        },
    };
    window.window = window;
    window.globalThis = window;
    const context = vm.createContext(window);
    vm.runInContext(fs.readFileSync(SCREEN, 'utf8'), context, { filename: 'screen.js' });
    return {
        window,
        store,
        drumInput,
        midiInput,
        __test: window.slopsmithViz_drum_highway_3d.__test,
    };
}

test('REQ-005: Source None disconnects and stays disabled via drumInput.update', () => {
    const ctx = load();
    ctx.__test._addTestInstance();
    ctx.__test._ensureMappingListeners();
    ctx.window.drumH3dSetMidiInput('dev1');
    assert.equal(ctx.window.drumH3dGetInputSettings().deviceEnabled, true);
    assert.ok(ctx.drumInput._updates.some((u) => u.deviceEnabled === true));
    const before = ctx.drumInput._updates.length;
    ctx.window.drumH3dSetMidiInput('');
    assert.equal(ctx.window.drumH3dGetInputSettings().deviceEnabled, false);
    assert.ok(ctx.drumInput._updates.slice(before).some((u) => u.deviceEnabled === false));
    assert.equal(ctx.__test._readSavedPick().id, '');
    ctx.__test._midiAutoConnect();
    assert.equal(ctx.__test._midiInput, null, 'auto-connect must not flip None back on');
});

test('REQ-005: selecting a source enables through the core domain', () => {
    const ctx = load();
    ctx.__test._addTestInstance();
    ctx.__test._ensureMappingListeners();
    ctx.window.drumH3dSetMidiInput('dev1');
    assert.equal(ctx.window.drumH3dGetInputSettings().deviceEnabled, true);
    assert.equal(ctx.drumInput.get().deviceEnabled, true);
    assert.equal(ctx.__test._readSavedPick().id, 'dev1');
});

test('REQ-005: channel, hits, and volume writes go through drumInput.update', () => {
    const ctx = load();
    ctx.__test._ensureMappingListeners();
    ctx.window.drumH3dSetMidiChannel(9);
    ctx.window.drumH3dSetHitDetection(true);
    ctx.window.drumH3dSetSynthVolume(0.25);
    assert.equal(ctx.drumInput.get().midiChannel, 9);
    assert.equal(ctx.drumInput.get().hitDetection, true);
    assert.equal(ctx.drumInput.get().synthVolume, 0.25);
    assert.equal(ctx.window.drumH3dGetMidiChannel(), 9);
    assert.equal(ctx.window.drumH3dGetHitDetection(), true);
    assert.equal(ctx.window.drumH3dGetSynthVolume(), 0.25);
    assert.ok(ctx.drumInput._updates.some((u) => u.midiChannel === 9));
    assert.ok(ctx.drumInput._updates.some((u) => u.hitDetection === true));
    assert.ok(ctx.drumInput._updates.some((u) => u.synthVolume === 0.25));
});

test('REQ-005: incoming changedKeys refresh without echoing update', () => {
    const ctx = load();
    ctx.__test._ensureMappingListeners();
    const before = ctx.drumInput._updates.length;
    ctx.drumInput._state.midiChannel = 4;
    ctx.drumInput._state.hitDetection = true;
    ctx.drumInput._state.synthVolume = 0.15;
    ctx.drumInput._state.deviceEnabled = false;
    ctx.drumInput._emit({
        version: 1,
        revision: { clock: 9000, origin: '2d', sequence: 9 },
        changedKeys: ['midiChannel', 'hitDetection', 'synthVolume', 'deviceEnabled'],
    });
    assert.equal(ctx.window.drumH3dGetMidiChannel(), 4);
    assert.equal(ctx.window.drumH3dGetHitDetection(), true);
    assert.equal(ctx.window.drumH3dGetSynthVolume(), 0.15);
    assert.equal(ctx.window.drumH3dGetInputSettings().deviceEnabled, false);
    assert.equal(ctx.drumInput._updates.length, before);
});

test('REQ-005: migration preserves drum_h3d_midi_pick_v2, drum_h3d_midi_input, and volume', () => {
    const store = {
        drum_h3d_midi_pick_v2: JSON.stringify({ id: 'pad-1', name: 'Alesis', key: 'web-midi::pad-1' }),
        drum_h3d_midi_input: 'pad-1',
        drum_h3d_synth_vol: '0.42',
        drum_h3d_kit_v1: '{"name":"keep-me"}',
    };
    const ctx = load({ store });
    ctx.__test._ensureMappingListeners();
    assert.equal(store.drum_h3d_midi_input, 'pad-1');
    const pick = JSON.parse(store.drum_h3d_midi_pick_v2);
    assert.equal(pick.id, 'pad-1');
    assert.equal(pick.name, 'Alesis');
    assert.equal(pick.key, 'web-midi::pad-1');
    assert.equal(ctx.window.drumH3dGetSynthVolume(), 0.42);
    assert.equal(store.drum_h3d_kit_v1, '{"name":"keep-me"}', 'GR-002: must not write mappings into the kit key');
});

test('REQ-005: no private requestMIDIAccess path in 3D screen.js', () => {
    const src = fs.readFileSync(SCREEN, 'utf8');
    assert.equal(/navigator\.requestMIDIAccess/.test(src), false);
    assert.equal(/requestMIDIAccess\s*\(/.test(src), false);
    assert.match(src, /_MIDI_REQUESTER = 'drum_highway_3d'/);
});

test('REQ-002: 3D-origin settings update produces one version-1 event 2D can consume', () => {
    const ctx = load();
    ctx.__test._ensureMappingListeners();
    ctx.window.drumH3dSetMidiChannel(6);
    assert.equal(ctx.drumInput._updates.filter((u) => Object.prototype.hasOwnProperty.call(u, 'midiChannel')).length, 1);
    const last = ctx.drumInput._updates[ctx.drumInput._updates.length - 1];
    assert.equal(last.midiChannel, 6);
    assert.equal(ctx.drumInput.get().revision.origin, 'test-origin');
});

test('REQ-002: self-origin settings echo does not call update again', () => {
    const ctx = load();
    ctx.__test._ensureMappingListeners();
    ctx.window.drumH3dSetMidiChannel(3);
    const afterWrite = ctx.drumInput._updates.length;
    ctx.drumInput._emit({
        version: 1,
        revision: ctx.drumInput.get().revision,
        origin: 'test-origin',
        changedKeys: ['midiChannel'],
    });
    assert.equal(ctx.drumInput._updates.length, afterWrite);
    assert.equal(ctx.window.drumH3dGetMidiChannel(), 3);
});

test('REQ-002: stale settings revision is ignored', () => {
    const ctx = load();
    ctx.__test._ensureMappingListeners();
    ctx.window.drumH3dSetMidiChannel(4);
    ctx.drumInput._state.midiChannel = 11;
    ctx.drumInput._emit({
        version: 1,
        revision: { clock: 1, origin: '2d', sequence: 1 },
        changedKeys: ['midiChannel'],
    });
    assert.equal(ctx.window.drumH3dGetMidiChannel(), 4, 'stale event must not overwrite');
});

test('REQ-002: channel filter matches 2D meaning (-1 all, else exact channel)', () => {
    const ctx = load();
    ctx.__test._ensureMappingListeners();
    const hits = [];
    ctx.__test._setActiveInstance({
        _handleDrumHit(note, vel) { hits.push([note, vel]); },
    });
    ctx.window.drumH3dSetMidiChannel(9);
    ctx.__test._midiOnMessage({ data: [0x90 | 0, 36, 100] });
    assert.equal(hits.length, 0, 'channel 1 must be filtered when 10 (Drums) is selected');
    ctx.__test._midiOnMessage({ data: [0x90 | 9, 36, 100] });
    assert.equal(hits.length, 1);
    ctx.window.drumH3dSetMidiChannel(-1);
    ctx.__test._midiOnMessage({ data: [0x90 | 3, 38, 90] });
    assert.equal(hits.length, 2);
});

test('REQ-009: delayed MIDI-open success after release cannot reconnect', async () => {
    const midiInput = makeMidiInput();
    const ctx = load({ midiInput });
    ctx.__test._addTestInstance();
    ctx.__test._midiResume();
    const pending = ctx.window.drumH3dSetMidiInput('dev1');
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert.equal(midiInput._opens.length, 1);
    ctx.__test._midiReleaseSession();
    midiInput.resolveOpen();
    await pending;
    assert.equal(ctx.__test._midiActive, false);
    assert.equal(ctx.__test._midiHandle, null);
    assert.equal(midiInput._handle._adds, 0, 'stale open must not wire a listener');
    assert.ok(midiInput._closes.length >= 1);
});

test('REQ-009: delayed MIDI-open failure after a newer connect is ignored', async () => {
    const midiInput = makeMidiInput();
    const ctx = load({ midiInput });
    const dummy = ctx.__test._addTestInstance();
    ctx.__test._midiResume();
    ctx.__test._inputSettings; // touch getter
    const first = ctx.window.drumH3dSetMidiInput('dev1');
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    const second = ctx.window.drumH3dSetMidiInput('dev2');
    midiInput.rejectOpen(new Error('stale open failed'));
    await first;
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    midiInput.resolveOpen();
    await second;
    assert.equal(ctx.__test._midiInput && ctx.__test._midiInput.id, 'dev2');
    ctx.__test._removeTestInstance(dummy);
    ctx.__test._midiReleaseSession();
});

test('REQ-009: repeated ensure/release returns one listener and no leftover MIDI session', async () => {
    const midiInput = makeMidiInput();
    const ctx = load({ midiInput });
    assert.equal(ctx.drumInput._subs.length, 0);
    ctx.__test._ensureMappingListeners();
    ctx.__test._ensureMappingListeners();
    assert.equal(ctx.drumInput._subs.length, 1, 'one subscribe owner — do not add a second');
    const dummy = ctx.__test._addTestInstance();
    ctx.__test._midiResume();
    const pending = ctx.window.drumH3dSetMidiInput('dev1');
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    midiInput.resolveOpen();
    await pending;
    ctx.__test._removeTestInstance(dummy);
    ctx.__test._midiReleaseSession();
    ctx.__test._releaseMappingListeners();
    assert.equal(ctx.drumInput._subs.length, 0);
    assert.equal(ctx.__test._mappingListenerCount, 0);
    assert.equal(ctx.__test._midiHandle, null);
    assert.equal(ctx.__test._midiActive, false);
    ctx.__test._ensureMappingListeners();
    assert.equal(ctx.drumInput._subs.length, 1);
    ctx.__test._releaseMappingListeners();
    assert.equal(ctx.drumInput._subs.length, 0);
});

test('REQ-005: settings markup has no MIDI channel knobs (MIDI tab owns them)', () => {
    const html = fs.readFileSync(SETTINGS, 'utf8');
    assert.doesNotMatch(html, /id="drumh3d-midi-channel"/);
    assert.doesNotMatch(html, /for="drumh3d-midi-channel"/);
    assert.doesNotMatch(html, /id="drumh3d-midi-input"/);
    assert.doesNotMatch(html, /id="drumh3d-hit-detect"/);
    assert.doesNotMatch(html, /id="drumh3d-synth-vol"/);
    assert.match(html, /3D lane layout/);
});
