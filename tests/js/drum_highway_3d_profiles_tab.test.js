'use strict';

// INIT-003/SPEC-006: 3D Drums category split + drumProfiles consume.
// Source-scan + vm harness (no jsdom / WebGL).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const PLUGIN_JSON = path.join(REPO_ROOT, 'plugins', 'drum_highway_3d', 'plugin.json');
const SETTINGS = path.join(REPO_ROOT, 'plugins', 'drum_highway_3d', 'settings.html');
const GRAPHICS = path.join(REPO_ROOT, 'plugins', 'drum_highway_3d', 'assets', 'settings-graphics.html');
const SCREEN = path.join(REPO_ROOT, 'plugins', 'drum_highway_3d', 'screen.js');
const LOADER_JS = fs.readFileSync(path.join(REPO_ROOT, 'static', 'js', 'plugin-loader.js'), 'utf8');
const SETTINGS_JS = fs.readFileSync(path.join(REPO_ROOT, 'static', 'v3', 'settings.js'), 'utf8');

function jsonOk(body) {
    return { ok: true, json: async () => body, text: async () => JSON.stringify(body) };
}
function jsonFail() {
    return { ok: false, json: async () => ({ error: 'fail' }), text: async () => '' };
}

function makeDrumInput() {
    const subs = [];
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
        notifyMappingChange() { return {}; },
        _subs: subs,
    };
}

function makeDrumProfiles(opts) {
    const profiles = (opts && opts.profiles) || [
        { id: 'living-room', name: 'Living room', kit_id: 'kit-living', device_id: 'living-ekit' },
        { id: 'practice', name: 'Practice', kit_id: 'kit-practice', device_id: 'practice-ekit' },
    ];
    let activeId = (opts && opts.activeId) || 'living-room';
    const saves = [];
    const activates = [];
    const subs = [];
    const api = {
        version: 1,
        EVENT: 'feedback:drum-profile-change',
        hasActive() { return !!activeId; },
        getActive() {
            return profiles.find((p) => p.id === activeId) || (activeId ? { id: activeId } : null);
        },
        async list() { return profiles.slice(); },
        async save(profile) {
            if (profile && Object.prototype.hasOwnProperty.call(profile, 'notes')) {
                throw new Error('notes are not allowed on a profile');
            }
            saves.push(profile);
            const idx = profiles.findIndex((p) => p.id === profile.id);
            if (idx >= 0) profiles[idx] = Object.assign({}, profiles[idx], profile);
            return profile;
        },
        async activate(id) {
            activates.push(id);
            activeId = id;
            const p = profiles.find((x) => x.id === id) || { id, kit_id: '', device_id: '' };
            const detail = {
                version: 1,
                profile_id: id,
                kit_id: p.kit_id || '',
                device_id: p.device_id || '',
            };
            for (const fn of subs.slice()) fn(detail);
            return { profile_id: id, kit_id: p.kit_id || '', device_id: p.device_id || '', profile: p, detail };
        },
        subscribe(fn) {
            if (typeof fn !== 'function') return function noop() {};
            subs.push(fn);
            return function unsub() {
                const i = subs.indexOf(fn);
                if (i >= 0) subs.splice(i, 1);
            };
        },
        _saves: saves,
        _activates: activates,
        _subs: subs,
    };
    return api;
}

function makeMidiDevices(opts) {
    const devices = Object.assign({}, (opts && opts.devices) || {});
    const gets = [];
    const subs = [];
    const api = {
        version: 1,
        EVENT: 'feedback:midi-device-change',
        async get(id) {
            gets.push(String(id));
            const d = devices[id];
            if (!d) {
                const err = new Error('missing device');
                throw err;
            }
            return { id: d.id, notes: Object.assign({}, d.notes || {}) };
        },
        getActive() {
            const id = opts && opts.activeId;
            return id && devices[id] ? devices[id] : null;
        },
        subscribe(fn) {
            if (typeof fn !== 'function') return function noop() {};
            subs.push(fn);
            return function unsub() {
                const i = subs.indexOf(fn);
                if (i >= 0) subs.splice(i, 1);
            };
        },
        _gets: gets,
        _subs: subs,
        _setNotes(id, notes) {
            devices[id] = Object.assign({}, devices[id] || { id }, { notes: Object.assign({}, notes) });
        },
        _emit(detail) { for (const fn of subs.slice()) fn(detail); },
    };
    return api;
}

