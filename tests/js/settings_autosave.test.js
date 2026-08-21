// Verify the Settings-dropdown autosave path in static/js/settings.js:
// persistSetting() must funnel one-field POSTs through a single chain so
// they hit the server one at a time, in call order, and a failed save
// must not poison the chain for later saves.
//
// Same isolation strategy as loop_api.test.js — extract the relevant
// functions by brace-matching and run them in a vm sandbox with a
// controllable fetch stub.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// R3d: settings was carved out of app.js into its own module. Bodies unchanged — only the file
// moved. It went cleanly because the WRITERS came with it: _defaultArrangement was the one
// binding written from outside the cluster, by saveSettings and pinCurrentArrangementDefault,
// which are themselves settings functions. Widening the slice to include them left zero outside
// writes, so no state container was needed.
const APP_JS = path.join(__dirname, '..', '..', 'static', 'js', 'settings.js');

function extractFunction(src, signature) {
    const start = src.indexOf(signature);
    if (start === -1) throw new Error(`extractFunction: '${signature}' not found in settings.js`);
    const openBrace = src.indexOf('{', start);
    let depth = 1;
    let i = openBrace + 1;
    while (i < src.length && depth > 0) {
        const ch = src[i];
        if (ch === '{') depth++;
        else if (ch === '}') depth--;
        i++;
    }
    if (depth !== 0) throw new Error(`extractFunction: unbalanced braces after '${signature}'`);
    return src.slice(start, i);
}

// Drain enough microtask hops for the promise chain (persistSetting →
// _settingSaveChain.then → _postSetting → await fetch → await resp.json)
// to settle. vm-sandbox promises share the host V8 microtask queue, so
// awaiting here advances them too.
async function flush() {
    for (let i = 0; i < 30; i++) await Promise.resolve();
}

function buildSandbox() {
    // Every fetch() call parks here as { body, resolve, reject } so the
    // test controls exactly when each request settles.
    const pending = [];
    const status = { textContent: '' };
    const sandbox = {
        pending,
        status,
        document: {
            getElementById: () => status,
        },
        fetch: (url, opts) => new Promise((resolve, reject) => {
            pending.push({ body: JSON.parse(opts.body), resolve, reject });
        }),
    };
    vm.createContext(sandbox);
    return sandbox;
}

function loadFunctions(sandbox, src) {
    const code = `
        var _settingSaveChain = Promise.resolve();
        ${extractFunction(src, 'function persistSetting(')}
        ${extractFunction(src, 'async function _postSetting(')}
        globalThis.__persistSetting = persistSetting;
    `;
    vm.runInContext(code, sandbox);
}

// Resolve a parked fetch as a successful /api/settings response.
function ok(entry, message = 'Settings saved') {
    entry.resolve({ json: async () => ({ message }) });
}

test('persistSetting sends one POST at a time, in call order', async () => {
    const src = fs.readFileSync(APP_JS, 'utf8');
    const sandbox = buildSandbox();
    loadFunctions(sandbox, src);

    sandbox.__persistSetting('default_arrangement', 'Lead');
    sandbox.__persistSetting('demucs_server_url', 'http://example:7865');
    await flush();

    // The second POST must not be in flight until the first resolves.
    assert.equal(sandbox.pending.length, 1, 'only the first POST should be in flight');
    assert.deepEqual(sandbox.pending[0].body, { default_arrangement: 'Lead' });

    ok(sandbox.pending[0]);
    await flush();

    assert.equal(sandbox.pending.length, 2, 'second POST runs after the first settles');
    assert.deepEqual(sandbox.pending[1].body, { demucs_server_url: 'http://example:7865' });

    ok(sandbox.pending[1]);
    await flush();
});

