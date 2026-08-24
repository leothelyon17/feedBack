'use strict';

// Contract tests for feedBack.midiDevices (INIT-003/SPEC-011).
// Mocked fetch against SPEC-009 shapes. No plugin-repo imports.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createWindow, ROOT } = require('./capabilities_test_harness');

const CAPABILITIES_JS = path.join(ROOT, 'static', 'capabilities.js');
const MIDI_INPUT_JS = path.join(ROOT, 'static', 'capabilities', 'midi-input.js');
const MIDI_DEVICES_JS = path.join(ROOT, 'static', 'capabilities', 'midi-devices.js');
const MIDI_DEVICES_SRC = fs.readFileSync(MIDI_DEVICES_JS, 'utf8');
const V3_HTML = fs.readFileSync(path.join(ROOT, 'static', 'v3', 'index.html'), 'utf8');

function deviceDoc(id, extras) {
    return Object.assign({
        id,
        name: extras && extras.name != null ? extras.name : id,
        source_id: extras && extras.source_id != null ? extras.source_id : 'web-midi::pad-1',
        device_type_id: extras && extras.device_type_id != null ? extras.device_type_id : 'alesis-strata-prime',
        family: extras && extras.family != null ? extras.family : 'drums',
        notes: extras && extras.notes ? extras.notes : {},
        input: extras && extras.input ? extras.input : { midi_channel: -1, hit_detection: false, synth_volume: 0.7 },
    }, extras && extras.rest);
}

function typeDoc(id, extras) {
    return Object.assign({
        id,
        name: extras && extras.name != null ? extras.name : id,
        family: extras && extras.family != null ? extras.family : 'drums',
        manufacturer: extras && extras.manufacturer,
        triggers: extras && extras.triggers ? extras.triggers : [
            { id: 'kick', name: 'Kick' },
            { id: 'snare', name: 'Snare', zone: 'head' },
            { id: 'snare_rim', name: 'Snare Rim', zone: 'rim' },
        ],
    }, extras && extras.rest);
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
    vm.runInContext(fs.readFileSync(MIDI_INPUT_JS, 'utf8'), context, { filename: MIDI_INPUT_JS });
    vm.runInContext(MIDI_DEVICES_SRC, context, { filename: MIDI_DEVICES_JS });
    return window;
}

