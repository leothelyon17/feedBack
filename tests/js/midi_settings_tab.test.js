// INIT-003/SPEC-010: Settings → MIDI host stub.
//
// Source-scan + vm harness (no jsdom). Covers the always-visible MIDI tab,
// loader target, fixture injection into #plugin-settings-midi, and the
// Drums hide-unless-declared regression. MIDI must stay visible even when
// no plugin declared settings.category: "midi".

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..', '..');
const V3_HTML = fs.readFileSync(path.join(ROOT, 'static', 'v3', 'index.html'), 'utf8');
const LOADER_JS = fs.readFileSync(path.join(ROOT, 'static', 'js', 'plugin-loader.js'), 'utf8');
const SETTINGS_JS = fs.readFileSync(path.join(ROOT, 'static', 'v3', 'settings.js'), 'utf8');

function extractFunction(src, name) {
    const sig = `function ${name}(`;
    const start = src.indexOf(sig);
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
    assert.equal(depth, 0, `unbalanced braces in ${name}`);
    return src.slice(start, i);
}

function extractConstArray(src, name) {
    const sig = `const ${name} = [`;
    const start = src.indexOf(sig);
    assert.ok(start !== -1, `const ${name} not found`);
    const end = src.indexOf('];', start);
    assert.ok(end !== -1, `${name} close not found`);
    return src.slice(start, end + 2);
}

function settingsTabbar() {
    const barStart = V3_HTML.indexOf('id="settings-tabbar"');
    assert.ok(barStart !== -1, 'settings-tabbar missing');
    const barEnd = V3_HTML.indexOf('</div>', barStart);
    return V3_HTML.slice(barStart, barEnd);
}

function makeEl(id) {
    return {
        id,
        children: [],
        appendChild(child) {
            this.children.push(child);
            child.parent = this;
            return child;
        },
    };
}

function runTarget(plugin, mounts) {
    const byId = Object.fromEntries(mounts.map((el) => [el.id, el]));
    const sandbox = {
        document: {
            getElementById(id) { return byId[id] || null; },
        },
        plugin,
        result: null,
    };
    vm.createContext(sandbox);
    vm.runInContext(
        extractConstArray(LOADER_JS, '_PLUGIN_SETTINGS_CONTAINER_IDS') + '\n'
        + extractFunction(LOADER_JS, '_pluginSettingsTarget') + '\n'
        + 'result = _pluginSettingsTarget(plugin);\n',
        sandbox,
    );
    return sandbox.result;
}