test('a failed save does not block later saves on the chain', async () => {
    const src = fs.readFileSync(APP_JS, 'utf8');
    const sandbox = buildSandbox();
    loadFunctions(sandbox, src);

    sandbox.__persistSetting('default_arrangement', 'Bass');
    sandbox.__persistSetting('demucs_server_url', 'http://example:9000');
    await flush();

    assert.equal(sandbox.pending.length, 1);
    // First request fails outright (network error).
    sandbox.pending[0].reject(new Error('network down'));
    await flush();

    assert.equal(sandbox.pending.length, 2, 'second save still proceeds after the first fails');
    assert.deepEqual(sandbox.pending[1].body, { demucs_server_url: 'http://example:9000' });
    assert.match(sandbox.status.textContent, /Save failed/, 'failure surfaces in the status line');

    ok(sandbox.pending[1]);
    await flush();
    assert.equal(sandbox.status.textContent, 'Settings saved', 'later save still reports success');
});

test('INIT-001/SPEC-004: persistSetting posts player_instrument including null unset', async () => {
    const src = fs.readFileSync(APP_JS, 'utf8');
    const sandbox = buildSandbox();
    loadFunctions(sandbox, src);

    sandbox.__persistSetting('player_instrument', 'drums');
    await flush();
    assert.equal(sandbox.pending.length, 1);
    assert.deepEqual(sandbox.pending[0].body, { player_instrument: 'drums' });
    ok(sandbox.pending[0]);
    await flush();

    sandbox.__persistSetting('player_instrument', null);
    await flush();
    assert.equal(sandbox.pending.length, 2);
    assert.deepEqual(sandbox.pending[1].body, { player_instrument: null });
    ok(sandbox.pending[1]);
    await flush();
});

// INIT-001/SPEC-004 ac-5: changing Main instrument away from drums must restore
// the tuner badge and tour step via v3Badges.reload() — not location.reload().
// Real badges.js + onboarding-tour.js (not stubs) so a no-op reload fails the test.

const BADGES_JS = path.join(__dirname, '..', '..', 'static', 'v3', 'badges.js');
const TOUR_JS = path.join(__dirname, '..', '..', 'static', 'v3', 'onboarding-tour.js');

function stubEl(listeners) {
    const el = {
        addEventListener(type, fn) { listeners.push({ type, fn }); },
        classList: { contains() { return true; }, add() {}, remove() {} },
        querySelector() { return stubEl(listeners); },
        querySelectorAll() { return []; },
        getAttribute() { return ''; },
        textContent: '',
    };
    return el;
}

function attrName(sel) {
    const m = String(sel).match(/\[([^\s=\]]+)/);
    return m ? m[1] : '';
}

function makeBadgeHost() {
    const listeners = [];
    const host = {
        innerHTML: 'sentinel',
        querySelector(sel) {
            const name = attrName(sel);
            if (name && String(this.innerHTML).includes(name)) {
                return stubEl(listeners);
            }
            return null;
        },
        querySelectorAll() { return []; },
    };
    return { host, listeners };
}

function tourStepIds(tour) {
    return Array.prototype.map.call(tour.buildSteps(), (s) => String(s.id));
}

