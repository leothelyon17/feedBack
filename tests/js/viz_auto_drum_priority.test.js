'use strict';

// INIT-002/SPEC-005: Auto-mode selection policy for drum arrangements.
// Loads static/js/viz.js in a vm (export keywords stripped) with a fake
// picker/DOM/WebGL2 probe. Plugin suitability predicates are copied from
// the real bundled factories — this file does not import feedBack-plugin-drums
// (GR-004).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..', '..');
const VIZ_JS = path.join(ROOT, 'static', 'js', 'viz.js');

// Copied from plugins/drum_highway_3d/screen.js (keep in lockstep with the
// real steal-guard — Auto must not claim guitar/keys charts).
function matchesDrum3d(songInfo) {
    if (!songInfo || !songInfo.has_drum_tab) return false;
    const arr = songInfo.arrangement || '';
    if (/\b(?:drums?|percussion)\b/i.test(arr)) return true;
    if (songInfo.has_notation) return false;
    return !/\b(?:lead|rhythm|bass|combo|guitar)\b/i.test(arr);
}

// Copied from plugins/highway_3d/screen.js.
function matchesGuitar3d(songInfo) {
    const arr = (songInfo && songInfo.arrangement) || '';
    return /\b(?:lead|rhythm|bass|combo|guitar)\b/i.test(arr);
}

function makeFactory(id, { contextType, matches }) {
    function factory() {
        return { draw() {}, pluginId: id };
    }
    factory.contextType = contextType;
    factory.matchesArrangement = matches;
    return factory;
}

function drumSong() {
    return {
        has_drum_tab: true,
        arrangement: 'Drums',
        arrangement_index: 0,
        arrangements: [{ index: 0, notes: 12 }],
    };
}

function guitarSong() {
    return {
        has_drum_tab: true, // full-band pack; active part is still Lead
        arrangement: 'Lead',
        arrangement_index: 0,
        arrangements: [{ index: 0, notes: 40 }],
    };
}

function notationSong() {
    return {
        has_drum_tab: false,
        has_notation: true,
        arrangement: 'Piano',
        arrangement_index: 0,
        arrangements: [{ index: 0, notes: 0 }],
    };
}

function loadViz(opts) {
    const webgl2 = opts.webgl2 !== false;
    const songInfo = opts.songInfo || {};
    const optionIds = opts.optionIds || [
        'auto', 'default', 'drums', 'highway_3d', 'drum_highway_3d',
    ];
    const factories = opts.factories || {};
    const installed = [];
    const storage = new Map();
    if (opts.vizSelection) storage.set('vizSelection', opts.vizSelection);

    const options = optionIds.map((id) => {
        const opt = { value: id, text: id, textContent: id };
        return opt;
    });
    const picker = {
        options,
        _value: opts.pickerValue != null ? opts.pickerValue : 'auto',
        get value() { return this._value; },
        set value(v) { this._value = v; },
    };
    const elements = new Map([['viz-picker', picker]]);
    const bus = new Map();

    const window = {
        console,
        feedBack: {
            on(type, fn, hookOpts) {
                const list = bus.get(type) || [];
                const handler = (hookOpts && hookOpts.once)
                    ? (ev) => {
                        const cur = bus.get(type) || [];
                        bus.set(type, cur.filter((h) => h !== handler));
                        fn(ev);
                    }
                    : fn;
                list.push(handler);
                bus.set(type, list);
            },
            off(type, fn) {
                bus.set(type, (bus.get(type) || []).filter((h) => h !== fn));
            },
            emit(type, detail) {
                for (const h of (bus.get(type) || []).slice()) {
                    h({ detail });
                }
            },
        },
        highway: {
            getSongInfo() { return songInfo; },
            setRenderer(renderer) { installed.push(renderer); },
        },
        localStorage: {
            getItem(key) { return storage.has(key) ? storage.get(key) : null; },
            setItem(key, value) { storage.set(String(key), String(value)); },
            removeItem(key) { storage.delete(String(key)); },
        },
        document: {
            getElementById(id) { return elements.get(id) || null; },
            querySelector(sel) {
                if (sel === '#viz-picker option[value="auto"]') {
                    return options.find((o) => o.value === 'auto') || null;
                }
                return null;
            },
            createElement(tag) {
                if (tag === 'canvas') {
                    return {
                        getContext(type) {
                            if (type === 'webgl2' && webgl2) {
                                return { getExtension() { return { loseContext() {} }; } };
                            }
                            return null;
                        },
                    };
                }
                const el = {
                    id: '',
                    className: '',
                    style: { cssText: '' },
                    dataset: {},
                    textContent: '',
                    innerHTML: '',
                    children: [],
                    setAttribute() {},
                    addEventListener() {},
                    appendChild(child) { this.children.push(child); return child; },
                    remove() {},
                    closest() { return null; },
                };
                return el;
            },
            body: { appendChild() {} },
        },
        __storage: storage,
        __installed: installed,
        __picker: picker,
    };
    window.window = window;
    window.globalThis = window;

    const defaultFactories = {
        drums: makeFactory('drums', { contextType: '2d', matches: matchesDrum3d }),
        highway_3d: makeFactory('highway_3d', { contextType: 'webgl2', matches: matchesGuitar3d }),
        drum_highway_3d: makeFactory('drum_highway_3d', { contextType: 'webgl2', matches: matchesDrum3d }),
    };
    const merged = Object.assign({}, defaultFactories, factories);
    for (const [id, factory] of Object.entries(merged)) {
        if (factory) window['feedBackViz_' + id] = factory;
        else delete window['feedBackViz_' + id];
    }

    let src = fs.readFileSync(VIZ_JS, 'utf8');
    src = src.replace(/^export /gm, '');
    const context = vm.createContext(window);
    vm.runInContext(src, context, { filename: 'viz.js' });
    return window;
}

