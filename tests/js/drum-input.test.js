'use strict';

// Contract tests for the shared drum MIDI-input/settings capability
// (static/capabilities/drum-input.js — INIT-002/SPEC-002). Runs the real
// module in a vm sandbox with a local fake storage/event-target/clock and,
// where a "second tab" is needed, a second independent sandbox sharing the
// same fake storage backing. No cross-repository imports (GR-004).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createWindow, ROOT } = require('./capabilities_test_harness');

const CAPABILITIES_JS = path.join(ROOT, 'static', 'capabilities.js');
const DRUM_INPUT_JS = path.join(ROOT, 'static', 'capabilities', 'drum-input.js');
const STORAGE_KEY = 'feedback_drums_input_v1';

function loadInto(window) {
    const context = vm.createContext(window);
    vm.runInContext(fs.readFileSync(CAPABILITIES_JS, 'utf8'), context, { filename: CAPABILITIES_JS });
    vm.runInContext(fs.readFileSync(DRUM_INPUT_JS, 'utf8'), context, { filename: DRUM_INPUT_JS });
    return window;
}

// A fresh "tab": a brand-new window/context, optionally seeded from another
// tab's storage backing (simulating a page (re)load that shares the same
// browser-level localStorage).
function freshTab(seedFromWindow) {
    const window = createWindow();
    if (seedFromWindow) {
        for (const [k, v] of seedFromWindow.__storage.entries()) window.__storage.set(k, v);
    }
    return loadInto(window);
}

// Relays a real cross-tab localStorage write from `fromWindow` into
// `toWindow`: mirrors the browser's shared storage (the key's new value is
// now visible from `toWindow.localStorage` too) AND fires the `storage`
// event `toWindow` would receive (real browsers never fire it on the
// writing tab itself, so this only ever targets a DIFFERENT window).
function relay(fromWindow, toWindow, key) {
    const newValue = fromWindow.__storage.has(key) ? fromWindow.__storage.get(key) : null;
    const oldValue = toWindow.__storage.has(key) ? toWindow.__storage.get(key) : null;
    if (newValue == null) toWindow.__storage.delete(key);
    else toWindow.__storage.set(key, newValue);
    toWindow.dispatchEvent({ type: 'storage', key, newValue, oldValue });
}

function di(window) { return window.feedBack.drumInput; }

// ── basics ───────────────────────────────────────────────────────────────

test('fresh storage yields the documented defaults and a version-1 record', () => {
    const window = freshTab();
    const state = di(window).get();
    assert.equal(state.version, 1);
    assert.equal(state.deviceEnabled, false);
    assert.equal(state.midiChannel, -1);
    assert.equal(state.hitDetection, false);
    assert.equal(state.synthVolume, 0.7);
    assert.ok(state.revision && Number.isFinite(state.revision.clock));
});

test('a setting update is returned identically to two independent consumers (REQ-005)', () => {
    const window = freshTab();
    const consumerA = di(window);
    const consumerB = di(window); // e.g. the 2D and 3D highways both read the same shared global
    consumerA.update({ synthVolume: 0.42, midiChannel: 9 });
    assert.deepEqual(consumerA.get(), consumerB.get());
    assert.equal(consumerB.get().synthVolume, 0.42);
    assert.equal(consumerB.get().midiChannel, 9);
});

test('update() clamps/validates and ignores unknown fields', () => {
    const window = freshTab();
    const state = di(window).update({ midiChannel: 99, synthVolume: -3, hitDetection: 'yes', bogus: 'x' });
    assert.equal(state.midiChannel, 15, 'channel clamps to the 0-15 MIDI range ceiling');
    assert.equal(state.synthVolume, 0, 'volume clamps to 0..1');
    assert.equal(state.hitDetection, false, 'non-boolean input is ignored, prior value kept');
});

test('a no-op update (values unchanged) does not bump the revision or emit', () => {
    const window = freshTab();
    let calls = 0;
    di(window).subscribe(() => { calls += 1; });
    const before = di(window).get();
    const after = di(window).update({ midiChannel: before.midiChannel });
    assert.deepEqual(after.revision, before.revision);
    assert.equal(calls, 0);
});

// ── same-tab live updates (REQ-002) ─────────────────────────────────────

