'use strict';

// INIT-002/SPEC-005: core-local fake 2D and 3D drum-highway consumers against
// the published version-1 drum-input contract and the atomic kit-note API
// schema. No production or test import reaches into feedBack-plugin-drums
// (GR-004).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createWindow, ROOT } = require('./capabilities_test_harness');

const CAPABILITIES_JS = path.join(ROOT, 'static', 'capabilities.js');
const DRUM_INPUT_JS = path.join(ROOT, 'static', 'capabilities', 'drum-input.js');

function loadContract() {
    const window = createWindow();
    const context = vm.createContext(window);
    vm.runInContext(fs.readFileSync(CAPABILITIES_JS, 'utf8'), context, { filename: CAPABILITIES_JS });
    vm.runInContext(fs.readFileSync(DRUM_INPUT_JS, 'utf8'), context, { filename: DRUM_INPUT_JS });
    return window;
}

function createKitApi(initialNotes) {
    const notes = Object.assign({}, initialNotes || { 36: 'kick' });
    let failNext = false;
    return {
        failNext() { failNext = true; },
        snapshot() { return Object.assign({}, notes); },
        async get() { return { id: 'user-kit', notes: Object.assign({}, notes), source: 'user' }; },
        async put(midiNote, pieceId) {
            if (failNext) {
                failNext = false;
                const err = new Error('kit mutation failed');
                err.status = 500;
                throw err;
            }
            notes[midiNote] = pieceId;
            return {
                kit: { id: 'user-kit', notes: Object.assign({}, notes), source: 'user' },
                mutation: { midi_note: midiNote, operation: 'set', piece_id: pieceId },
                resolution: { piece_id: pieceId, source: 'kit' },
            };
        },
        async delete(midiNote) {
            if (failNext) {
                failNext = false;
                const err = new Error('kit mutation failed');
                err.status = 500;
                throw err;
            }
            delete notes[midiNote];
            return {
                kit: { id: 'user-kit', notes: Object.assign({}, notes), source: 'user' },
                mutation: { midi_note: midiNote, operation: 'delete', piece_id: null },
                resolution: { piece_id: null, source: 'unmapped' },
            };
        },
    };
}

// A visualization-local fake: one subscribe owner, generation-guarded async
// refetches, API-first mutations. Mirrors the 2D/3D lifecycle contract
// without importing either highway.
function createFakeConsumer(window, kitApi, origin) {
    const di = window.feedBack.drumInput;
    let generation = 0;
    let unsub = null;
    let destroyed = true;
    let mapping = {};
    let settings = null;
    const received = [];
    const pending = [];

    async function refetch(gen) {
        const kit = await kitApi.get();
        if (destroyed || gen !== generation) return;
        mapping = Object.assign({}, kit.notes);
    }

    function onChange(detail) {
        if (destroyed) return;
        const gen = generation;
        received.push(detail);
        if (detail && detail.mutation) {
            const work = refetch(gen);
            pending.push(work);
            return work;
        }
        if (detail && Array.isArray(detail.changedKeys) && detail.changedKeys.length) {
            if (destroyed || gen !== generation) return;
            settings = di.get();
        }
    }

    return {
        origin,
        get mapping() { return Object.assign({}, mapping); },
        get settings() { return settings; },
        get received() { return received.slice(); },
        init() {
            destroyed = false;
            generation += 1;
            settings = di.get();
            unsub = di.subscribe(onChange);
            return refetch(generation);
        },
        destroy() {
            destroyed = true;
            generation += 1;
            if (unsub) {
                unsub();
                unsub = null;
            }
        },
        async mutate(midiNote, pieceId) {
            const prior = Object.assign({}, mapping);
            try {
                const body = await kitApi.put(midiNote, pieceId);
                mapping = Object.assign({}, body.kit.notes);
                di.notifyMappingChange({
                    kitId: 'user-kit',
                    mutation: 'set',
                    midiNote,
                });
                return body;
            } catch (err) {
                mapping = prior;
                throw err;
            }
        },
        flush() { return Promise.all(pending.slice()); },
        startDelayedRefetch() {
            const gen = generation;
            let resolve;
            const promise = new Promise((res) => { resolve = res; });
            pending.push(promise.then(() => refetch(gen)));
            return {
                resolve: () => { resolve(); return promise.then(() => refetch(gen)); },
            };
        },
    };
}

function wrapSubscribe(window) {
    const di = window.feedBack.drumInput;
    let live = 0;
    const original = di.subscribe.bind(di);
    di.subscribe = (fn) => {
        live += 1;
        const off = original(fn);
        return function unsubscribe() {
            live -= 1;
            return off();
        };
    };
    return () => live;
}

test('REQ-002: a 2D mapping mutation is observed once by the 3D fake consumer', async () => {
    const window = loadContract();
    const kitApi = createKitApi({ 36: 'kick' });
    const twoD = createFakeConsumer(window, kitApi, '2d');
    const threeD = createFakeConsumer(window, kitApi, '3d');
    await twoD.init();
    await threeD.init();
    await twoD.mutate(38, 'snare');
    await threeD.flush();
    assert.equal(threeD.received.length, 1);
    assert.equal(threeD.received[0].version, 1);
    assert.equal(threeD.received[0].mutation, 'set');
    assert.equal(threeD.received[0].midiNote, 38);
    assert.equal(threeD.received[0].kitId, 'user-kit');
    assert.equal(threeD.mapping[38], 'snare');
    assert.equal(twoD.mapping[38], 'snare');
});

