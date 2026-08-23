'use strict';

// Contract tests for feedBack.drumProfiles (INIT-003/SPEC-004).
// Mocked fetch against SPEC-002 shapes. No plugin-repo imports.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createWindow, ROOT } = require('./capabilities_test_harness');

const CAPABILITIES_JS = path.join(ROOT, 'static', 'capabilities.js');
const DRUM_INPUT_JS = path.join(ROOT, 'static', 'capabilities', 'drum-input.js');
const DRUM_PROFILES_JS = path.join(ROOT, 'static', 'capabilities', 'drum-profiles.js');
const STORAGE_KEY = 'feedback_drums_input_v1';
const V3_HTML = fs.readFileSync(path.join(ROOT, 'static', 'v3', 'index.html'), 'utf8');

function profileDoc(id, extras) {
    return Object.assign({
        id,
        name: id,
        kit_id: extras && extras.kit_id != null ? extras.kit_id : 'kit-' + id,
        device: extras && extras.device ? extras.device : { source_id: 'web-midi::pad-1', enabled: false },
        input: extras && extras.input ? extras.input : { midi_channel: -1, hit_detection: false, synth_volume: 0.7 },
        highway: extras && extras.highway ? extras.highway : { '2d': { lane_preset: 'phase_shift_8' } },
    }, extras && extras.rest);
}

function kitDoc(id, notes) {
    return { id, name: id, notes: Object.assign({}, notes || { 36: 'kick' }), source: 'user' };
}

function jsonOk(body) {
    return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => JSON.parse(JSON.stringify(body)),
    });
}

function jsonErr(status, body) {
    return Promise.resolve({
        ok: false,
        status,
        json: async () => body,
    });
}

function installFetch(window, handler) {
    const calls = [];
    window.fetch = (url, opts) => {
        const method = ((opts && opts.method) || 'GET').toUpperCase();
        const body = opts && opts.body != null ? JSON.parse(opts.body) : null;
        calls.push({ method, url, body });
        return handler(method, url, body, calls);
    };
    return calls;
}

function loadModules(window) {
    const context = vm.createContext(window);
    vm.runInContext(fs.readFileSync(CAPABILITIES_JS, 'utf8'), context, { filename: CAPABILITIES_JS });
    vm.runInContext(fs.readFileSync(DRUM_INPUT_JS, 'utf8'), context, { filename: DRUM_INPUT_JS });
    vm.runInContext(fs.readFileSync(DRUM_PROFILES_JS, 'utf8'), context, { filename: DRUM_PROFILES_JS });
    return window;
}