test('same-tab subscribers receive exactly one version-1 change record per update', () => {
    const window = freshTab();
    const recordsA = [];
    const recordsB = [];
    di(window).subscribe((d) => recordsA.push(d));
    di(window).subscribe((d) => recordsB.push(d));
    di(window).update({ hitDetection: true });
    assert.equal(recordsA.length, 1);
    assert.equal(recordsB.length, 1);
    assert.deepEqual(recordsA[0], recordsB[0]);
    assert.equal(recordsA[0].version, 1);
    assert.equal(recordsA[0].changedKeys.length, 1);
    assert.equal(recordsA[0].changedKeys[0], 'hitDetection');
    assert.equal(recordsA[0].kitId, null);
    assert.equal(recordsA[0].mutation, null);
    assert.equal(recordsA[0].midiNote, null);
});

test('changedKeys lists only the fields that actually changed', () => {
    const window = freshTab();
    const records = [];
    di(window).subscribe((d) => records.push(d));
    di(window).update({ synthVolume: 0.7, midiChannel: 3 }); // synthVolume === default → unchanged
    assert.equal(records[0].changedKeys.length, 1);
    assert.equal(records[0].changedKeys[0], 'midiChannel');
});

// ── subscribe/unsubscribe lifecycle (REQ-009) ───────────────────────────

test('subscribe() cleanup stops further delivery; repeated subscribe/unsubscribe returns to baseline', () => {
    const window = freshTab();
    let calls = 0;
    const unsubscribe = di(window).subscribe(() => { calls += 1; });
    di(window).update({ midiChannel: 1 });
    assert.equal(calls, 1);
    unsubscribe();
    di(window).update({ midiChannel: 2 });
    assert.equal(calls, 1, 'no further delivery after cleanup');

    // Repeat subscribe/unsubscribe several times — each cycle must return to
    // the same observable baseline (one call per update while subscribed,
    // zero once cleaned up), i.e. no listener leaks across cycles.
    for (let i = 0; i < 5; i += 1) {
        const cleanup = di(window).subscribe(() => { calls += 1; });
        di(window).update({ midiChannel: i + 3 });
        assert.equal(calls, 2 + i, `cycle ${i}: exactly one delivery while subscribed`);
        cleanup();
        di(window).update({ midiChannel: i + 30 });
        assert.equal(calls, 2 + i, `cycle ${i}: no delivery after cleanup`);
    }
});

test('unsubscribe(fn) removes one matching registration; duplicate subscriptions do not leak', () => {
    const window = freshTab();
    let calls = 0;
    const handler = () => { calls += 1; };
    di(window).subscribe(handler);
    di(window).subscribe(handler); // same fn registered twice, independently
    di(window).update({ midiChannel: 1 });
    assert.equal(calls, 2, 'two independent registrations both fire');
    assert.equal(di(window).unsubscribe(handler), true, 'removes the first still-active registration');
    di(window).update({ midiChannel: 2 });
    assert.equal(calls, 3, 'one registration remains after removing one of two');
    assert.equal(di(window).unsubscribe(handler), true);
    di(window).update({ midiChannel: 3 });
    assert.equal(calls, 3, 'baseline restored: no registrations remain');
    assert.equal(di(window).unsubscribe(handler), false, 'nothing left to remove');
});

// ── mapping-change notification (does not persist settings) ────────────

test('notifyMappingChange re-broadcasts without persisting or bumping the settings revision', () => {
    const window = freshTab();
    const records = [];
    di(window).subscribe((d) => records.push(d));
    const before = di(window).get();
    const rawBefore = window.__storage.get(STORAGE_KEY);

    const result = di(window).notifyMappingChange({ kitId: 'kit-1', mutation: 'set', midiNote: 38 });

    assert.equal(records.length, 1);
    assert.deepEqual(records[0], result);
    assert.equal(result.kitId, 'kit-1');
    assert.equal(result.mutation, 'set');
    assert.equal(result.midiNote, 38);
    assert.equal(result.changedKeys.length, 0);
    assert.equal(window.__storage.get(STORAGE_KEY), rawBefore, 'settings storage untouched by a mapping notification');
    assert.deepEqual(di(window).get(), before, 'settings state untouched by a mapping notification');
});

test('notifyMappingChange fixture: a delete-mutation notification carries the same shape as set', () => {
    const window = freshTab();
    const records = [];
    di(window).subscribe((d) => records.push(d));
    const result = di(window).notifyMappingChange({ kitId: 'kit-1', mutation: 'delete', midiNote: 38 });
    assert.equal(records.length, 1);
    assert.equal(result.mutation, 'delete');
    assert.equal(result.kitId, 'kit-1');
    assert.equal(result.midiNote, 38);
    assert.equal(result.changedKeys.length, 0);
});