test('REQ-002: a 3D mapping mutation is observed once by the 2D fake consumer', async () => {
    const window = loadContract();
    const kitApi = createKitApi({ 36: 'kick' });
    const twoD = createFakeConsumer(window, kitApi, '2d');
    const threeD = createFakeConsumer(window, kitApi, '3d');
    await twoD.init();
    await threeD.init();
    await threeD.mutate(24, 'kick');
    await twoD.flush();
    assert.equal(twoD.received.length, 1);
    assert.equal(twoD.received[0].mutation, 'set');
    assert.equal(twoD.received[0].midiNote, 24);
    assert.equal(twoD.mapping[24], 'kick');
    assert.equal(threeD.mapping[24], 'kick');
});

test('REQ-005: a 2D settings write is observed once by the 3D fake consumer', () => {
    const window = loadContract();
    const kitApi = createKitApi();
    const twoD = createFakeConsumer(window, kitApi, '2d');
    const threeD = createFakeConsumer(window, kitApi, '3d');
    twoD.init();
    threeD.init();
    window.feedBack.drumInput.update({ midiChannel: 9, hitDetection: true, synthVolume: 0.4 });
    assert.equal(threeD.received.length, 1);
    assert.equal(threeD.received[0].version, 1);
    assert.equal(
        JSON.parse(JSON.stringify(threeD.received[0].changedKeys)).sort().join(','),
        'hitDetection,midiChannel,synthVolume',
    );
    assert.equal(threeD.settings.midiChannel, 9);
    assert.equal(threeD.settings.hitDetection, true);
    assert.equal(threeD.settings.synthVolume, 0.4);
    assert.equal(twoD.settings.midiChannel, 9);
});

test('REQ-005: a 3D settings write is observed once by the 2D fake consumer', () => {
    const window = loadContract();
    const kitApi = createKitApi();
    const twoD = createFakeConsumer(window, kitApi, '2d');
    const threeD = createFakeConsumer(window, kitApi, '3d');
    twoD.init();
    threeD.init();
    window.feedBack.drumInput.update({ deviceEnabled: true, midiChannel: 2 });
    assert.equal(twoD.received.length, 1);
    assert.equal(twoD.settings.deviceEnabled, true);
    assert.equal(twoD.settings.midiChannel, 2);
    assert.equal(threeD.settings.deviceEnabled, true);
});

test('REQ-002: a failed API mutation leaves both fake consumers on the prior mapping', async () => {
    const window = loadContract();
    const kitApi = createKitApi({ 36: 'kick' });
    const twoD = createFakeConsumer(window, kitApi, '2d');
    const threeD = createFakeConsumer(window, kitApi, '3d');
    await twoD.init();
    await threeD.init();
    kitApi.failNext();
    await assert.rejects(() => twoD.mutate(38, 'snare'));
    await threeD.flush();
    assert.equal(twoD.mapping[36], 'kick');
    assert.equal(twoD.mapping[38], undefined);
    assert.equal(threeD.mapping[36], 'kick');
    assert.equal(threeD.mapping[38], undefined);
    assert.equal(threeD.received.length, 0, 'failure must not emit a mapping change');
    assert.deepEqual(kitApi.snapshot(), { 36: 'kick' });
});

test('REQ-009: switching 2D ↔ 3D returns subscriber counts to baseline', async () => {
    const window = loadContract();
    const liveCount = wrapSubscribe(window);
    const kitApi = createKitApi();
    const twoD = createFakeConsumer(window, kitApi, '2d');
    const threeD = createFakeConsumer(window, kitApi, '3d');
    assert.equal(liveCount(), 0, 'baseline before any highway is mounted');
    for (let i = 0; i < 5; i += 1) {
        await twoD.init();
        assert.equal(liveCount(), 1, `cycle ${i}: 2D owns one subscription`);
        twoD.destroy();
        assert.equal(liveCount(), 0, `cycle ${i}: 2D destroy returns to baseline`);
        await threeD.init();
        assert.equal(liveCount(), 1, `cycle ${i}: 3D owns one subscription`);
        threeD.destroy();
        assert.equal(liveCount(), 0, `cycle ${i}: 3D destroy returns to baseline`);
    }
});

test('REQ-009: a delayed update from the deselected viz cannot overwrite current state', async () => {
    const window = loadContract();
    const kitApi = createKitApi({ 36: 'kick' });
    const twoD = createFakeConsumer(window, kitApi, '2d');
    const threeD = createFakeConsumer(window, kitApi, '3d');
    await twoD.init();
    const delayed = twoD.startDelayedRefetch();
    twoD.destroy();
    await kitApi.put(38, 'snare');
    await threeD.init();
    assert.equal(threeD.mapping[38], 'snare');
    await delayed.resolve();
    assert.equal(twoD.mapping[38], undefined, 'destroyed 2D overlay stays frozen');
    assert.equal(threeD.mapping[38], 'snare', 'active 3D overlay is unchanged by the stale 2D refetch');
    window.feedBack.drumInput.update({ midiChannel: 4 });
    assert.equal(twoD.settings.midiChannel, -1, 'destroyed 2D ignores later settings');
    assert.equal(threeD.settings.midiChannel, 4);
});
