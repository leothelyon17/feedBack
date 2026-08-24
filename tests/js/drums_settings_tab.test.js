// INIT-003/SPEC-003: Settings → Drums host stub.
//
// Source-scan + vm harness (no jsdom). Covers the loader target, hide-unless-
// declared tab visibility, fixture injection into #plugin-settings-drums,
// unknown-category fallback, and both-2D-and-3D sibling mounts.

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

function runVisibility(plugins, { startHidden = true, startActive = 'gameplay' } = {}) {
    const drumsBtn = makeTab('drums', startHidden);
    const systemBtn = makeTab('system', false);
    const gameplayBtn = makeTab('gameplay', false);
    if (startActive === 'drums') drumsBtn.classList._active = true;
    else gameplayBtn.classList._active = true;
    const tabs = [gameplayBtn, systemBtn, drumsBtn];
    const panels = [makePanel('gameplay'), makePanel('system'), makePanel('drums')];
    const sandbox = {
        DEFAULT_TAB: 'gameplay',
        plugins,
        document: {
            querySelector(sel) {
                if (sel === '#settings-tabbar .fb-tab[data-tab="drums"]') return drumsBtn;
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
        + 'syncDrumsTabVisibility(plugins);\n',
        sandbox,
    );
    return { drumsBtn, gameplayBtn, tabs };
}

test('Drums tab button sits after System and matches the existing tablist', () => {
    const barStart = V3_HTML.indexOf('id="settings-tabbar"');
    assert.ok(barStart !== -1, 'settings-tabbar missing');
    const barEnd = V3_HTML.indexOf('</div>', barStart);
    const bar = V3_HTML.slice(barStart, barEnd);
    const systemAt = bar.indexOf('data-tab="system"');
    const drumsAt = bar.indexOf('data-tab="drums"');
    assert.ok(systemAt !== -1 && drumsAt !== -1, 'System or Drums tab missing');
    assert.ok(drumsAt > systemAt, 'Drums tab must appear after System');
    assert.match(bar, /<button type="button" class="fb-tab" data-tab="drums"/);
});

test('mount #plugin-settings-drums exists in the Drums panel', () => {
    assert.match(V3_HTML, /id="plugin-settings-drums"/);
    const lastPanelAt = V3_HTML.lastIndexOf('<div class="fb-tabpanel" data-tab="drums">');
    assert.ok(lastPanelAt !== -1, 'Drums tabpanel missing');
    const mountAt = V3_HTML.indexOf('id="plugin-settings-drums"', lastPanelAt);
    assert.ok(mountAt > lastPanelAt, 'mount must live inside the Drums tabpanel');
});

test('_PLUGIN_SETTINGS_CONTAINER_IDS includes plugin-settings-drums', () => {
    const ids = vm.runInNewContext(
        extractConstArray(LOADER_JS, '_PLUGIN_SETTINGS_CONTAINER_IDS')
        + '\n_PLUGIN_SETTINGS_CONTAINER_IDS',
    );
    assert.ok(ids.includes('plugin-settings-drums'));
});

test('_pluginSettingsTarget(drums) resolves to #plugin-settings-drums', () => {
    const drums = makeEl('plugin-settings-drums');
    const fallback = makeEl('plugin-settings');
    const got = runTarget({ settings_category: 'drums' }, [drums, fallback]);
    assert.equal(got, drums);
});

test('unknown settings_category still falls back to #plugin-settings', () => {
    const drums = makeEl('plugin-settings-drums');
    const fallback = makeEl('plugin-settings');
    const got = runTarget({ settings_category: 'not-a-real-tab' }, [drums, fallback]);
    assert.equal(got, fallback);
});

test('missing settings_category falls back to #plugin-settings', () => {
    const drums = makeEl('plugin-settings-drums');
    const fallback = makeEl('plugin-settings');
    const got = runTarget({ id: 'plain' }, [drums, fallback]);
    assert.equal(got, fallback);
});

test('fixture plugin with category drums injects into the drums mount', () => {
    const drums = makeEl('plugin-settings-drums');
    const fallback = makeEl('plugin-settings');
    const target = injectFixture(
        { id: 'drums', has_settings: true, settings_category: 'drums' },
        [drums, fallback],
    );
    assert.equal(target, drums);
    assert.equal(drums.children.length, 1);
    assert.equal(fallback.children.length, 0);
});

test('fixture without drums leaves the Drums tab hidden', () => {
    const { drumsBtn } = runVisibility([
        { id: 'career', settings_category: 'progression' },
        { id: 'plain', has_settings: true },
    ]);
    assert.equal(drumsBtn.hidden, true);
});

test('fixture plugin that declared drums shows the Drums tab', () => {
    const { drumsBtn } = runVisibility([
        { id: 'drums', settings_category: 'drums' },
    ], { startHidden: true });
    assert.equal(drumsBtn.hidden, false);
});

test('_pluginSettingsLabel names the drums plugin Profiles', () => {
    const sandbox = { result: null };
    vm.createContext(sandbox);
    vm.runInContext(
        extractFunction(LOADER_JS, '_pluginSettingsLabel') + '\n'
        + 'result = [_pluginSettingsLabel({ id: "drums", name: "Drum Highway" }),'
        + '_pluginSettingsLabel({ id: "drum_highway_3d", name: "3D Drum Highway" })];\n',
        sandbox,
    );
    assert.equal(sandbox.result[0], 'Profiles');
    assert.equal(sandbox.result[1], '3D Drum Highway');
});

test('both 2D and 3D declaring drums mount as siblings without crashing', () => {
    const drums = makeEl('plugin-settings-drums');
    const fallback = makeEl('plugin-settings');
    injectFixture(
        { id: 'drums', has_settings: true, settings_category: 'drums' },
        [drums, fallback],
    );
    injectFixture(
        { id: 'highway_3d', has_settings: true, settings_category: 'drums' },
        [drums, fallback],
    );
    assert.equal(drums.children.length, 2);
    assert.deepEqual(drums.children.map((c) => c.pluginId), ['drums', 'highway_3d']);
    assert.equal(fallback.children.length, 0);
    const { drumsBtn } = runVisibility([
        { id: 'drums', settings_category: 'drums' },
        { id: 'highway_3d', settings_category: 'drums' },
    ]);
    assert.equal(drumsBtn.hidden, false);
});

test('3D-only fixture that declared drums shows the Drums tab (INIT-003/SPEC-006)', () => {
    const manifest = JSON.parse(fs.readFileSync(
        path.join(ROOT, 'plugins', 'drum_highway_3d', 'plugin.json'),
        'utf8',
    ));
    assert.equal(manifest.settings.category, 'drums');
    const { drumsBtn } = runVisibility([
        { id: 'drum_highway_3d', settings_category: manifest.settings.category },
    ], { startHidden: true });
    assert.equal(drumsBtn.hidden, false);
});

test('no generic runtime tab-registration API is introduced', () => {
    assert.doesNotMatch(LOADER_JS, /registerSettingsTab|addSettingsCategory|registerTab\s*\(/);
    assert.doesNotMatch(SETTINGS_JS, /registerSettingsTab|addSettingsCategory|registerTab\s*\(/);
    assert.match(SETTINGS_JS, /function syncDrumsTabVisibility/);
});