test('notifyMappingChange rejects an unknown mutation and coerces a non-numeric note to null', () => {
    const window = freshTab();
    const result = di(window).notifyMappingChange({ kitId: 'k', mutation: 'wipe', midiNote: 'not-a-note' });
    assert.equal(result.mutation, null);
    assert.equal(result.midiNote, null);
});

// ── cross-tab sync (REQ-002) ─────────────────────────────────────────────

test('a newer cross-tab storage write refreshes state without an event loop', () => {
    const tabA = freshTab();
    const tabB = freshTab(tabA); // same starting storage, independent module instance
    const recordsB = [];
    di(tabB).subscribe((d) => recordsB.push(d));

    di(tabA).update({ synthVolume: 0.33 });
    relay(tabA, tabB, STORAGE_KEY);

    assert.equal(di(tabB).get().synthVolume, 0.33, 'B adopted A\'s newer write');
    assert.equal(recordsB.length, 1, 'exactly one change record delivered to B\'s subscribers');
    assert.equal(recordsB[0].changedKeys.length, 1);
    assert.equal(recordsB[0].changedKeys[0], 'synthVolume');

    // Receiving a cross-tab update must not itself write storage (that would
    // risk an echo/loop back to other tabs). Prove it on a SECOND, genuinely
    // newer relay so the event is actually applied, not just ignored as
    // stale/duplicate.
    let setItemCalls = 0;
    const originalSetItem = tabB.localStorage.setItem.bind(tabB.localStorage);
    tabB.localStorage.setItem = (...args) => { setItemCalls += 1; return originalSetItem(...args); };
    di(tabA).update({ synthVolume: 0.77 });
    relay(tabA, tabB, STORAGE_KEY);
    assert.equal(di(tabB).get().synthVolume, 0.77, 'the second, genuinely newer relay was applied');
    assert.equal(setItemCalls, 0, 'processing an applied storage event never writes storage itself');
});

test('a stale (older) cross-tab write is ignored', () => {
    const tabA = freshTab();
    const tabB = freshTab(tabA);
    di(tabA).update({ synthVolume: 0.1 }); // tabA now ahead of tabB
    const staleRaw = tabB.__storage.get(STORAGE_KEY); // tabB's own (older) record
    di(tabA).update({ synthVolume: 0.9 }); // tabA advances again
    relay(tabA, tabB, STORAGE_KEY);
    assert.equal(di(tabB).get().synthVolume, 0.9, 'tabB adopted the newer write first');

    // Now replay the STALE record directly at tabB — it must be ignored.
    tabB.dispatchEvent({ type: 'storage', key: STORAGE_KEY, newValue: staleRaw, oldValue: null });
    assert.equal(di(tabB).get().synthVolume, 0.9, 'stale record did not overwrite the newer state');
});

test('a self-origin echo is ignored (defensive — real browsers never deliver this)', () => {
    const window = freshTab();
    const seen = [];
    di(window).subscribe((d) => seen.push(d));
    di(window).update({ synthVolume: 0.55 });
    const myOrigin = seen[0].origin;

    const echoRecord = JSON.stringify({
        version: 1,
        revision: { clock: seen[0].revision.clock + 1000, origin: myOrigin, sequence: 999 },
        deviceEnabled: true, midiChannel: 5, hitDetection: true, synthVolume: 0.01,
    });
    window.dispatchEvent({ type: 'storage', key: STORAGE_KEY, newValue: echoRecord, oldValue: null });
    assert.equal(di(window).get().synthVolume, 0.55, 'a record carrying our own origin is never adopted');
    assert.equal(seen.length, 1, 'no extra change record delivered from the ignored echo');
});

