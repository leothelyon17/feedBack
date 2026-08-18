'use strict';

// INIT-001/SPEC-003: v3 tuner badge renders a clickable control only when the
// tuner plugin is present (window.tuner.toggle). The shell host span stays
// emitted; renderTuner() empties it when the plugin is absent/disabled.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..', '..');
const SRC = fs.readFileSync(path.join(ROOT, 'static', 'v3', 'badges.js'), 'utf8');

function makeHost() {
    const listeners = [];
    const host = {
        innerHTML: 'sentinel',
        querySelector(sel) {
            if (sel === '[data-open-tuner]' && /data-open-tuner/.test(this.innerHTML)) {
                return {
                    addEventListener(type, fn) { listeners.push({ type, fn }); },
                };
            }
            return null;
        },
        querySelectorAll() { return []; },
    };
    return { host, listeners };
}

function loadBadges(opts) {
    opts = opts || {};
    const { host, listeners } = makeHost();
    const loaded = opts.loadedPlugins instanceof Map ? opts.loadedPlugins : new Map();
    const win = {
        tuner: opts.tuner,
        feedBack: {
            _loadedPluginScripts: loaded,
            on() {},
        },
        v3Badges: undefined,
    };
    const doc = {
        readyState: 'loading',
        getElementById(id) { return id === 'v3-badge-tuner' ? host : null; },
        querySelector() { return null; },
        addEventListener() {},
        removeEventListener() {},
    };
    const sandbox = {
        window: win,
        document: doc,
        fetch: () => Promise.resolve({ ok: true, json: async () => ({ tunings: {}, tuningMidis: {} }) }),
        console,
    };
    vm.createContext(sandbox);
    vm.runInContext(SRC, sandbox);
    return { sandbox, host, listeners, win };
}

test('helpers stay split so SPEC-004 can AND player_instrument onto shouldShowTunerBadge', () => {
    assert.match(SRC, /function tunerPluginPresent\(\)/);
    assert.match(SRC, /function shouldShowTunerBadge\(\)/);
    assert.match(SRC, /SPEC-004 adds `player_instrument === 'drums'`/);
});

test('absent plugin: renderTuner empties the host and does not bind openTuner', () => {
    const { host, listeners, sandbox } = loadBadges({});
    sandbox.window.v3Badges.renderTuner();
    assert.equal(host.innerHTML, '');
    assert.equal(listeners.length, 0);
    assert.doesNotMatch(host.innerHTML, /data-open-tuner/);
});

test('renderTuner is a no-op when the shell host span is missing', () => {
    const { sandbox, host } = loadBadges({});
    sandbox.document.getElementById = () => null;
    sandbox.window.v3Badges.renderTuner();
    assert.equal(host.innerHTML, 'sentinel');
});

test('Map-only loader hit without window.tuner: still no clickable control', () => {
    const loaded = new Map([['tuner', '1.0.0']]);
    const { host, listeners, sandbox } = loadBadges({ loadedPlugins: loaded });
    sandbox.window.v3Badges.renderTuner();
    assert.equal(host.innerHTML, '');
    assert.equal(listeners.length, 0);
});

test('loaded plugin: badge renders and binds the open-tuner click handler', () => {
    let toggled = 0;
    const { host, listeners, sandbox } = loadBadges({
        tuner: { toggle() { toggled += 1; } },
    });
    sandbox.window.v3Badges.renderTuner();
    assert.match(host.innerHTML, /data-open-tuner/);
    assert.match(host.innerHTML, /id="v3-tuner-wrap"/);
    assert.equal(listeners.length, 1);
    assert.equal(listeners[0].type, 'click');
    listeners[0].fn({ stopPropagation() {} });
    assert.equal(toggled, 1);
});

test('late plugin load: empty host then handshake renderTuner paints the badge', () => {
    const { host, listeners, sandbox, win } = loadBadges({});
    sandbox.window.v3Badges.renderTuner();
    assert.equal(host.innerHTML, '');

    let toggled = 0;
    win.tuner = { toggle() { toggled += 1; } };
    sandbox.window.v3Badges.renderTuner();
    assert.match(host.innerHTML, /data-open-tuner/);
    assert.equal(listeners.length, 1);
    listeners[0].fn({ stopPropagation() {} });
    assert.equal(toggled, 1);
});

test('badge still listens for tuner:frame after a gesture (live meter path intact)', () => {
    assert.match(SRC, /sm\.on\('tuner:frame'/);
    assert.match(SRC, /function _applyFrame\(frame\)/);
});
