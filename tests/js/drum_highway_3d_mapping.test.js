'use strict';

// INIT-002/SPEC-004: 3D highway kit mapping editor + live mapping parity.
// screen.js is vm-loaded (no DOM / WebGL). Settings a11y is source-scanned.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SCREEN = path.join(REPO_ROOT, 'plugins', 'drum_highway_3d', 'screen.js');
const SETTINGS = path.join(REPO_ROOT, 'plugins', 'drum_highway_3d', 'settings.html');

function jsonOk(body) {
    return { ok: true, json: async () => body };
}
function jsonFail() {
    return { ok: false, json: async () => ({ error: 'fail' }) };
}

function deferred() {
    let resolve;
    const promise = new Promise((res) => { resolve = res; });
    return { promise, resolve };
}

function makeDrumInput() {
    const subs = [];
    const notified = [];
    return {
        version: 1,
        EVENT: 'feedback:drum-input-change',
        get() { return { version: 1, deviceEnabled: false, midiChannel: -1, hitDetection: false, synthVolume: 0.7 }; },
        update() { return this.get(); },
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
        _emit(detail) { for (const fn of subs.slice()) fn(detail); },
    };
}

function load(opts) {
    const store = (opts && opts.store) || {};
    const drumInput = (opts && opts.drumInput) || makeDrumInput();
    const window = {
        console,
        location: { protocol: 'http:', host: 'localhost' },
        slopsmith: {},
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
        __test: window.slopsmithViz_drum_highway_3d.__test,
    };
}

function kitDoc(id, notes) {
    return { id, name: id === 'alesis-strata-prime' ? 'Alesis Strata Prime' : id, notes: notes || {}, source: 'user' };
}

function installFetch(ctx, routes) {
    const calls = [];
    ctx.__test._setMappingFetch(async (url, opts) => {
        calls.push({ url: String(url), method: (opts && opts.method) || 'GET', body: opts && opts.body, opts });
        const key = ((opts && opts.method) || 'GET') + ' ' + url;
        if (typeof routes === 'function') return routes(url, opts, calls);
        if (routes[key]) return routes[key](url, opts, calls);
        if (routes[url]) return routes[url](url, opts, calls);
        return jsonFail();
    });
    return calls;
}