function store() {
    const devices = new Map();
    const types = new Map();
    let activeDevice = null;
    const kits = new Map();

    function settingsBody() {
        const out = {};
        if (activeDevice) out.active_midi_device = activeDevice;
        return out;
    }

    return {
        devices,
        types,
        kits,
        seed(device) {
            devices.set(device.id, JSON.parse(JSON.stringify(device)));
            return device;
        },
        seedType(type) {
            types.set(type.id, JSON.parse(JSON.stringify(type)));
            return type;
        },
        seedKit(kit) {
            kits.set(kit.id, kit);
            return kit;
        },
        activate(id) {
            if (!devices.has(id)) return null;
            activeDevice = id;
            return settingsBody();
        },
        handle(method, url, body) {
            if (method === 'GET' && url === '/api/settings') return jsonOk(settingsBody());
            if (method === 'POST' && url === '/api/settings') {
                if (body && Object.prototype.hasOwnProperty.call(body, 'active_midi_device')) {
                    const next = this.activate(body.active_midi_device);
                    if (!next) return jsonErr(400, { error: 'unknown device' });
                    return jsonOk(next);
                }
                return jsonOk(settingsBody());
            }
            if (method === 'GET' && url === '/api/midi/device-types') {
                return jsonOk({
                    device_types: Array.from(types.values()).map((t) => {
                        const out = { id: t.id, name: t.name, family: t.family, triggers: t.triggers || [] };
                        if (t.manufacturer) out.manufacturer = t.manufacturer;
                        return out;
                    }),
                });
            }
            if (method === 'GET' && url === '/api/midi/devices') {
                return jsonOk({ devices: Array.from(devices.values()) });
            }
            if (method === 'POST' && url === '/api/midi/devices') {
                const saved = deviceDoc(body.id, {
                    name: body.name,
                    source_id: body.source_id || '',
                    device_type_id: body.device_type_id,
                    notes: {},
                });
                devices.set(saved.id, saved);
                return jsonOk(saved);
            }
            const noteMut = url.match(/^\/api\/midi\/devices\/([^/?#]+)\/notes\/([^/?#]+)$/);
            if (noteMut) {
                const id = decodeURIComponent(noteMut[1]);
                const midi = noteMut[2];
                const current = devices.get(id);
                if (!current) return jsonErr(404, { detail: 'unknown device' });
                if (method === 'PUT') {
                    const notes = Object.assign({}, current.notes);
                    notes[String(midi)] = body && body.piece_id;
                    current.notes = notes;
                    return jsonOk({
                        device: current,
                        mutation: { midi_note: Number(midi), operation: 'set', piece_id: body.piece_id },
                    });
                }
                if (method === 'DELETE') {
                    const notes = Object.assign({}, current.notes);
                    delete notes[String(midi)];
                    current.notes = notes;
                    return jsonOk({
                        device: current,
                        mutation: { midi_note: Number(midi), operation: 'delete', piece_id: null },
                    });
                }
            }
            const one = url.match(/^\/api\/midi\/devices\/([^/?#]+)$/);
            if (one) {
                const id = decodeURIComponent(one[1]);
                if (method === 'GET') {
                    const d = devices.get(id);
                    return d ? jsonOk(d) : jsonErr(404, { detail: 'unknown device' });
                }
                if (method === 'PUT') {
                    const prev = devices.get(id) || { id };
                    let saved;
                    if (body && !Object.prototype.hasOwnProperty.call(body, 'notes')) {
                        saved = deviceDoc(id, {
                            name: body.name || prev.name,
                            source_id: body.source_id != null ? body.source_id : prev.source_id,
                            device_type_id: body.device_type_id || prev.device_type_id,
                            notes: {},
                            input: prev.input,
                            family: body.family || prev.family,
                        });
                    } else {
                        saved = Object.assign({}, prev, body, { id });
                    }
                    devices.set(id, saved);
                    return jsonOk(saved);
                }
            }
            if (url.indexOf('/api/drums/profiles') === 0) {
                return jsonErr(500, { detail: 'midiDevices must not write profiles' });
            }
            return jsonErr(404, { detail: 'unhandled ' + method + ' ' + url });
        },
    };
}

function fresh(opts) {
    const window = createWindow();
    window.slopsmith = opts && opts.alias === 'separate' ? {} : window.feedBack;
    const db = store();
    if (opts && opts.devices) {
        for (const d of opts.devices) db.seed(d);
    }
    if (opts && opts.types) {
        for (const t of opts.types) db.seedType(t);
    } else {
        db.seedType(typeDoc('alesis-strata-prime', { name: 'Alesis Strata Prime', manufacturer: 'Alesis' }));
    }
    if (opts && opts.active) db.activate(opts.active);
    const pending = [];
    const calls = installFetch(window, (method, url, body) => {
        if (opts && opts.onFetch) {
            const override = opts.onFetch(method, url, body, calls);
            if (override) return override;
        }
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
    return { window, db, calls, pending, md: () => window.feedBack.midiDevices };
}

async function settle() {
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
    await new Promise((r) => setImmediate(r));
}

function writerUrls(calls) {
    return calls.filter((c) => c.method !== 'GET');
}

// ── ac-1 surface + only writer ──────────────────────────────────────────

test('ac-1: feedBack.midiDevices exposes list/get/save/activate', async () => {
    const { window, md } = fresh({ devices: [deviceDoc('living-room-ekit')] });
    await settle();
    const api = md();
    assert.equal(api.version, 1);
    assert.equal(typeof api.list, 'function');
    assert.equal(typeof api.get, 'function');
    assert.equal(typeof api.save, 'function');
    assert.equal(typeof api.activate, 'function');
    assert.equal(api.EVENT, 'feedback:midi-device-change');
    assert.equal(window.feedBack.midiDevices, api);
});

test('ac-1: slopsmith alias receives the same accessor when it is a distinct object', async () => {
    const { window, md } = fresh({ alias: 'separate', devices: [deviceDoc('living-room-ekit')] });
    await settle();
    assert.equal(window.slopsmith.midiDevices, md());
});

test('ac-1: list/get/save/activate only write /api/midi/devices and /api/settings', async () => {
    const living = deviceDoc('living-room-ekit');
    const { md, calls } = fresh({ devices: [living] });
    await settle();
    const listed = await md().list();
    assert.equal(listed.length, 1);
    const one = await md().get('living-room-ekit');
    assert.equal(one.id, 'living-room-ekit');
    await md().save({
        id: 'living-room-ekit',
        name: 'Living room',
        source_id: 'web-midi::pad-1',
        device_type_id: 'alesis-strata-prime',
        family: 'drums',
        notes: {},
        input: { midi_channel: 9, hit_detection: false, synth_volume: 0.5 },
    });
    await md().activate('living-room-ekit');
    const writes = writerUrls(calls);
    assert.ok(writes.length >= 2);
    for (const w of writes) {
        const ok = w.url === '/api/settings' || w.url.indexOf('/api/midi/devices') === 0;
        assert.equal(ok, true, 'unexpected write URL ' + w.method + ' ' + w.url);
        assert.equal(w.url.indexOf('/api/drums/profiles'), -1);
    }
});

test('v3 shell loads midi-devices.js after midi-input.js', () => {
    const inputAt = V3_HTML.indexOf('/static/capabilities/midi-input.js');
    const devicesAt = V3_HTML.indexOf('/static/capabilities/midi-devices.js');
    assert.ok(inputAt !== -1);
    assert.ok(devicesAt !== -1);
    assert.ok(devicesAt > inputAt);
});

test('midi-devices.js never writes /api/drums/profiles', () => {
    assert.doesNotMatch(MIDI_DEVICES_SRC, /\/api\/drums\/profiles/);
    assert.doesNotMatch(MIDI_DEVICES_SRC, /active_drum_profile/);
});

// ── ac-2 source_id logical; raw labels rejected ─────────────────────────

test('ac-2: save persists logical source_id and rejects raw port labels', async () => {
    const living = deviceDoc('living-room-ekit');
    const { md, calls } = fresh({ devices: [living] });
    await settle();
    await md().save({
        id: 'living-room-ekit',
        name: 'Living room',
        source_id: 'web-midi::pad-1',
        device_type_id: 'alesis-strata-prime',
        family: 'drums',
        notes: {},
    });
    const puts = calls.filter((c) => c.method === 'PUT' && c.url === '/api/midi/devices/living-room-ekit');
    assert.ok(puts.length >= 1);
    assert.equal(puts[puts.length - 1].body.source_id, 'web-midi::pad-1');

    const before = calls.filter((c) => c.method === 'PUT').length;
    await assert.rejects(
        () => md().save({
            id: 'living-room-ekit',
            name: 'Living room',
            source_id: 'MIDIIN2 (Alesis Strike)',
            device_type_id: 'alesis-strata-prime',
            family: 'drums',
            notes: {},
        }),
        /logical midi-input id/,
    );
    assert.equal(calls.filter((c) => c.method === 'PUT').length, before);
});

test('ac-2: create rejects a raw MIDI port label as source_id', async () => {
    const { md, calls } = fresh({ devices: [] });
    await settle();
    const before = calls.filter((c) => c.method === 'POST').length;
    await assert.rejects(
        () => md().create({
            id: 'studio-kit',
            name: 'Studio',
            source_id: 'USB MIDI Device',
            device_type_id: 'alesis-strata-prime',
        }),
        /logical midi-input id/,
    );
    assert.equal(calls.filter((c) => c.method === 'POST').length, before);
});

// ── ac-3 type change does not seed notes ────────────────────────────────

test('ac-3: type change PUT omits notes and does not seed a kit map', async () => {
    const living = deviceDoc('living-room-ekit', { notes: { 36: 'kick' } });
    const { md, calls, db } = fresh({
        devices: [living],
        types: [
            typeDoc('alesis-strata-prime'),
            typeDoc('generic-ekit', { name: 'Generic e-kit' }),
        ],
    });
    db.seedKit({ id: 'alesis-strata-prime', notes: { 36: 'kick', 38: 'snare' } });
    await settle();
    const saved = await md().save({
        id: 'living-room-ekit',
        name: 'Living room',
        source_id: 'web-midi::pad-1',
        device_type_id: 'generic-ekit',
    });
    const puts = calls.filter((c) => c.method === 'PUT' && c.url === '/api/midi/devices/living-room-ekit');
    assert.ok(puts.length >= 1);
    const last = puts[puts.length - 1].body;
    assert.equal(Object.prototype.hasOwnProperty.call(last, 'notes'), false);
    assert.equal(last.device_type_id, 'generic-ekit');
    assert.equal(JSON.stringify(saved.notes), '{}');
});

test('ac-3: create POSTs without notes (empty map, no kit seed)', async () => {
    const { md, calls } = fresh({ devices: [] });
    await settle();
    const created = await md().create({
        id: 'blank-map',
        name: 'Blank',
        source_id: 'web-midi::pad-1',
        device_type_id: 'alesis-strata-prime',
    });
    const posts = calls.filter((c) => c.method === 'POST' && c.url === '/api/midi/devices');
    assert.equal(posts.length, 1);
    assert.equal(Object.prototype.hasOwnProperty.call(posts[0].body, 'notes'), false);
    assert.equal(JSON.stringify(created.notes), '{}');
});

// ── ac-4 unmapped rows + Learn 409 no retry ─────────────────────────────

test('ac-4: mapRows keeps unmapped catalog triggers with a blank MIDI number', () => {
    const { md } = fresh({ devices: [] });
    const rows = md().mapRows(
        [
            { id: 'kick', name: 'Kick' },
            { id: 'snare', name: 'Snare', zone: 'head' },
            { id: 'snare_rim', name: 'Snare Rim', zone: 'rim' },
        ],
        { 36: 'kick' },
    );
    assert.equal(rows.length, 3);
    assert.equal(rows[0].id, 'kick');
    assert.equal(rows[0].midi, 36);
    assert.equal(rows[1].id, 'snare');
    assert.equal(rows[1].midi, null);
    assert.equal(rows[1].zone, 'head');
    assert.equal(rows[2].midi, null);
    assert.ok(rows.every((r) => r.id));
});

test('ac-4: empty notes still yields a row per trigger (no fake default map)', () => {
    const { md } = fresh({ devices: [] });
    const rows = md().mapRows(
        [{ id: 'kick', name: 'Kick' }, { id: 'snare', name: 'Snare' }],
        {},
    );
    assert.equal(rows.length, 2);
    assert.equal(rows[0].midi, null);
    assert.equal(rows[1].midi, null);
});

test('ac-4: Learn 409 does not retry (fetch call count)', async () => {
    const living = deviceDoc('living-room-ekit');
    let notePuts = 0;
    const { md } = fresh({
        devices: [living],
        onFetch(method, url) {
            if (method === 'PUT' && /\/notes\//.test(url)) {
                notePuts += 1;
                return jsonErr(409, {
                    detail: 'device notes cannot be changed while a highway session is playing or paused',
                });
            }
            return null;
        },
    });
    await settle();
    let caught;
    try {
        await md().putNote('living-room-ekit', 36, 'kick');
    } catch (err) {
        caught = err;
    }
    assert.ok(caught);
    assert.equal(caught.status, 409);
    assert.match(caught.message, /playing or paused/);
    assert.equal(notePuts, 1, '409 must not retry the Learn write');
});

test('ac-4: putNote interpolates only after catalog-id / midi floors', async () => {
    const living = deviceDoc('living-room-ekit');
    const { md, calls } = fresh({ devices: [living] });
    await settle();
    const before = calls.length;
    await assert.rejects(() => md().putNote('../etc/passwd', 36, 'kick'), /invalid device id/);
    await assert.rejects(() => md().putNote('living-room-ekit', 128, 'kick'), /midi note/);
    await assert.rejects(() => md().putNote('living-room-ekit', 36, '<img>'), /catalog trigger id/);
    await assert.rejects(() => md().putNote('living-room-ekit', 36, '__proto__'), /catalog trigger id/);
    const noteWrites = calls.slice(before).filter((c) => /\/notes\//.test(c.url));
    assert.equal(noteWrites.length, 0);
});

// ── ac-5 knobs persist on device.input ──────────────────────────────────

test('ac-5: writeInputFields PUTs channel/hit/volume on the active device input', async () => {
    const living = deviceDoc('living-room-ekit', {
        notes: { 36: 'kick' },
        input: { midi_channel: -1, hit_detection: false, synth_volume: 0.7 },
    });
    const { md, calls } = fresh({ devices: [living], active: 'living-room-ekit' });
    await settle();
    await md().writeInputFields({ midi_channel: 9, hit_detection: true, synth_volume: 0.25 });
    const puts = calls.filter((c) => c.method === 'PUT' && c.url === '/api/midi/devices/living-room-ekit');
    assert.ok(puts.length >= 1);
    const last = puts[puts.length - 1].body;
    assert.equal(last.input.midi_channel, 9);
    assert.equal(last.input.hit_detection, true);
    assert.equal(last.input.synth_volume, 0.25);
    assert.equal(last.notes['36'], 'kick');
});

test('ac-5: save of knobs never hits /api/drums/profiles', async () => {
    const living = deviceDoc('living-room-ekit');
    const { md, calls } = fresh({ devices: [living], active: 'living-room-ekit' });
    await settle();
    await md().writeInputFields({ midi_channel: 2, hit_detection: false, synth_volume: 0.8 });
    for (const c of calls) {
        assert.equal(c.url.indexOf('/api/drums/profiles'), -1);
    }
});

// ── ac-6 activate + event ───────────────────────────────────────────────

test('ac-6: activate POSTs active_midi_device and emits one device-change with device_id only', async () => {
    const living = deviceDoc('living-room-ekit', { notes: { 36: 'kick' }, name: 'Living room' });
    const { window, md, calls } = fresh({ devices: [living] });
    await settle();
    const seen = [];
    md().subscribe((d) => seen.push(d));
    const result = await md().activate('living-room-ekit');
    assert.equal(result.device_id, 'living-room-ekit');
    assert.equal(seen.length, 1);
    assert.equal(seen[0].device_id, 'living-room-ekit');
    assert.deepEqual(Object.keys(seen[0]).sort(), ['device_id']);
    assert.equal(Object.prototype.hasOwnProperty.call(seen[0], 'notes'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(seen[0], 'name'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(seen[0], 'label'), false);
    const posts = calls.filter((c) => c.method === 'POST' && c.url === '/api/settings');
    assert.equal(posts.length, 1);
    assert.equal(posts[0].body.active_midi_device, 'living-room-ekit');
    assert.equal(window.feedBack.midiDevices.hasActive(), true);
});

test('two subscribers see the same notes after activate', async () => {
    const a = deviceDoc('device-a', { notes: { 36: 'kick' } });
    const b = deviceDoc('device-b', { notes: { 38: 'snare', 42: 'hh_closed' } });
    const { window, md } = fresh({ devices: [a, b], active: 'device-a' });
    await settle();

    function consumer() {
        const seen = [];
        async function onChange(detail) {
            const resp = await window.fetch('/api/midi/devices/' + encodeURIComponent(detail.device_id));
            const device = await resp.json();
            seen.push({ device_id: detail.device_id, notes: device.notes });
        }
        window.feedBack.on(md().EVENT, (ev) => { onChange(ev.detail); });
        return { seen };
    }

    const twoD = consumer();
    const threeD = consumer();
    await md().activate('device-b');
    await settle();
    await settle();

    assert.equal(twoD.seen.length, 1);
    assert.equal(threeD.seen.length, 1);
    assert.deepEqual(twoD.seen[0].notes, threeD.seen[0].notes);
    assert.equal(twoD.seen[0].device_id, 'device-b');
    assert.equal(twoD.seen[0].notes['38'], 'snare');
});

test('never PUT notes on a profile', async () => {
    const living = deviceDoc('living-room-ekit', { notes: { 36: 'kick' } });
    const { md, calls } = fresh({ devices: [living], active: 'living-room-ekit' });
    await settle();
    await md().save({
        id: 'living-room-ekit',
        name: 'Living room',
        source_id: 'web-midi::pad-1',
        device_type_id: 'alesis-strata-prime',
        family: 'drums',
        notes: { 36: 'kick' },
        input: { midi_channel: -1, hit_detection: false, synth_volume: 0.7 },
    });
    await md().writeInputFields({ midi_channel: 1, hit_detection: true, synth_volume: 0.4 });
    await md().putNote('living-room-ekit', 38, 'snare');
    for (const c of calls) {
        assert.equal(c.url.indexOf('/api/drums/profiles'), -1);
        if (c.method === 'PUT' && c.url.indexOf('/api/drums/') === 0) {
            assert.fail('unexpected drums PUT ' + c.url);
        }
    }
});

test('save strips reserved keys on notes before PUT', async () => {
    const living = deviceDoc('living-room-ekit');
    const { md, calls } = fresh({ devices: [living] });
    await settle();
    const notes = { 36: 'kick' };
    Object.defineProperty(notes, 'constructor', { value: { name: 'Evil' }, enumerable: true });
    await md().save({
        id: 'living-room-ekit',
        name: 'Living room',
        source_id: 'web-midi::pad-1',
        device_type_id: 'alesis-strata-prime',
        family: 'drums',
        notes,
    });
    const puts = calls.filter((c) => c.method === 'PUT');
    assert.ok(puts.length >= 1);
    const last = puts[puts.length - 1].body;
    assert.equal(Object.prototype.hasOwnProperty.call(last.notes, 'constructor'), false);
    assert.equal(last.notes['36'], 'kick');
});

test('activate last-write-wins: a stale in-flight response does not emit', async () => {
    const a = deviceDoc('device-a');
    const b = deviceDoc('device-b');
    let heldA = null;
    const { md, pending } = fresh({
        devices: [a, b],
        hold(method, url, body) {
            return method === 'POST' && url === '/api/settings' && body && body.active_midi_device === 'device-a';
        },
    });
    await settle();
    const seen = [];
    md().subscribe((d) => seen.push(d));

    const first = md().activate('device-a');
    await settle();
    assert.equal(pending.length, 1);
    heldA = pending[0];

    const second = await md().activate('device-b');
    assert.equal(second.device_id, 'device-b');
    assert.equal(seen.length, 1);
    assert.equal(seen[0].device_id, 'device-b');

    heldA.resolve();
    await first;
    await settle();
    assert.equal(seen.length, 1, 'stale activate must not emit a second event');
    assert.equal(md().getActive().id, 'device-b');
});

test('listTypes GET /api/midi/device-types does not include a notes map', async () => {
    const { md } = fresh({ devices: [] });
    await settle();
    const types = await md().listTypes();
    assert.ok(types.length >= 1);
    for (const t of types) {
        assert.equal(Object.prototype.hasOwnProperty.call(t, 'notes'), false);
        assert.ok(Array.isArray(t.triggers));
    }
});

// ── panel markup (source-scan) ──────────────────────────────────────────

test('MIDI panel table and live-region exist in the MIDI tabpanel', () => {
    const panelAt = V3_HTML.lastIndexOf('<div class="fb-tabpanel" data-tab="midi">');
    assert.ok(panelAt !== -1);
    const mountAt = V3_HTML.indexOf('id="plugin-settings-midi"', panelAt);
    const tableAt = V3_HTML.indexOf('id="midi-map-table"', panelAt);
    const liveAt = V3_HTML.indexOf('id="midi-map-status"', panelAt);
    assert.ok(tableAt > panelAt && tableAt < mountAt);
    assert.ok(liveAt > panelAt && liveAt < mountAt);
    const liveSlice = V3_HTML.slice(liveAt, liveAt + 180);
    assert.match(liveSlice, /aria-live="polite"/);
    assert.match(liveSlice, /role="status"/);
    assert.match(V3_HTML.slice(tableAt, tableAt + 500), /<tbody id="midi-map-body">/);
    assert.match(V3_HTML, /id="midi-source-picker"/);
    assert.match(V3_HTML, /id="midi-device-type"/);
    assert.match(V3_HTML, /id="midi-input-channel"/);
    assert.match(V3_HTML, /id="midi-input-hit-detect"/);
    assert.match(V3_HTML, /id="midi-input-synth-vol"/);
});

test('source picker ships empty (no fake default map or port label)', () => {
    const start = V3_HTML.indexOf('id="midi-source-picker"');
    assert.ok(start !== -1);
    const block = V3_HTML.slice(start, V3_HTML.indexOf('</select>', start) + 9);
    assert.doesNotMatch(block, /<option/);
    assert.doesNotMatch(block, /MIDIIN2/);
    assert.doesNotMatch(V3_HTML.slice(V3_HTML.indexOf('id="midi-map-body"'), V3_HTML.indexOf('id="midi-map-body"') + 80), /<tr/);
});

test('midi-devices.js never interpolates labels via innerHTML', () => {
    assert.doesNotMatch(MIDI_DEVICES_SRC, /\.innerHTML\s*=/);
    const panelSrc = fs.readFileSync(path.join(ROOT, 'static', 'v3', 'midi-devices-panel.js'), 'utf8');
    assert.doesNotMatch(panelSrc, /\.innerHTML\s*=/);
});

test('v3 shell loads midi-devices-panel.js after midi-devices.js', () => {
    const accessorAt = V3_HTML.indexOf('/static/capabilities/midi-devices.js');
    const panelAt = V3_HTML.indexOf('/static/v3/midi-devices-panel.js');
    assert.ok(accessorAt !== -1);
    assert.ok(panelAt !== -1);
    assert.ok(panelAt > accessorAt);
});

test('deleteNote DELETEs /api/midi/devices/{id}/notes/{midi}', async () => {
    const living = deviceDoc('living-room-ekit', { notes: { 36: 'kick' } });
    const { md, calls } = fresh({ devices: [living] });
    await settle();
    await md().deleteNote('living-room-ekit', 36);
    const dels = calls.filter((c) => c.method === 'DELETE' && c.url === '/api/midi/devices/living-room-ekit/notes/36');
    assert.equal(dels.length, 1);
});

test('subscribe returns an unsubscribe that stops further events', async () => {
    const living = deviceDoc('living-room-ekit');
    const { md } = fresh({ devices: [living] });
    await settle();
    const seen = [];
    const off = md().subscribe((d) => seen.push(d));
    await md().activate('living-room-ekit');
    off();
    await md().activate('living-room-ekit');
    assert.equal(seen.length, 1);
});