function injectFixture(plugin, mounts) {
    const target = runTarget(plugin, mounts);
    if (plugin.has_settings && target) {
        target.appendChild({ id: `plugin-settings-${plugin.id}`, pluginId: plugin.id });
    }
    return target;
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

function makePanel(tab) {
    return {
        dataset: { tab },
        classList: { toggle() { /* unused in visibility tests */ } },
    };
}

function runVisibility(plugins, { startHiddenDrums = true, startActive = 'gameplay' } = {}) {
    const drumsBtn = makeTab('drums', startHiddenDrums);
    const midiBtn = makeTab('midi', false);
    const systemBtn = makeTab('system', false);
    const gameplayBtn = makeTab('gameplay', false);
    if (startActive === 'drums') drumsBtn.classList._active = true;
    else if (startActive === 'midi') midiBtn.classList._active = true;
    else gameplayBtn.classList._active = true;
    const tabs = [gameplayBtn, systemBtn, drumsBtn, midiBtn];
    const panels = [makePanel('gameplay'), makePanel('system'), makePanel('drums'), makePanel('midi')];
    const sandbox = {
        DEFAULT_TAB: 'gameplay',
        plugins,
        document: {
            querySelector(sel) {
                if (sel === '#settings-tabbar .fb-tab[data-tab="drums"]') return drumsBtn;
                if (sel === '#settings-tabbar .fb-tab[data-tab="midi"]') return midiBtn;
                if (sel === '#settings-tabbar .fb-tab.active') {
                    return tabs.find((t) => t.classList._active) || null;
                }
                return null;
            },
            querySelectorAll(sel) {
                if (sel === '#settings-tabbar .fb-tab') return tabs;
                if (sel === '#settings .fb-tabpanel') return panels;
                return [];
            },
        },
        localStorage: { setItem() { /* persist no-op */ } },
    };
    vm.createContext(sandbox);
    vm.runInContext(
        extractFunction(SETTINGS_JS, 'knownTabs') + '\n'
        + extractFunction(SETTINGS_JS, 'activateTab') + '\n'
        + extractFunction(SETTINGS_JS, 'syncDrumsTabVisibility') + '\n'
        + 'syncDrumsTabVisibility(plugins);\n'
        + 'known = knownTabs();\n',
        sandbox,
    );
    return { drumsBtn, midiBtn, gameplayBtn, tabs, known: sandbox.known };
}

test('MIDI tab button sits after Drums and matches the existing tablist', () => {
    const bar = settingsTabbar();
    const drumsAt = bar.indexOf('data-tab="drums"');
    const midiAt = bar.indexOf('data-tab="midi"');
    assert.ok(drumsAt !== -1 && midiAt !== -1, 'Drums or MIDI tab missing');
    assert.ok(midiAt > drumsAt, 'MIDI tab must appear after Drums');
    assert.match(bar, /<button type="button" class="fb-tab" data-tab="midi">MIDI<\/button>/);
});

test('MIDI tab button has no hidden attribute', () => {
    const bar = settingsTabbar();
    const midiBtn = bar.match(/<button[^>]*data-tab="midi"[^>]*>/);
    assert.ok(midiBtn, 'MIDI button missing');
    assert.doesNotMatch(midiBtn[0], /\bhidden\b/);
    const drumsBtn = bar.match(/<button[^>]*data-tab="drums"[^>]*>/);
    assert.ok(drumsBtn, 'Drums button missing');
    assert.match(drumsBtn[0], /\bhidden\b/);
});

test('mount #plugin-settings-midi exists in the MIDI panel', () => {
    assert.match(V3_HTML, /id="plugin-settings-midi"/);
    const lastPanelAt = V3_HTML.lastIndexOf('<div class="fb-tabpanel" data-tab="midi">');
    assert.ok(lastPanelAt !== -1, 'MIDI tabpanel missing');
    const mountAt = V3_HTML.indexOf('id="plugin-settings-midi"', lastPanelAt);
    assert.ok(mountAt > lastPanelAt, 'mount must live inside the MIDI tabpanel');
});

test('_PLUGIN_SETTINGS_CONTAINER_IDS includes plugin-settings-midi', () => {
    const ids = vm.runInNewContext(
        extractConstArray(LOADER_JS, '_PLUGIN_SETTINGS_CONTAINER_IDS')
        + '\n_PLUGIN_SETTINGS_CONTAINER_IDS',
    );
    assert.ok(ids.includes('plugin-settings-midi'));
});

test('_pluginSettingsTarget({settings_category:"midi"}) resolves to #plugin-settings-midi', () => {
    const midi = makeEl('plugin-settings-midi');
    const fallback = makeEl('plugin-settings');
    const got = runTarget({ settings_category: 'midi' }, [midi, fallback]);
    assert.equal(got, midi);
});

test('unknown settings_category still falls back to #plugin-settings', () => {
    const midi = makeEl('plugin-settings-midi');
    const fallback = makeEl('plugin-settings');
    const got = runTarget({ settings_category: 'not-a-real-tab' }, [midi, fallback]);
    assert.equal(got, fallback);
});

test('fixture plugin with category midi injects into the midi mount', () => {
    const midi = makeEl('plugin-settings-midi');
    const fallback = makeEl('plugin-settings');
    const target = injectFixture(
        { id: 'keys', has_settings: true, settings_category: 'midi' },
        [midi, fallback],
    );
    assert.equal(target, midi);
    assert.equal(midi.children.length, 1);
    assert.equal(fallback.children.length, 0);
});

test('MIDI tab stays visible when no plugin declared settings.category midi', () => {
    const { midiBtn, known } = runVisibility([
        { id: 'career', settings_category: 'progression' },
        { id: 'plain', has_settings: true },
    ]);
    assert.equal(midiBtn.hidden, false);
    assert.ok(known.includes('midi'));
});

test('settings.js has no MIDI hide helper', () => {
    assert.doesNotMatch(SETTINGS_JS, /function syncMidiTabVisibility|function hideMidiTab/);
    assert.doesNotMatch(SETTINGS_JS, /data-tab="midi"/);
    assert.doesNotMatch(LOADER_JS, /syncMidiTabVisibility/);
});

test('Drums tab still hide-unless-declared (regression)', () => {
    const { drumsBtn, known } = runVisibility([
        { id: 'career', settings_category: 'progression' },
        { id: 'plain', has_settings: true },
    ]);
    assert.equal(drumsBtn.hidden, true);
    assert.ok(!known.includes('drums'));
    assert.ok(known.includes('midi'));
});

test('fixture plugin that declared drums still shows the Drums tab', () => {
    const { drumsBtn, midiBtn } = runVisibility([
        { id: 'drums', settings_category: 'drums' },
    ], { startHiddenDrums: true });
    assert.equal(drumsBtn.hidden, false);
    assert.equal(midiBtn.hidden, false);
});

test('no generic runtime tab-registration API is introduced', () => {
    assert.doesNotMatch(LOADER_JS, /registerSettingsTab|addSettingsCategory|registerTab\s*\(/);
    assert.doesNotMatch(SETTINGS_JS, /registerSettingsTab|addSettingsCategory|registerTab\s*\(/);
    assert.match(SETTINGS_JS, /function syncDrumsTabVisibility/);
    assert.doesNotMatch(SETTINGS_JS, /function syncMidiTabVisibility/);
});