test('equal-clock concurrent writes converge deterministically via the origin/sequence tie-break', () => {
    const tabA = freshTab();
    const tabB = freshTab(tabA);
    const FIXED_CLOCK = Date.now() + 1e9; // far enough ahead that both tabs' max(now, prior+1) picks it
    // `vm.createContext(window)` contextifies `window` in place, so `window`
    // IS the context object `vm.runInContext` needs — patch only the `.now`
    // static (via a script run IN that context) so `Date` stays a real
    // constructor there (capabilities.js schedules a `new Date()` microtask
    // fallback that would otherwise throw once the test ends).
    vm.runInContext(`Date.now = () => ${FIXED_CLOCK};`, tabA);
    vm.runInContext(`Date.now = () => ${FIXED_CLOCK};`, tabB);

    const recA = [];
    const recB = [];
    di(tabA).subscribe((d) => recA.push(d));
    di(tabB).subscribe((d) => recB.push(d));
    di(tabA).update({ synthVolume: 0.2 }); // concurrent, neither has seen the other yet
    di(tabB).update({ synthVolume: 0.8 });

    const originA = recA[0].revision.origin;
    const originB = recB[0].revision.origin;
    assert.notEqual(originA, originB);
    assert.equal(recA[0].revision.clock, FIXED_CLOCK);
    assert.equal(recB[0].revision.clock, FIXED_CLOCK);

    // Snapshot each tab's own write BEFORE relaying — `relay()` also mirrors
    // the shared storage backing (as a real browser's shared localStorage
    // would), so reading `tabB.__storage` again after the first relay would
    // see tabA's just-arrived value instead of tabB's original concurrent
    // write, corrupting the "truly concurrent" scenario this test wants.
    const rawA = tabA.__storage.get(STORAGE_KEY);
    const rawB = tabB.__storage.get(STORAGE_KEY);
    tabB.__storage.set(STORAGE_KEY, rawA);
    tabB.dispatchEvent({ type: 'storage', key: STORAGE_KEY, newValue: rawA, oldValue: rawB });
    tabA.__storage.set(STORAGE_KEY, rawB);
    tabA.dispatchEvent({ type: 'storage', key: STORAGE_KEY, newValue: rawB, oldValue: rawA });

    const expectWinnerIsA = originA > originB;
    const expectedVolume = expectWinnerIsA ? 0.2 : 0.8;
    assert.equal(di(tabA).get().synthVolume, expectedVolume, 'tabA converged on the deterministic winner');
    assert.equal(di(tabB).get().synthVolume, expectedVolume, 'tabB converged on the same deterministic winner');
    // tabA and tabB are separate vm realms — compare the revision fields
    // individually rather than via deepEqual (structurally-equal-but-
    // cross-realm objects aren't reference-equal, which Node's strict
    // deepEqual treats as a mismatch).
    const revA = di(tabA).get().revision;
    const revB = di(tabB).get().revision;
    assert.equal(revA.clock, revB.clock, 'both tabs agree on the winning clock');
    assert.equal(revA.origin, revB.origin, 'both tabs agree on the winning origin');
    assert.equal(revA.sequence, revB.sequence, 'both tabs agree on the winning sequence');
});

// ── explicit "None" / disabled semantics (REQ-005) ──────────────────────

test('an explicit deviceEnabled:false persists across reload even with a selected domain source', () => {
    const tabA = freshTab();
    di(tabA).update({ deviceEnabled: false });
    assert.equal(di(tabA).get().deviceEnabled, false);

    // Simulate "a selected domain source exists" — feedBack.midiInput reports
    // a selection — on a fresh reload sharing the same storage. The contract
    // must not read through to midiInput to auto re-enable itself.
    const tabB = createWindow();
    for (const [k, v] of tabA.__storage.entries()) tabB.__storage.set(k, v);
    tabB.feedBack.midiInput = { version: 1, getSelected: () => 'web-midi::dev1' };
    loadInto(tabB);
    assert.equal(di(tabB).get().deviceEnabled, false, 'explicit disable survives reload despite a selected source');
});

// ── migration precedence: canonical, 2D legacy, drum_h3d_midi_pick_v2,
//    drum_h3d_midi_input, default (fixed order per the initiative doc) ──

test('missing canonical storage migrates every field from 2D legacy keys', () => {
    const window = createWindow();
    window.__storage.set('drums_midi_input', 'some-device-id'); // non-empty → deviceEnabled: true
    window.__storage.set('drums_midi_ch', '9');
    window.__storage.set('drums_hit_detect', 'true');
    window.__storage.set('drums_synth_vol', '0.55');
    loadInto(window);
    const state = di(window).get();
    assert.equal(state.deviceEnabled, true);
    assert.equal(state.midiChannel, 9);
    assert.equal(state.hitDetection, true);
    assert.equal(state.synthVolume, 0.55);
    // And the migration is persisted so the next load reads canonical directly.
    assert.ok(window.__storage.get(STORAGE_KEY));
});

test('an explicit empty 2D device id migrates to deviceEnabled:false', () => {
    const window = createWindow();
    window.__storage.set('drums_midi_input', '');
    loadInto(window);
    assert.equal(di(window).get().deviceEnabled, false);
});