function loadRestoreHarness() {
    const settingsSrc = fs.readFileSync(APP_JS, 'utf8');
    const { host, listeners } = makeBadgeHost();
    const { host: instHost } = makeBadgeHost();
    const playerInstEl = { value: 'drums' };
    const status = { textContent: '' };
    const stored = {
        instrument: 'guitar',
        string_count: 6,
        tuning: 'Standard',
        reference_pitch: 440,
        player_instrument: 'drums',
    };
    let locationReloads = 0;
    const location = { reload() { locationReloads += 1; } };
    const win = {
        tuner: { toggle() {} },
        feedBack: { _loadedPluginScripts: new Map(), on() {}, off() {} },
        feedBackTour: {
            register() { return true; },
            start() {},
            hasSeen() { return false; },
            hasDismissed() { return false; },
        },
        v3Badges: undefined,
        v3OnboardingTour: undefined,
        location,
        showScreen() {},
    };
    const sandbox = {
        window: win,
        document: {
            readyState: 'loading',
            getElementById(id) {
                if (id === 'v3-badge-tuner') return host;
                if (id === 'v3-badge-instrument') return instHost;
                if (id === 'setting-player-instrument') return playerInstEl;
                if (id === 'settings-status') return status;
                return null;
            },
            querySelector() { return null; },
            addEventListener() {},
            removeEventListener() {},
        },
        fetch: (url, opts) => {
            const u = String(url);
            if (u.includes('/api/settings')) {
                if (opts && String(opts.method || '').toUpperCase() === 'POST') {
                    Object.assign(stored, JSON.parse(opts.body));
                    return Promise.resolve({
                        ok: true,
                        json: async () => ({ message: 'Settings saved' }),
                    });
                }
                return Promise.resolve({ ok: true, json: async () => Object.assign({}, stored) });
            }
            return Promise.resolve({ ok: true, json: async () => ({ tunings: {}, tuningMidis: {} }) });
        },
        location,
        console,
        setTimeout() { return 0; },
    };
    vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(BADGES_JS, 'utf8'), sandbox);
    vm.runInContext(fs.readFileSync(TOUR_JS, 'utf8'), sandbox);
    vm.runInContext(`
        var _settingSaveChain = Promise.resolve();
        const PLAYER_INSTRUMENTS = ['guitar', 'bass', 'drums', 'keys', 'vocals'];
        ${extractFunction(settingsSrc, 'function persistSetting(')}
        ${extractFunction(settingsSrc, 'async function _postSetting(')}
        ${extractFunction(settingsSrc, 'function setPlayerInstrument(')}
        globalThis.__setPlayerInstrument = setPlayerInstrument;
    `, sandbox);
    return {
        sandbox,
        host,
        listeners,
        playerInstEl,
        stored,
        locationReloads: () => locationReloads,
    };
}

async function restoreFromDrums(nextValue) {
    const harness = loadRestoreHarness();
    await harness.sandbox.window.v3Badges.reload();
    await flush();
    assert.equal(harness.host.innerHTML, '', 'drums start: tuner badge emptied');
    assert.equal(harness.listeners.length, 0, 'drums start: no open-tuner handler');
    assert.doesNotMatch(harness.host.innerHTML, /data-open-tuner/);
    assert.ok(
        !tourStepIds(harness.sandbox.window.v3OnboardingTour).includes('tuner'),
        'drums start: tour omits tuner',
    );

    const ret = harness.sandbox.__setPlayerInstrument(nextValue);
    if (ret && typeof ret.then === 'function') await ret;
    await flush();

    assert.match(harness.host.innerHTML, /data-open-tuner/, 'restore: tuner badge is clickable');
    assert.equal(harness.listeners.length, 1, 'restore: open-tuner click is bound');
    assert.equal(harness.listeners[0].type, 'click');
    assert.ok(
        tourStepIds(harness.sandbox.window.v3OnboardingTour).includes('tuner'),
        'restore: tour re-includes tuner',
    );
    assert.equal(harness.locationReloads(), 0, 'restore must not call location.reload');
    return harness;
}

test('INIT-001/SPEC-004: setPlayerInstrument drums→guitar restores tuner badge and tour without location.reload', async () => {
    const harness = await restoreFromDrums('guitar');
    assert.equal(harness.stored.player_instrument, 'guitar');
    assert.equal(harness.playerInstEl.value, 'guitar');
    assert.equal(harness.sandbox.window.v3Badges.getPlayerInstrument(), 'guitar');
});

test('INIT-001/SPEC-004: setPlayerInstrument drums→unset restores tuner badge and tour without location.reload', async () => {
    const harness = await restoreFromDrums('');
    assert.equal(harness.stored.player_instrument, null);
    assert.equal(harness.playerInstEl.value, '');
    assert.equal(harness.sandbox.window.v3Badges.getPlayerInstrument(), null);
});