function load(opts) {
    const store = (opts && opts.store) || {};
    const drumInput = (opts && opts.drumInput) || makeDrumInput();
    const drumProfiles = Object.prototype.hasOwnProperty.call(opts || {}, 'drumProfiles')
        ? opts.drumProfiles
        : makeDrumProfiles();
    const midiDevices = Object.prototype.hasOwnProperty.call(opts || {}, 'midiDevices')
        ? opts.midiDevices
        : null;
    const bus = [];
    const feedBack = {
        drumInput,
        drumProfiles,
        emit(name, detail) { bus.push({ name, detail }); },
        on() {},
        off() {},
    };
    if (midiDevices) feedBack.midiDevices = midiDevices;
    const window = {
        console,
        location: { protocol: 'http:', host: 'localhost' },
        slopsmith: {},
        feedBack,
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
        drumProfiles,
        midiDevices,
        bus,
        __test: window.slopsmithViz_drum_highway_3d.__test,
    };
}

function kitDoc(id, notes) {
    return { id, name: id, notes: notes || {}, source: 'user' };
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

function extractFunction(src, name) {
    const asyncSig = `async function ${name}(`;
    const sig = `function ${name}(`;
    let start = src.indexOf(asyncSig);
    if (start === -1) start = src.indexOf(sig);
    assert.ok(start !== -1, `function ${name} not found`);
    const open = src.indexOf('{', start);
    let depth = 1;
    let i = open + 1;
    while (i < src.length && depth > 0) {
        const ch = src[i];
        if (ch === '{') depth++;
        else if (ch === '}') depth--;
        i++;
    }
    return src.slice(start, i);
}

function extractConst(src, name) {
    const sig = `const ${name} = `;
    const start = src.indexOf(sig);
    assert.ok(start !== -1, `const ${name} not found`);
    const end = src.indexOf(';', start);
    return src.slice(start, end + 1);
}

function makeTab(tab, hidden) {
    return {
        dataset: { tab },
        hidden: !!hidden,
        classList: {
            _active: false,
            toggle(name, on) { if (name === 'active') this._active = !!on; },
            contains(name) { return name === 'active' && this._active; },
        },
    };
}

function runVisibility(plugins) {
    const drumsBtn = makeTab('drums', true);
    const gameplayBtn = makeTab('gameplay', false);
    gameplayBtn.classList._active = true;
    const sandbox = {
        DEFAULT_TAB: 'gameplay',
        plugins,
        document: {
            querySelector(sel) {
                if (sel === '#settings-tabbar .fb-tab[data-tab="drums"]') return drumsBtn;
                if (sel === '#settings-tabbar .fb-tab.active') return gameplayBtn;
                return null;
            },
            querySelectorAll(sel) {
                if (sel === '#settings-tabbar .fb-tab') return [gameplayBtn, drumsBtn];
                if (sel === '#settings .fb-tabpanel') return [{ dataset: { tab: 'gameplay' }, classList: { toggle() {} } }];
                return [];
            },
        },
        localStorage: { setItem() {} },
    };
    vm.createContext(sandbox);
    vm.runInContext(
        extractFunction(SETTINGS_JS, 'knownTabs') + '\n'
        + extractFunction(SETTINGS_JS, 'activateTab') + '\n'
        + extractFunction(SETTINGS_JS, 'syncDrumsTabVisibility') + '\n'
        + 'syncDrumsTabVisibility(plugins);\n',
        sandbox,
    );
    return { drumsBtn };
}

// ── ac-1: category drums ───────────────────────────────────────────────

test('ac-1: drum_highway_3d plugin.json declares settings.category drums', () => {
    const manifest = JSON.parse(fs.readFileSync(PLUGIN_JSON, 'utf8'));
    assert.equal(manifest.id, 'drum_highway_3d');
    assert.equal(manifest.settings.html, 'settings.html');
    assert.equal(manifest.settings.category, 'drums');
});

test('ac-1: 3D-only install shows the Drums tab', () => {
    const { drumsBtn } = runVisibility([
        { id: 'drum_highway_3d', settings_category: 'drums' },
    ]);
    assert.equal(drumsBtn.hidden, false);
});

// ── ac-2 / ac-3: split panels ──────────────────────────────────────────

test('ac-2: graphics fragment keeps bloom, camera, theme, cinematic', () => {
    const html = fs.readFileSync(GRAPHICS, 'utf8');
    assert.match(html, /data-drumh3d-fragment="graphics"/);
    assert.match(html, /id="drumh3d-fx-bloom"/);
    assert.match(html, /id="drumh3d-camera"/);
    assert.match(html, /id="drumh3d-fx-theme"/);
    assert.match(html, /id="drumh3d-fx-cinematic"/);
    assert.match(html, /id="drumh3d-palette"/);
});

test('ac-3: mapping table, MIDI knobs, and profile/lane chrome are gone from 3D drums settings', () => {
    const drums = fs.readFileSync(SETTINGS, 'utf8');
    const gfx = fs.readFileSync(GRAPHICS, 'utf8');
    assert.match(drums, /data-drumh3d-fragment="drums"/);
    assert.match(drums, /Chart fallbacks/);
    assert.doesNotMatch(drums, /id="drumh3d-profile"/);
    assert.doesNotMatch(drums, /id="drumh3d-use-profile"/);
    assert.doesNotMatch(drums, /id="drumh3d-kit-name"/);
    assert.doesNotMatch(drums, /id="drumh3d-kit-lanes"/);
    assert.doesNotMatch(drums, /3D lane layout/);
    assert.doesNotMatch(drums, /id="drumh3d-core-kit"/);
    assert.doesNotMatch(drums, /id="drumh3d-use-kit"/);
    assert.doesNotMatch(drums, /id="drumh3d-map-rows"/);
    assert.doesNotMatch(drums, /MIDI kit mapping/);
    assert.doesNotMatch(drums, /id="drumh3d-midi-input"/);
    assert.doesNotMatch(drums, /id="drumh3d-midi-channel"/);
    assert.doesNotMatch(drums, /id="drumh3d-hit-detect"/);
    assert.doesNotMatch(gfx, /id="drumh3d-core-kit"/);
    assert.doesNotMatch(gfx, /id="drumh3d-profile"/);
    assert.doesNotMatch(gfx, /MIDI kit mapping/);
    assert.doesNotMatch(drums, /id="drumh3d-fx-bloom"/);
    assert.doesNotMatch(drums, /id="drumh3d-camera"/);
    assert.doesNotMatch(drums, /id="drumh3d-fx-theme"/);
});

test('ac-2: loader extra-fragment helper injects FX HTML into #plugin-settings-graphics', async () => {
    const gfxHtml = fs.readFileSync(GRAPHICS, 'utf8');
    const children = [];
    const graphics = {
        id: 'plugin-settings-graphics',
        children,
        appendChild(el) { children.push(el); el.parent = this; return el; },
        querySelector() { return null; },
    };
    const created = [];
    const sandbox = {
        document: {
            getElementById(id) {
                if (id === 'plugin-settings-graphics') return graphics;
                if (id === 'plugin-settings-drum_highway_3d-graphics') {
                    return children.some((c) => c.id === id || (c.children && c.children.some((x) => x.id === id)))
                        ? { id } : null;
                }
                return null;
            },
            createElement(tag) {
                const el = {
                    tagName: tag,
                    className: '',
                    id: '',
                    dataset: {},
                    children: [],
                    attributes: [],
                    textContent: '',
                    innerHTML: '',
                    appendChild(child) { this.children.push(child); return child; },
                    setAttribute(name, value) { this.attributes.push({ name, value }); },
                    querySelectorAll() { return []; },
                };
                created.push(el);
                return el;
            },
        },
        fetch: async (url) => {
            assert.match(String(url), /\/api\/plugins\/drum_highway_3d\/assets\/settings-graphics\.html/);
            return { ok: true, text: async () => gfxHtml };
        },
        result: null,
    };
    vm.createContext(sandbox);
    vm.runInContext(
        extractConst(LOADER_JS, '_DRUM_H3D_GRAPHICS_ASSET') + '\n'
        + extractFunction(LOADER_JS, '_reviveSettingsScripts') + '\n'
        + extractFunction(LOADER_JS, '_injectDrumHighway3dGraphicsFragment') + '\n'
        + 'result = _injectDrumHighway3dGraphicsFragment({ id: "drum_highway_3d", name: "3D Drum Highway", version: "0.3.3" });\n',
        sandbox,
    );
    const ok = await sandbox.result;
    assert.equal(ok, true);
    assert.equal(graphics.children.length, 1);
    const details = graphics.children[0];
    assert.equal(details.dataset.pluginId, 'drum_highway_3d');
    assert.equal(details.dataset.settingsFragment, 'graphics');
    const body = details.children.find((c) => c.id === 'plugin-settings-drum_highway_3d-graphics');
    assert.ok(body, 'graphics body id missing');
    assert.match(body.innerHTML, /drumh3d-fx-bloom/);
    assert.doesNotMatch(body.innerHTML, /drumh3d-core-kit/);
});

test('loader fetches graphics via the existing plugin assets route', () => {
    assert.match(LOADER_JS, /_DRUM_H3D_GRAPHICS_ASSET = 'settings-graphics.html'/);
    assert.match(LOADER_JS, /\/api\/plugins\/\$\{plugin\.id\}\/assets\/\$\{_DRUM_H3D_GRAPHICS_ASSET\}/);
    assert.match(LOADER_JS, /function _injectDrumHighway3dGraphicsFragment/);
});

// ── ac-4: play-critical via drumProfiles ───────────────────────────────

test('ac-4: confirm kit with an active profile saves kit_id via drumProfiles and never PUTs notes', async () => {
    const dp = makeDrumProfiles({ activeId: 'living-room' });
    const ctx = load({ drumProfiles: dp });
    const calls = installFetch(ctx, (url, opts) => {
        const method = (opts && opts.method) || 'GET';
        if (method === 'GET' && url === '/api/drums/kits') return jsonOk({ kits: [kitDoc('kit-practice')] });
        if (method === 'GET' && url === '/api/settings') return jsonOk({ active_kit: 'kit-living' });
        if (method === 'GET' && url === '/api/drums/kits/kit-practice') return jsonOk(kitDoc('kit-practice', { 38: 'snare' }));
        if (method === 'POST') return jsonOk({ error: 'should not POST active_kit when a profile is active' });
        return jsonFail();
    });
    await ctx.window.drumH3dEnsureMappingInit();
    ctx.window.drumH3dSelectCoreKit('kit-practice');
    const result = await ctx.window.drumH3dConfirmCoreKit();
    assert.equal(result.ok, true);
    assert.equal(dp._saves.length, 1);
    assert.equal(dp._saves[0].kit_id, 'kit-practice');
    assert.equal(Object.prototype.hasOwnProperty.call(dp._saves[0], 'notes'), false);
    assert.equal(dp._activates[0], 'living-room');
    assert.equal(calls.some((c) => c.method === 'POST' && c.url === '/api/settings'), false);
    assert.equal(ctx.window.drumH3dGetCoreKitStatus().confirmedId, 'kit-practice');
});

test('ac-4: visual drum_h3d_kit_v1 lanes stay dual-read and are not the mapping SoT', async () => {
    const custom = {
        version: 1,
        name: 'User 3-piece',
        lanes: [{ piece: 'hh_closed' }, { piece: 'snare' }, { piece: 'kick' }],
        fallbacks: { hh_open: 'hh_closed' },
    };
    const store = { drum_h3d_kit_v1: JSON.stringify(custom) };
    const md = makeMidiDevices({
        devices: { 'living-ekit': { id: 'living-ekit', notes: { 24: 'kick' } } },
    });
    const dp = makeDrumProfiles({
        profiles: [
            { id: 'living-room', name: 'Living room', kit_id: 'kit-living', device_id: 'living-ekit' },
        ],
        activeId: 'living-room',
    });
    const ctx = load({ store, drumProfiles: dp, midiDevices: md });
    const before = store.drum_h3d_kit_v1;
    await ctx.__test._hydrateDeviceNotes();
    assert.equal(store.drum_h3d_kit_v1, before);
    const visual = ctx.window.drumH3dGetKit();
    assert.equal(visual.name, 'User 3-piece');
    assert.equal(ctx.__test._midiToPiece(24), 'kick');
    assert.equal(md._gets.includes('living-ekit'), true);
});

test('ac-4: activate profile never PUTs notes and uses logical profile ids', async () => {
    const dp = makeDrumProfiles();
    const ctx = load({ drumProfiles: dp });
    await ctx.window.drumH3dEnsureProfilesInit();
    ctx.window.drumH3dSelectProfile('practice');
    const result = await ctx.window.drumH3dActivateProfile();
    assert.equal(result.ok, true);
    assert.deepEqual(dp._activates, ['practice']);
    assert.equal(dp._saves.some((s) => Object.prototype.hasOwnProperty.call(s, 'notes')), false);
    const status = ctx.window.drumH3dGetProfileStatus();
    assert.equal(status.activeId, 'practice');
});

test('ac-4: settings markup does not persist raw device labels into a profile PUT', () => {
    const drums = fs.readFileSync(SETTINGS, 'utf8');
    const screen = fs.readFileSync(SCREEN, 'utf8');
    assert.doesNotMatch(drums, /innerHTML = inp\.name/);
    assert.doesNotMatch(drums, /id="drumh3d-midi-input"/);
    assert.doesNotMatch(screen, /drumProfiles\.save\([^)]*notes/);
    assert.match(screen, /never notes/);
});

// ── ac-5: profile-change refetches notes ───────────────────────────────

test('ac-5: feedback:drum-profile-change refetches attached device notes, not kit GET', async () => {
    const md = makeMidiDevices({
        devices: {
            'living-ekit': { id: 'living-ekit', notes: { 36: 'kick' } },
            'practice-ekit': { id: 'practice-ekit', notes: { 38: 'snare', 42: 'hh_closed' } },
        },
    });
    const dp = makeDrumProfiles({
        profiles: [
            { id: 'living-room', name: 'Living room', kit_id: 'kit-living', device_id: 'living-ekit' },
            { id: 'practice', name: 'Practice', kit_id: 'kit-practice', device_id: 'practice-ekit' },
        ],
        activeId: 'living-room',
    });
    const ctx = load({ drumProfiles: dp, midiDevices: md });
    const calls = installFetch(ctx, (url) => {
        if (String(url).startsWith('/api/drums/kits')) {
            return jsonOk({ error: 'kit GET must not be scoring SoT' });
        }
        return jsonFail();
    });
    await ctx.__test._hydrateDeviceNotes();
    assert.equal(ctx.__test._midiToPiece(36), 'kick');
    const before = md._gets.filter((id) => id === 'practice-ekit').length;
    await dp.activate('practice');
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert.ok(md._gets.filter((id) => id === 'practice-ekit').length > before);
    assert.equal(ctx.__test._midiToPiece(38), 'snare');
    assert.equal(ctx.__test._midiToPiece(42), 'hh_closed');
    assert.equal(ctx.__test._midiToPiece(36), undefined);
    assert.equal(calls.some((c) => /\/api\/drums\/kits\//.test(c.url)), false);
});

test('ac-5: screen.js subscribes via drumProfiles.subscribe or the shared bus', () => {
    const src = fs.readFileSync(SCREEN, 'utf8');
    assert.match(src, /feedback:drum-profile-change/);
    assert.match(src, /function _onDrumProfileChange/);
    assert.match(src, /dp\.subscribe\(_onDrumProfileChange\)/);
    assert.match(src, /feedback:midi-device-change/);
    assert.match(src, /function _onMidiDeviceChange/);
    assert.match(src, /_midiDevices\(\)/);
    assert.match(src, /md\.get\(/);
});

test('ac-1: feedback:midi-device-change refetches attached device notes', async () => {
    const md = makeMidiDevices({
        devices: {
            'living-ekit': { id: 'living-ekit', notes: { 36: 'kick' } },
        },
    });
    const dp = makeDrumProfiles({
        profiles: [
            { id: 'living-room', name: 'Living room', kit_id: 'kit-living', device_id: 'living-ekit' },
        ],
        activeId: 'living-room',
    });
    const ctx = load({ drumProfiles: dp, midiDevices: md });
    await ctx.__test._hydrateDeviceNotes();
    assert.equal(ctx.__test._midiToPiece(36), 'kick');
    md._setNotes('living-ekit', { 41: 'tom_low' });
    md._emit({ device_id: 'living-ekit' });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert.equal(ctx.__test._midiToPiece(41), 'tom_low');
    assert.equal(ctx.__test._midiToPiece(36), undefined);
});

test('ac-2: empty device notes do not apply Prime kit notes or GM', async () => {
    const md = makeMidiDevices({
        devices: {
            'bare-ekit': { id: 'bare-ekit', notes: {} },
        },
    });
    const dp = makeDrumProfiles({
        profiles: [
            { id: 'living-room', name: 'Living room', kit_id: 'alesis-strata-prime', device_id: 'bare-ekit' },
        ],
        activeId: 'living-room',
    });
    const ctx = load({ drumProfiles: dp, midiDevices: md });
    const calls = installFetch(ctx, (url) => {
        if (String(url).includes('alesis-strata-prime') || String(url).startsWith('/api/drums/kits')) {
            return jsonOk({
                id: 'alesis-strata-prime',
                notes: { 36: 'kick', 38: 'snare' },
                source: 'shipped',
            });
        }
        return jsonFail();
    });
    await ctx.__test._hydrateDeviceNotes();
    assert.equal(ctx.__test._deviceNotesLocked, true);
    assert.equal(ctx.__test._midiToPiece(36), undefined);
    assert.equal(ctx.__test._midiToPiece(38), undefined);
    assert.equal(ctx.__test._midiToPiece(42), undefined);
    assert.equal(calls.some((c) => /alesis-strata-prime/.test(c.url)), false);
});

test('ac-2: profile with empty device_id prefers empty overlay (no Prime default)', async () => {
    const md = makeMidiDevices({ devices: {} });
    const dp = makeDrumProfiles({
        profiles: [
            { id: 'living-room', name: 'Living room', kit_id: 'alesis-strata-prime', device_id: '' },
        ],
        activeId: 'living-room',
    });
    const ctx = load({ drumProfiles: dp, midiDevices: md });
    installFetch(ctx, (url) => {
        if (String(url).includes('alesis-strata-prime')) {
            return jsonOk({ id: 'alesis-strata-prime', notes: { 36: 'kick' } });
        }
        return jsonFail();
    });
    await ctx.__test._hydrateDeviceNotes();
    assert.equal(ctx.__test._deviceNotesLocked, true);
    assert.equal(ctx.__test._midiToPiece(36), undefined);
    assert.equal(ctx.__test._midiToPiece(38), undefined);
});

test('ac-5: device consume does not write drum_h3d_kit_v1', async () => {
    const custom = {
        version: 1,
        name: 'User 3-piece',
        lanes: [{ piece: 'kick' }],
        fallbacks: {},
    };
    const store = { drum_h3d_kit_v1: JSON.stringify(custom) };
    const md = makeMidiDevices({
        devices: { 'living-ekit': { id: 'living-ekit', notes: { 24: 'kick' } } },
    });
    const dp = makeDrumProfiles({
        profiles: [{ id: 'living-room', name: 'Living room', device_id: 'living-ekit' }],
        activeId: 'living-room',
    });
    const ctx = load({ store, drumProfiles: dp, midiDevices: md });
    const before = store.drum_h3d_kit_v1;
    await ctx.__test._hydrateDeviceNotes();
    md._setNotes('living-ekit', { 38: 'snare' });
    md._emit({ device_id: 'living-ekit' });
    await new Promise((r) => setImmediate(r));
    assert.equal(store.drum_h3d_kit_v1, before);
    assert.equal(ctx.window.drumH3dGetKit().name, 'User 3-piece');
    assert.equal(ctx.__test._midiToPiece(38), 'snare');
    assert.equal(ctx.__test._midiToPiece(24), undefined);
});