function lastInstalledId(window) {
    const last = window.__installed[window.__installed.length - 1];
    if (last == null) return null;
    return last.pluginId || last.source || null;
}

test('REQ-006: Auto selects 3D drums even when the 2D option sorts first', () => {
    const window = loadViz({
        webgl2: true,
        songInfo: drumSong(),
        optionIds: ['auto', 'default', 'drums', 'highway_3d', 'drum_highway_3d'],
    });
    window._autoMatchViz();
    assert.equal(lastInstalledId(window), 'drum_highway_3d');
    assert.equal(window.__picker.value, 'auto', 'vizSelection stays Auto');
    assert.equal(window.localStorage.getItem('vizSelection'), null,
        'Auto must not persist the resolved plugin id');
});

test('REQ-006: Auto selects 2D drums when WebGL2 is unsupported', () => {
    const window = loadViz({
        webgl2: false,
        songInfo: drumSong(),
        optionIds: ['auto', 'default', 'drums', 'drum_highway_3d', 'highway_3d'],
    });
    window._autoMatchViz();
    assert.equal(lastInstalledId(window), 'drums');
    assert.equal(window.__picker.value, 'auto');
});

test('REQ-006: Auto selects 2D drums when the 3D plugin is unavailable', () => {
    const window = loadViz({
        webgl2: true,
        songInfo: drumSong(),
        optionIds: ['auto', 'default', 'drums', 'highway_3d'],
        factories: { drum_highway_3d: null },
    });
    window._autoMatchViz();
    assert.equal(lastInstalledId(window), 'drums');
});

test('REQ-006: Auto selects 2D drums when 3D is listed but has no factory', () => {
    const window = loadViz({
        webgl2: true,
        songInfo: drumSong(),
        optionIds: ['auto', 'default', 'drums', 'drum_highway_3d'],
        factories: { drum_highway_3d: null },
    });
    window._autoMatchViz();
    assert.equal(lastInstalledId(window), 'drums');
});

test('REQ-006: a Lead arrangement does not Auto-select the drum 3D highway', () => {
    const window = loadViz({
        webgl2: true,
        songInfo: guitarSong(),
        optionIds: ['auto', 'default', 'drums', 'drum_highway_3d', 'highway_3d'],
    });
    window._autoMatchViz();
    assert.equal(lastInstalledId(window), 'highway_3d');
});

test('REQ-006: a notation-only piano arrangement does not Auto-select drums', () => {
    const window = loadViz({
        webgl2: true,
        songInfo: notationSong(),
        optionIds: ['auto', 'default', 'drums', 'drum_highway_3d', 'highway_3d'],
    });
    window._autoMatchViz();
    const last = window.__installed[window.__installed.length - 1];
    assert.equal(last, null, 'no-match falls through to the built-in 2D highway');
});

test('GR-006: explicit 2D selection is not replaced by Auto', () => {
    const window = loadViz({
        webgl2: true,
        songInfo: drumSong(),
        pickerValue: 'drums',
        vizSelection: 'drums',
        optionIds: ['auto', 'default', 'drums', 'drum_highway_3d'],
    });
    window._autoMatchViz();
    assert.equal(window.__installed.length, 0, 'Auto must not install anything');
    assert.equal(window.__picker.value, 'drums');
    assert.equal(window.localStorage.getItem('vizSelection'), 'drums');
});

test('GR-006: setViz("drums") persists and does not fall through to Auto', () => {
    const window = loadViz({
        webgl2: true,
        songInfo: drumSong(),
        // The picker onchange sets sel.value before calling setViz — that is
        // the explicit-choice signal Auto must respect (GR-006).
        pickerValue: 'drums',
        optionIds: ['auto', 'default', 'drums', 'drum_highway_3d'],
    });
    window.setViz('drums');
    assert.equal(window.localStorage.getItem('vizSelection'), 'drums');
    assert.equal(window.__picker.value, 'drums');
    assert.equal(lastInstalledId(window), 'drums');
    const countAfterExplicit = window.__installed.length;
    window._autoMatchViz();
    assert.equal(window.__installed.length, countAfterExplicit,
        'a later Auto evaluation must not clobber the explicit choice');
    assert.equal(window.localStorage.getItem('vizSelection'), 'drums');
});

test('setViz("auto") re-enables Auto even if the picker still shows an explicit id', () => {
    const window = loadViz({
        webgl2: true,
        songInfo: drumSong(),
        pickerValue: 'drums',
        vizSelection: 'drums',
        optionIds: ['auto', 'default', 'drums', 'drum_highway_3d'],
    });
    window.setViz('auto');
    assert.equal(window.__picker.value, 'auto');
    assert.equal(window.localStorage.getItem('vizSelection'), 'auto');
    assert.equal(lastInstalledId(window), 'drum_highway_3d');
});

test('existing guitar 3D Auto match still wins for Lead when drums 3D is absent', () => {
    const window = loadViz({
        webgl2: true,
        songInfo: guitarSong(),
        optionIds: ['auto', 'default', 'highway_3d'],
        factories: { drums: null, drum_highway_3d: null },
    });
    window._autoMatchViz();
    assert.equal(lastInstalledId(window), 'highway_3d');
});