test('with no 2D keys, migration falls through to drum_h3d_midi_pick_v2', () => {
    const window = createWindow();
    window.__storage.set('drum_h3d_midi_pick_v2', JSON.stringify({
        deviceEnabled: true, midiChannel: 2, hitDetection: true, synthVolume: 0.3,
    }));
    loadInto(window);
    const state = di(window).get();
    assert.equal(state.deviceEnabled, true);
    assert.equal(state.midiChannel, 2);
    assert.equal(state.hitDetection, true);
    assert.equal(state.synthVolume, 0.3);
});

test('with no 2D keys and no usable drum_h3d_midi_pick_v2, migration falls through to drum_h3d_midi_input', () => {
    const window = createWindow();
    window.__storage.set('drum_h3d_midi_input', 'a-3d-device-id');
    loadInto(window);
    const state = di(window).get();
    assert.equal(state.deviceEnabled, true, 'a non-empty 3D legacy device id implies it was enabled');
    assert.equal(state.midiChannel, -1, 'no source had a channel value → default');
});

test('per-field precedence: a field missing from an otherwise-valid canonical record migrates independently', () => {
    const window = createWindow();
    // Canonical record with synthVolume OMITTED entirely (simulates partial corruption / an older writer).
    window.__storage.set(STORAGE_KEY, JSON.stringify({
        version: 1,
        revision: { clock: 100, origin: 'other-tab', sequence: 1 },
        deviceEnabled: true, midiChannel: 4, hitDetection: true,
        // synthVolume intentionally absent
    }));
    window.__storage.set('drums_synth_vol', '0.66'); // 2D legacy is the next precedence step
    loadInto(window);
    const state = di(window).get();
    assert.equal(state.deviceEnabled, true, 'valid canonical fields are kept as-is');
    assert.equal(state.midiChannel, 4);
    assert.equal(state.hitDetection, true);
    assert.equal(state.synthVolume, 0.66, 'the one missing field migrated from the next precedence source');
});

test('an out-of-range canonical field falls through to legacy for that field only', () => {
    const window = createWindow();
    window.__storage.set(STORAGE_KEY, JSON.stringify({
        version: 1,
        revision: { clock: 100, origin: 'other-tab', sequence: 1 },
        deviceEnabled: true, midiChannel: 'not-a-number', hitDetection: false, synthVolume: 0.5,
    }));
    window.__storage.set('drums_midi_ch', '7');
    loadInto(window);
    assert.equal(di(window).get().midiChannel, 7);
    assert.equal(di(window).get().synthVolume, 0.5, 'the still-valid canonical field is untouched');
});

test('corrupt (unparseable) canonical JSON is treated as fully absent, not a crash', () => {
    const window = createWindow();
    window.__storage.set(STORAGE_KEY, '{not-json');
    window.__storage.set('drums_midi_ch', '3');
    loadInto(window);
    const state = di(window).get();
    assert.equal(state.midiChannel, 3, 'migrated from 2D legacy despite corrupt canonical JSON');
    assert.equal(state.synthVolume, 0.7, 'default for a field with no usable source anywhere');
});

test('missing/corrupt storage everywhere gracefully yields defaults', () => {
    const window = createWindow();
    window.__storage.set('drum_h3d_midi_pick_v2', 'not json either');
    loadInto(window);
    const state = di(window).get();
    assert.equal(state.deviceEnabled, false);
    assert.equal(state.midiChannel, -1);
    assert.equal(state.hitDetection, false);
    assert.equal(state.synthVolume, 0.7);
});

// ── bounded dual writes (GR-005) ────────────────────────────────────────

test('an update dual-writes every owned field to both surfaces\' legacy keys, and never touches device-identity keys', () => {
    const window = freshTab();
    window.__storage.set('drums_midi_input', 'kept-as-is');
    window.__storage.set('drum_h3d_midi_input', 'also-kept-as-is');
    di(window).update({ midiChannel: 6, hitDetection: true, synthVolume: 0.25, deviceEnabled: true });

    assert.equal(window.__storage.get('drums_midi_ch'), '6');
    assert.equal(window.__storage.get('drums_hit_detect'), 'true');
    assert.equal(window.__storage.get('drums_synth_vol'), '0.25');
    const pick = JSON.parse(window.__storage.get('drum_h3d_midi_pick_v2'));
    assert.deepEqual(pick, { deviceEnabled: true, midiChannel: 6, hitDetection: true, synthVolume: 0.25 });

    // Device identity is never this module's to write.
    assert.equal(window.__storage.get('drums_midi_input'), 'kept-as-is');
    assert.equal(window.__storage.get('drum_h3d_midi_input'), 'also-kept-as-is');
});