function store() {
    const profiles = new Map();
    let activeProfile = null;
    let activeKit = '';
    const kits = new Map();

    function settingsBody() {
        const out = {};
        if (activeProfile) out.active_drum_profile = activeProfile;
        if (activeKit) out.active_kit = activeKit;
        return out;
    }

    return {
        profiles,
        kits,
        seed(profile) {
            profiles.set(profile.id, profile);
            return profile;
        },
        seedKit(kit) {
            kits.set(kit.id, kit);
            return kit;
        },
        activate(id) {
            const p = profiles.get(id);
            if (!p) return null;
            activeProfile = id;
            activeKit = p.kit_id || '';
            return settingsBody();
        },
        handle(method, url, body) {
            if (method === 'GET' && url === '/api/settings') return jsonOk(settingsBody());
            if (method === 'POST' && url === '/api/settings') {
                if (body && Object.prototype.hasOwnProperty.call(body, 'active_drum_profile')) {
                    const next = this.activate(body.active_drum_profile);
                    if (!next) return jsonErr(400, { error: 'unknown profile' });
                    return jsonOk(next);
                }
                return jsonOk(settingsBody());
            }
            if (method === 'GET' && url === '/api/drums/profiles') {
                return jsonOk({ profiles: Array.from(profiles.values()) });
            }
            const one = url.match(/^\/api\/drums\/profiles\/([^/?#]+)$/);
            if (one) {
                const id = decodeURIComponent(one[1]);
                if (method === 'GET') {
                    const p = profiles.get(id);
                    return p ? jsonOk(p) : jsonErr(404, { detail: 'unknown profile' });
                }
                if (method === 'PUT') {
                    if (body && Object.prototype.hasOwnProperty.call(body, 'notes')) {
                        return jsonErr(400, { detail: 'notes are not allowed on a profile' });
                    }
                    const saved = Object.assign({ id }, body);
                    profiles.set(id, saved);
                    return jsonOk(saved);
                }
            }
            const kit = url.match(/^\/api\/drums\/kits\/([^/?#]+)$/);
            if (kit && method === 'GET') {
                const k = kits.get(decodeURIComponent(kit[1]));
                return k ? jsonOk(k) : jsonErr(404, { detail: 'unknown kit' });
            }
            return jsonErr(404, { detail: 'unhandled ' + method + ' ' + url });
        },
    };
}

function fresh(opts) {
    const window = createWindow();
    window.slopsmith = opts && opts.alias === 'separate' ? {} : window.feedBack;
    const db = store();
    if (opts && opts.profiles) {
        for (const p of opts.profiles) db.seed(p);
    }
    if (opts && opts.kits) {
        for (const k of opts.kits) db.seedKit(k);
    }
    if (opts && opts.active) db.activate(opts.active);
    const pending = [];
    const calls = installFetch(window, (method, url, body) => {
        const result = db.handle(method, url, body);
        if (opts && opts.hold && opts.hold(method, url, body)) {
            let resolve;
            const gate = new Promise((r) => { resolve = r; });
            pending.push({ resolve, result });
            return gate.then(() => result);
        }
        return result;
    });
    loadModules(window);
    return { window, db, calls, pending, dp: () => window.feedBack.drumProfiles, di: () => window.feedBack.drumInput };
}

async function settle() {
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
    await new Promise((r) => setImmediate(r));
}

// ── surface (ac-1) ──────────────────────────────────────────────────────

test('ac-1: feedBack.drumProfiles exposes list/get/save/activate', async () => {
    const { window, dp } = fresh({ profiles: [profileDoc('living-room')] });
    await settle();
    const api = dp();
    assert.equal(api.version, 1);
    assert.equal(typeof api.list, 'function');
    assert.equal(typeof api.get, 'function');
    assert.equal(typeof api.save, 'function');
    assert.equal(typeof api.activate, 'function');
    assert.equal(api.EVENT, 'feedback:drum-profile-change');
    assert.equal(window.feedBack.drumProfiles, api);
});

test('ac-1: slopsmith alias receives the same accessor when it is a distinct object', async () => {
    const { window, dp } = fresh({ alias: 'separate', profiles: [profileDoc('living-room')] });
    await settle();
    assert.equal(window.slopsmith.drumProfiles, dp());
});

test('v3 shell loads drum-profiles.js after drum-input.js', () => {
    const inputAt = V3_HTML.indexOf('/static/capabilities/drum-input.js');
    const profilesAt = V3_HTML.indexOf('/static/capabilities/drum-profiles.js');
    assert.ok(inputAt !== -1);
    assert.ok(profilesAt !== -1);
    assert.ok(profilesAt > inputAt);
});

test('list/get round-trip SPEC-002 shapes', async () => {
    const living = profileDoc('living-room', { kit_id: 'alesis-strata-prime' });
    const { dp } = fresh({ profiles: [living] });
    await settle();
    const listed = await dp().list();
    assert.equal(listed.length, 1);
    assert.equal(listed[0].id, 'living-room');
    const one = await dp().get('living-room');
    assert.equal(one.kit_id, 'alesis-strata-prime');
});

// ── activate + event (ac-2) ─────────────────────────────────────────────

test('ac-2: activate POSTs active_drum_profile and emits one profile-change', async () => {
    const living = profileDoc('living-room', { kit_id: 'kit-living' });
    const { window, dp, calls } = fresh({ profiles: [living] });
    await settle();
    const seen = [];
    dp().subscribe((d) => seen.push(d));
    const result = await dp().activate('living-room');
    assert.equal(result.profile_id, 'living-room');
    assert.equal(result.kit_id, 'kit-living');
    assert.equal(seen.length, 1);
    assert.equal(seen[0].profile_id, 'living-room');
    assert.equal(seen[0].kit_id, 'kit-living');
    const posts = calls.filter((c) => c.method === 'POST' && c.url === '/api/settings');
    assert.equal(posts.length, 1);
    assert.equal(posts[0].body.active_drum_profile, 'living-room');
    assert.equal(window.feedBack.drumProfiles.hasActive(), true);
});

// ── drumInput persist through profile (ac-3) ────────────────────────────

test('ac-3: drumInput.update writes input/device through the active profile, not STORAGE_KEY', async () => {
    const living = profileDoc('living-room', {
        kit_id: 'kit-living',
        input: { midi_channel: 1, hit_detection: false, synth_volume: 0.5 },
        device: { source_id: 'web-midi::pad-1', enabled: false },
    });
    const { window, di, dp, calls } = fresh({ profiles: [living], active: 'living-room' });
    await settle();
    assert.equal(dp().hasActive(), true);
    window.__storage.delete(STORAGE_KEY);
    di().update({ midiChannel: 9, hitDetection: true, synthVolume: 0.25, deviceEnabled: true });
    await settle();
    assert.equal(window.__storage.has(STORAGE_KEY), false, 'no parallel localStorage persist once a profile is active');
    const puts = calls.filter((c) => c.method === 'PUT' && c.url === '/api/drums/profiles/living-room');
    assert.ok(puts.length >= 1);
    const last = puts[puts.length - 1].body;
    assert.equal(last.input.midi_channel, 9);
    assert.equal(last.input.hit_detection, true);
    assert.equal(last.input.synth_volume, 0.25);
    assert.equal(last.device.enabled, true);
    assert.equal(last.device.source_id, 'web-midi::pad-1');
    assert.equal(Object.prototype.hasOwnProperty.call(last, 'notes'), false);
});

test('ac-3: without an active profile, drumInput still dual-reads legacy keys', () => {
    const window = createWindow();
    window.__storage.set('drums_midi_ch', '4');
    window.__storage.set('drums_hit_detect', 'true');
    window.__storage.set('drums_synth_vol', '0.4');
    // No fetch → drum-profiles hydrate is a no-op; drum-input uses legacy path.
    const context = vm.createContext(window);
    vm.runInContext(fs.readFileSync(CAPABILITIES_JS, 'utf8'), context, { filename: CAPABILITIES_JS });
    vm.runInContext(fs.readFileSync(DRUM_INPUT_JS, 'utf8'), context, { filename: DRUM_INPUT_JS });
    const state = window.feedBack.drumInput.get();
    assert.equal(state.midiChannel, 4);
    assert.equal(state.hitDetection, true);
    assert.equal(state.synthVolume, 0.4);
});

test('ac-3: hydrate applies profile input onto drumInput without writing STORAGE_KEY', async () => {
    const living = profileDoc('living-room', {
        kit_id: 'kit-living',
        input: { midi_channel: 11, hit_detection: true, synth_volume: 0.15 },
        device: { source_id: 'web-midi::pad-1', enabled: true },
    });
    const { di } = fresh({ profiles: [living], active: 'living-room' });
    await settle();
    const state = di().get();
    assert.equal(state.midiChannel, 11);
    assert.equal(state.hitDetection, true);
    assert.equal(state.synthVolume, 0.15);
    assert.equal(state.deviceEnabled, true);
    // Init may have dual-read/written the legacy key before hydrate; the
    // profile is now the live read. A later update must not keep using it.
});

// ── two consumers / active_kit parity (ac-4, REQ-016) ───────────────────

test('ac-4: two consumers both see the same active_kit after activate', async () => {
    const a = profileDoc('profile-a', { kit_id: 'kit-a' });
    const b = profileDoc('profile-b', { kit_id: 'kit-b' });
    const { window, dp } = fresh({
        profiles: [a, b],
        kits: [kitDoc('kit-a', { 36: 'kick' }), kitDoc('kit-b', { 38: 'snare', 42: 'hh-closed' })],
        active: 'profile-a',
    });
    await settle();

    function consumer() {
        const seen = [];
        async function onChange(detail) {
            const settingsResp = await window.fetch('/api/settings');
            const settings = await settingsResp.json();
            const kitId = settings.active_kit;
            const kitResp = await window.fetch('/api/drums/kits/' + encodeURIComponent(kitId));
            const kit = await kitResp.json();
            seen.push({ profile_id: detail.profile_id, kit_id: kitId, notes: kit.notes });
        }
        window.feedBack.on(dp().EVENT, (ev) => { onChange(ev.detail); });
        return { seen };
    }

    const twoD = consumer();
    const threeD = consumer();
    await dp().activate('profile-b');
    await settle();
    await settle();

    assert.equal(twoD.seen.length, 1);
    assert.equal(threeD.seen.length, 1);
    assert.deepEqual(twoD.seen[0].notes, threeD.seen[0].notes);
    assert.equal(twoD.seen[0].kit_id, 'kit-b');
    assert.equal(threeD.seen[0].kit_id, 'kit-b');
    assert.equal(twoD.seen[0].notes[38], 'snare');
    assert.equal(twoD.seen[0].profile_id, 'profile-b');
});

// ── never PUT notes (ac-5) ──────────────────────────────────────────────

test('ac-5: save rejects a notes field and does not PUT', async () => {
    const living = profileDoc('living-room');
    const { dp, calls } = fresh({ profiles: [living] });
    await settle();
    const before = calls.filter((c) => c.method === 'PUT').length;
    await assert.rejects(
        () => dp().save({ id: 'living-room', name: 'Living room', kit_id: 'kit-living', notes: { 36: 'kick' } }),
        /notes are not allowed/,
    );
    const after = calls.filter((c) => c.method === 'PUT').length;
    assert.equal(after, before, 'rejected save must not hit the wire');
});

test('ac-5: a successful save body never carries notes', async () => {
    const living = profileDoc('living-room');
    const { dp, calls } = fresh({ profiles: [living] });
    await settle();
    await dp().save({
        id: 'living-room',
        name: 'Living room',
        kit_id: 'kit-living',
        device: { source_id: 'web-midi::pad-1', enabled: true },
        input: { midi_channel: 2, hit_detection: false, synth_volume: 0.8 },
    });
    const puts = calls.filter((c) => c.method === 'PUT');
    assert.ok(puts.length >= 1);
    for (const put of puts) {
        assert.equal(Object.prototype.hasOwnProperty.call(put.body, 'notes'), false);
    }
});

// ── security: logical source_id only ────────────────────────────────────

test('save strips reserved highway keys and never PUTs notes via a nested object', async () => {
    const living = profileDoc('living-room');
    const { dp, calls } = fresh({ profiles: [living] });
    await settle();
    const highway = { '2d': { lane_preset: 'phase_shift_8' } };
    Object.defineProperty(highway, 'constructor', { value: { name: 'Evil' }, enumerable: true });
    await dp().save({
        id: 'living-room',
        name: 'Living room',
        kit_id: 'kit-living',
        highway,
    });
    const puts = calls.filter((c) => c.method === 'PUT');
    assert.ok(puts.length >= 1);
    const last = puts[puts.length - 1].body;
    assert.equal(Object.prototype.hasOwnProperty.call(last, 'notes'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(last.highway, 'constructor'), false);
    assert.equal(last.highway['2d'].lane_preset, 'phase_shift_8');
});

test('save rejects a raw MIDI port label as device.source_id', async () => {
    const living = profileDoc('living-room');
    const { dp, calls } = fresh({ profiles: [living] });
    await settle();
    const before = calls.filter((c) => c.method === 'PUT').length;
    await assert.rejects(
        () => dp().save({
            id: 'living-room',
            name: 'Living room',
            kit_id: 'kit-living',
            device: { source_id: 'MIDIIN2 (Alesis Strike)', enabled: true },
        }),
        /logical midi-input id/,
    );
    assert.equal(calls.filter((c) => c.method === 'PUT').length, before);
});

// ── last-write-wins activate ────────────────────────────────────────────

test('activate last-write-wins: a stale in-flight response does not emit', async () => {
    const a = profileDoc('profile-a', { kit_id: 'kit-a' });
    const b = profileDoc('profile-b', { kit_id: 'kit-b' });
    let heldA = null;
    const { dp, pending } = fresh({
        profiles: [a, b],
        hold(method, url, body) {
            return method === 'POST' && url === '/api/settings' && body && body.active_drum_profile === 'profile-a';
        },
    });
    await settle();
    const seen = [];
    dp().subscribe((d) => seen.push(d));

    const first = dp().activate('profile-a');
    await settle();
    assert.equal(pending.length, 1);
    heldA = pending[0];

    const second = await dp().activate('profile-b');
    assert.equal(second.profile_id, 'profile-b');
    assert.equal(seen.length, 1);
    assert.equal(seen[0].profile_id, 'profile-b');

    heldA.resolve();
    await first;
    await settle();
    assert.equal(seen.length, 1, 'stale activate must not emit a second event');
    assert.equal(dp().getActive().id, 'profile-b');
});