test('REQ-007: selecting a kit without Use this kit cannot mutate mappings', async () => {
    const ctx = load();
    const calls = installFetch(ctx, {
        'GET /api/drums/kits': () => jsonOk({ kits: [kitDoc('alesis-strata-prime')] }),
        'GET /api/settings': () => jsonOk({}),
    });
    await ctx.window.drumH3dEnsureMappingInit();
    ctx.window.drumH3dSelectCoreKit('alesis-strata-prime');
    const status = ctx.window.drumH3dGetCoreKitStatus();
    assert.equal(status.selectedId, 'alesis-strata-prime');
    assert.equal(status.confirmedId, null);
    assert.equal(status.canMutate, false);
    const result = await ctx.window.drumH3dSetNoteMapping(24, 'kick');
    assert.equal(result.ok, false);
    assert.equal(calls.some((c) => c.method === 'PUT'), false);
    assert.equal(calls.some((c) => c.method === 'POST'), false);
    assert.equal(calls.some((c) => /\/notes\//.test(c.url)), false);
});

test('REQ-007: no mapping action writes active_kit', async () => {
    const ctx = load();
    const kit = kitDoc('alesis-strata-prime', { 24: 'kick' });
    const calls = installFetch(ctx, (url, opts) => {
        const method = (opts && opts.method) || 'GET';
        if (method === 'GET' && url === '/api/drums/kits') return jsonOk({ kits: [kit] });
        if (method === 'GET' && url === '/api/settings') return jsonOk({ active_kit: 'alesis-strata-prime' });
        if (method === 'GET' && url === '/api/drums/kits/alesis-strata-prime') return jsonOk(kit);
        if (method === 'PUT' && url === '/api/drums/kits/alesis-strata-prime/notes/38') {
            return jsonOk({
                kit: kitDoc('alesis-strata-prime', { 24: 'kick', 38: 'snare' }),
                mutation: { midi_note: 38, operation: 'set', piece_id: 'snare' },
                resolution: { piece_id: 'snare', source: 'kit' },
            });
        }
        if (method === 'POST') return jsonOk({ error: 'should not POST' });
        return jsonFail();
    });
    await ctx.window.drumH3dEnsureMappingInit();
    assert.equal(ctx.window.drumH3dCanMutateMapping(), true);
    const result = await ctx.window.drumH3dSetNoteMapping(38, 'snare');
    assert.equal(result.ok, true);
    assert.equal(calls.some((c) => c.method === 'POST' && c.url === '/api/settings'), false);
});

test('REQ-007: confirmed kit can Learn, set, remove, and Undo', async () => {
    const ctx = load();
    let notes = { 36: 'snare' };
    installFetch(ctx, (url, opts) => {
        const method = (opts && opts.method) || 'GET';
        if (method === 'GET' && url === '/api/drums/kits') return jsonOk({ kits: [kitDoc('user-kit', notes)] });
        if (method === 'GET' && url === '/api/settings') return jsonOk({ active_kit: 'user-kit' });
        if (method === 'GET' && url === '/api/drums/kits/user-kit') return jsonOk(kitDoc('user-kit', notes));
        if (method === 'PUT' && /\/notes\/25$/.test(url)) {
            notes = { ...notes, 25: 'kick' };
            return jsonOk({
                kit: kitDoc('user-kit', notes),
                mutation: { midi_note: 25, operation: 'set', piece_id: 'kick' },
                resolution: { piece_id: 'kick', source: 'kit' },
            });
        }
        if (method === 'DELETE' && /\/notes\/36$/.test(url)) {
            const next = { ...notes };
            delete next[36];
            notes = next;
            return jsonOk({
                kit: kitDoc('user-kit', notes),
                mutation: { midi_note: 36, operation: 'delete', piece_id: null },
                resolution: { piece_id: 'kick', source: 'gm' },
            });
        }
        if (method === 'PUT' && /\/notes\/36$/.test(url)) {
            notes = { ...notes, 36: 'snare' };
            return jsonOk({
                kit: kitDoc('user-kit', notes),
                mutation: { midi_note: 36, operation: 'set', piece_id: 'snare' },
                resolution: { piece_id: 'snare', source: 'kit' },
            });
        }
        return jsonFail();
    });
    await ctx.window.drumH3dEnsureMappingInit();
    assert.equal(ctx.__test._midiToPiece(36), 'snare');

    ctx.window.drumH3dLearnPiece('kick');
    assert.equal(ctx.__test._learnPiece, 'kick');
    await ctx.__test._midiOnMessage({ data: [0x90, 25, 100] });
    assert.equal(ctx.__test._midiToPiece(25), 'kick');
    assert.equal(ctx.__test._learnPiece, null);

    const removed = await ctx.window.drumH3dRemoveNoteMapping(36);
    assert.equal(removed.ok, true);
    assert.equal(ctx.__test._midiToPiece(36), 'kick', 'GM fallback after custom remove');
    const rows = ctx.window.drumH3dGetMappingRows();
    const snare = rows.find((r) => r.pieceId === 'snare');
    assert.equal(snare.customNotes.includes(36), false);

    const undone = await ctx.window.drumH3dUndoLastRemove();
    assert.equal(undone.ok, true);
    assert.equal(ctx.__test._midiToPiece(36), 'snare');
    const afterUndo = ctx.window.drumH3dGetMappingRows().find((r) => r.pieceId === 'snare');
    assert.equal(afterUndo.customNotes.includes(36), true);
});

test('REQ-003: mapping rows distinguish custom, GM-default, and unmapped', async () => {
    const ctx = load();
    installFetch(ctx, {
        'GET /api/drums/kits': () => jsonOk({ kits: [kitDoc('user-kit', { 24: 'kick' })] }),
        'GET /api/settings': () => jsonOk({ active_kit: 'user-kit' }),
        'GET /api/drums/kits/user-kit': () => jsonOk(kitDoc('user-kit', { 24: 'kick' })),
    });
    await ctx.window.drumH3dEnsureMappingInit();
    const rows = ctx.window.drumH3dGetMappingRows();
    const byId = Object.fromEntries(rows.map((r) => [r.pieceId, r]));
    assert.equal(byId.kick.customNotes.includes(24), true);
    assert.equal(byId.kick.unmapped, false);
    assert.equal(byId.snare.customNotes.length, 0);
    assert.ok(byId.snare.gmNotes.includes(38) || byId.snare.gmNotes.includes(40));
    const stack = byId.stack;
    if (stack) {
        assert.equal(stack.unmapped || stack.gmNotes.length > 0, true);
    }
});

test('REQ-003: mapping mutations never write drum_h3d_kit_v1', async () => {
    const custom = {
        version: 1,
        name: 'User 3-piece',
        lanes: [{ piece: 'hh_closed' }, { piece: 'snare' }, { piece: 'kick' }],
        fallbacks: { hh_open: 'hh_closed' },
    };
    const store = { drum_h3d_kit_v1: JSON.stringify(custom) };
    const ctx = load({ store });
    const before = store.drum_h3d_kit_v1;
    installFetch(ctx, (url, opts) => {
        const method = (opts && opts.method) || 'GET';
        if (method === 'GET' && url === '/api/drums/kits') return jsonOk({ kits: [kitDoc('user-kit')] });
        if (method === 'GET' && url === '/api/settings') return jsonOk({ active_kit: 'user-kit' });
        if (method === 'GET' && url === '/api/drums/kits/user-kit') return jsonOk(kitDoc('user-kit', {}));
        if (method === 'PUT') {
            return jsonOk({
                kit: kitDoc('user-kit', { 24: 'kick' }),
                mutation: { midi_note: 24, operation: 'set', piece_id: 'kick' },
                resolution: { piece_id: 'kick', source: 'kit' },
            });
        }
        return jsonFail();
    });
    await ctx.window.drumH3dEnsureMappingInit();
    await ctx.window.drumH3dSetNoteMapping(24, 'kick');
    assert.equal(store.drum_h3d_kit_v1, before);
    const visual = ctx.window.drumH3dGetKit();
    assert.equal(visual.name, 'User 3-piece');
    assert.equal(visual.lanes.map((l) => l.piece).join(','), 'hh_closed,snare,kick');
});

test('REQ-002: 3D-origin set produces one mapping notify and updates overlay', async () => {
    const ctx = load();
    installFetch(ctx, (url, opts) => {
        const method = (opts && opts.method) || 'GET';
        if (method === 'GET' && url === '/api/drums/kits') return jsonOk({ kits: [kitDoc('user-kit')] });
        if (method === 'GET' && url === '/api/settings') return jsonOk({ active_kit: 'user-kit' });
        if (method === 'GET' && url === '/api/drums/kits/user-kit') return jsonOk(kitDoc('user-kit', {}));
        if (method === 'PUT') {
            return jsonOk({
                kit: kitDoc('user-kit', { 24: 'kick' }),
                mutation: { midi_note: 24, operation: 'set', piece_id: 'kick' },
                resolution: { piece_id: 'kick', source: 'kit' },
            });
        }
        return jsonFail();
    });
    await ctx.window.drumH3dEnsureMappingInit();
    await ctx.window.drumH3dSetNoteMapping(24, 'kick');
    assert.equal(ctx.__test._midiToPiece(24), 'kick');
    assert.equal(ctx.drumInput._notified.length, 1);
    assert.equal(ctx.drumInput._notified[0].mutation, 'set');
    assert.equal(ctx.drumInput._notified[0].midiNote, 24);
    assert.equal(ctx.drumInput._notified[0].kitId, 'user-kit');
});

test('REQ-002: 2D-origin mapping event refetches and does not re-emit', async () => {
    const ctx = load();
    let kitNotes = {};
    const calls = installFetch(ctx, (url, opts) => {
        const method = (opts && opts.method) || 'GET';
        if (method === 'GET' && url === '/api/drums/kits') return jsonOk({ kits: [kitDoc('user-kit')] });
        if (method === 'GET' && url === '/api/settings') return jsonOk({ active_kit: 'user-kit' });
        if (method === 'GET' && url === '/api/drums/kits/user-kit') return jsonOk(kitDoc('user-kit', kitNotes));
        return jsonFail();
    });
    await ctx.window.drumH3dEnsureMappingInit();
    ctx.__test._ensureMappingListeners();
    const beforeNotify = ctx.drumInput._notified.length;
    kitNotes = { 38: 'tom_hi' };
    ctx.drumInput._emit({
        version: 1,
        revision: { clock: 2000, origin: '2d', sequence: 1 },
        changedKeys: [],
        kitId: 'user-kit',
        mutation: 'set',
        midiNote: 38,
    });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert.equal(ctx.__test._midiToPiece(38), 'tom_hi');
    assert.equal(ctx.drumInput._notified.length, beforeNotify);
    assert.ok(calls.filter((c) => c.method === 'GET' && c.url === '/api/drums/kits/user-kit').length >= 2);
});

test('REQ-002: stale mapping event is ignored', async () => {
    const ctx = load();
    let kitNotes = { 24: 'kick' };
    installFetch(ctx, (url, opts) => {
        const method = (opts && opts.method) || 'GET';
        if (method === 'GET' && url === '/api/drums/kits') return jsonOk({ kits: [kitDoc('user-kit')] });
        if (method === 'GET' && url === '/api/settings') return jsonOk({ active_kit: 'user-kit' });
        if (method === 'GET' && url === '/api/drums/kits/user-kit') return jsonOk(kitDoc('user-kit', kitNotes));
        return jsonFail();
    });
    await ctx.window.drumH3dEnsureMappingInit();
    ctx.__test._ensureMappingListeners();
    kitNotes = { 24: 'snare' };
    ctx.drumInput._emit({
        version: 1,
        revision: { clock: 5000, origin: '2d', sequence: 2 },
        changedKeys: [],
        kitId: 'user-kit',
        mutation: 'set',
        midiNote: 24,
    });
    await new Promise((r) => setImmediate(r));
    assert.equal(ctx.__test._midiToPiece(24), 'snare');
    kitNotes = { 24: 'tom_hi' };
    ctx.drumInput._emit({
        version: 1,
        revision: { clock: 1000, origin: '2d', sequence: 1 },
        changedKeys: [],
        kitId: 'user-kit',
        mutation: 'set',
        midiNote: 24,
    });
    await new Promise((r) => setImmediate(r));
    assert.equal(ctx.__test._midiToPiece(24), 'snare', 'stale event must not overwrite');
});

test('REQ-002: failed refetch leaves overlay unchanged', async () => {
    const ctx = load();
    let failNextKitGet = false;
    installFetch(ctx, (url, opts) => {
        const method = (opts && opts.method) || 'GET';
        if (method === 'GET' && url === '/api/drums/kits') return jsonOk({ kits: [kitDoc('user-kit')] });
        if (method === 'GET' && url === '/api/settings') return jsonOk({ active_kit: 'user-kit' });
        if (method === 'GET' && url === '/api/drums/kits/user-kit') {
            if (failNextKitGet) return jsonFail();
            return jsonOk(kitDoc('user-kit', { 24: 'kick' }));
        }
        return jsonFail();
    });
    await ctx.window.drumH3dEnsureMappingInit();
    assert.equal(ctx.__test._midiToPiece(24), 'kick');
    failNextKitGet = true;
    ctx.__test._ensureMappingListeners();
    ctx.drumInput._emit({
        version: 1,
        revision: { clock: 9000, origin: '2d', sequence: 9 },
        changedKeys: [],
        kitId: 'user-kit',
        mutation: 'delete',
        midiNote: 24,
    });
    await new Promise((r) => setImmediate(r));
    assert.equal(ctx.__test._midiToPiece(24), 'kick');
});

test('REQ-007: confirm race — stale confirm cannot enable the older kit', async () => {
    const ctx = load();
    const slowA = deferred();
    installFetch(ctx, (url, opts) => {
        const method = (opts && opts.method) || 'GET';
        if (method === 'GET' && url === '/api/drums/kits') {
            return jsonOk({ kits: [kitDoc('kit-a'), kitDoc('kit-b')] });
        }
        if (method === 'GET' && url === '/api/settings') return jsonOk({});
        if (method === 'POST' && url === '/api/settings') return jsonOk({ active_kit: JSON.parse(opts.body).active_kit });
        if (method === 'GET' && url === '/api/drums/kits/kit-a') return slowA.promise;
        if (method === 'GET' && url === '/api/drums/kits/kit-b') return jsonOk(kitDoc('kit-b', { 40: 'snare' }));
        return jsonFail();
    });
    await ctx.window.drumH3dEnsureMappingInit();
    ctx.window.drumH3dSelectCoreKit('kit-a');
    const pendingA = ctx.window.drumH3dConfirmCoreKit();
    ctx.window.drumH3dSelectCoreKit('kit-b');
    const resultB = await ctx.window.drumH3dConfirmCoreKit();
    assert.equal(resultB.ok, true);
    assert.equal(ctx.window.drumH3dGetCoreKitStatus().confirmedId, 'kit-b');
    slowA.resolve(jsonOk(kitDoc('kit-a', { 24: 'kick' })));
    const resultA = await pendingA;
    assert.equal(resultA.stale, true);
    assert.equal(ctx.window.drumH3dGetCoreKitStatus().confirmedId, 'kit-b');
    assert.equal(ctx.__test._midiToPiece(40), 'snare');
});

test('REQ-008: remove failure leaves kit notes unchanged and offers no Undo', async () => {
    const ctx = load();
    installFetch(ctx, (url, opts) => {
        const method = (opts && opts.method) || 'GET';
        if (method === 'GET' && url === '/api/drums/kits') return jsonOk({ kits: [kitDoc('user-kit')] });
        if (method === 'GET' && url === '/api/settings') return jsonOk({ active_kit: 'user-kit' });
        if (method === 'GET' && url === '/api/drums/kits/user-kit') return jsonOk(kitDoc('user-kit', { 24: 'kick' }));
        if (method === 'DELETE') return jsonFail();
        return jsonFail();
    });
    await ctx.window.drumH3dEnsureMappingInit();
    const result = await ctx.window.drumH3dRemoveNoteMapping(24);
    assert.equal(result.ok, false);
    assert.equal(ctx.__test._midiToPiece(24), 'kick');
    assert.equal(ctx.window.drumH3dGetCoreKitStatus().undoAvailable, false);
    assert.equal(ctx.drumInput._notified.length, 0);
});

test('REQ-008: GM defaults cannot invoke DELETE', async () => {
    const ctx = load();
    const calls = installFetch(ctx, (url, opts) => {
        const method = (opts && opts.method) || 'GET';
        if (method === 'GET' && url === '/api/drums/kits') return jsonOk({ kits: [kitDoc('user-kit')] });
        if (method === 'GET' && url === '/api/settings') return jsonOk({ active_kit: 'user-kit' });
        if (method === 'GET' && url === '/api/drums/kits/user-kit') return jsonOk(kitDoc('user-kit', {}));
        return jsonFail();
    });
    await ctx.window.drumH3dEnsureMappingInit();
    const result = await ctx.window.drumH3dRemoveNoteMapping(36);
    assert.equal(result.ok, false);
    assert.equal(calls.some((c) => c.method === 'DELETE'), false);
});

test('REQ-008: settings markup has no mapping table; 3D lane layout remains', () => {
    const html = fs.readFileSync(SETTINGS, 'utf8');
    assert.doesNotMatch(html, /id="drumh3d-use-kit"/);
    assert.doesNotMatch(html, /MIDI kit mapping/);
    assert.doesNotMatch(html, /id="drumh3d-map-rows"/);
    assert.doesNotMatch(html, /id="drumh3d-midi-input"/);
    assert.doesNotMatch(html, /id="drumh3d-midi-channel"/);
    assert.match(html, /3D lane layout/);
    assert.match(html, /type="button"/);
});

test('REQ-009: delayed hydrate after release cannot apply a superseded kit', async () => {
    const ctx = load();
    const slowKit = deferred();
    installFetch(ctx, (url, opts) => {
        const method = (opts && opts.method) || 'GET';
        if (method === 'GET' && url === '/api/drums/kits') return jsonOk({ kits: [kitDoc('user-kit')] });
        if (method === 'GET' && url === '/api/settings') return jsonOk({ active_kit: 'user-kit' });
        if (method === 'GET' && url === '/api/drums/kits/user-kit') return slowKit.promise;
        return jsonFail();
    });
    const pending = ctx.window.drumH3dEnsureMappingInit();
    ctx.__test._releaseMappingListeners();
    slowKit.resolve(jsonOk(kitDoc('user-kit', { 24: 'kick' })));
    const result = await pending;
    assert.equal(result.stale, true);
    assert.equal(ctx.__test._confirmedKitId, null);
    assert.equal(ctx.__test._midiToPiece(24), undefined);
});

test('REQ-009: delayed failed hydrate after release is ignored', async () => {
    const ctx = load();
    const slowKit = deferred();
    installFetch(ctx, (url, opts) => {
        const method = (opts && opts.method) || 'GET';
        if (method === 'GET' && url === '/api/drums/kits') return jsonOk({ kits: [kitDoc('user-kit')] });
        if (method === 'GET' && url === '/api/settings') return jsonOk({ active_kit: 'user-kit' });
        if (method === 'GET' && url === '/api/drums/kits/user-kit') return slowKit.promise;
        return jsonFail();
    });
    const pending = ctx.window.drumH3dEnsureMappingInit();
    ctx.__test._releaseMappingListeners();
    slowKit.resolve(jsonFail());
    const result = await pending;
    assert.equal(result.stale, true);
    assert.equal(ctx.__test._confirmedKitId, null);
});

test('REQ-009: repeated ensure/release returns listener count to baseline', () => {
    const ctx = load();
    assert.equal(ctx.drumInput._subs.length, 0);
    ctx.__test._ensureMappingListeners();
    ctx.__test._ensureMappingListeners();
    assert.equal(ctx.drumInput._subs.length, 1);
    assert.equal(ctx.__test._mappingListenerCount, 1);
    ctx.__test._releaseMappingListeners();
    assert.equal(ctx.drumInput._subs.length, 0);
    assert.equal(ctx.__test._mappingListenerCount, 0);
    ctx.__test._ensureMappingListeners();
    assert.equal(ctx.drumInput._subs.length, 1);
    ctx.__test._releaseMappingListeners();
    assert.equal(ctx.drumInput._subs.length, 0);
});

test('REQ-008: mapping Learn/remove controls are gone from 3D settings.html', () => {
    const html = fs.readFileSync(SETTINGS, 'utf8');
    assert.doesNotMatch(html, /rm\.type = 'button'/);
    assert.doesNotMatch(html, /Remove MIDI note '/);
    assert.doesNotMatch(html, /learn\.type = 'button'/);
    assert.doesNotMatch(html, />Learn</);
});
