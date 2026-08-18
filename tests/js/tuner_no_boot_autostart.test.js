'use strict';

// INIT-001/SPEC-003: tuner plugin boot must not acquire mic / AudioContext.
// enable() (badge click, floating button, explicit enable) still starts audio,
// and disable() may resume background capture after that gesture.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..', '..');
const TUNER_SCREEN_JS = path.join(ROOT, 'plugins', 'tuner', 'screen.js');
const TUNING_UTILS_JS = path.join(ROOT, 'plugins', 'tuner', 'utils', 'tuning-utils.js');
const SRC = fs.readFileSync(TUNER_SCREEN_JS, 'utf8');

function flushMicrotasks() {
    return new Promise((resolve) => queueMicrotask(resolve));
}

function el() {
    return {
        classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
        querySelector: () => null, appendChild() {}, remove() {}, style: {},
    };
}

function createSandbox() {
    const startCalls = [];
    const sandbox = {
        console,
        Promise,
        queueMicrotask,
        setTimeout(fn) { fn(); return 0; },
        clearTimeout() {},
        fetch() {
            return Promise.resolve({
                json: () => Promise.resolve({
                    visualizationMode: 'default',
                    audioInputMode: 'auto',
                    autoOpenOnTuningChange: false,
                    lastInstrument: 'guitar-6',
                    lastTuning: 'Standard',
                    freeTune: false,
                    customTunings: {},
                    tunings: { 'guitar-6': { Standard: [82.41, 110, 146.83, 196, 246.94, 329.63] } },
                    referencePitch: 440,
                }),
            });
        },
        localStorage: { getItem: () => null, setItem() {} },
        document: {
            getElementById() { return null; },
            querySelector() { return null; },
            createElement(tag) {
                const node = {
                    tagName: tag.toUpperCase(),
                    src: '',
                    onload: null,
                    onerror: null,
                };
                if (tag === 'script') {
                    queueMicrotask(() => { if (node.onload) node.onload(); });
                }
                return node;
            },
            head: { appendChild() {} },
            body: { appendChild() {} },
            addEventListener() {},
            removeEventListener() {},
        },
    };
    sandbox.window = sandbox;
    sandbox.window.feedBack = { on() {}, off() {} };
    sandbox.window.v3Badges = { renderTuner() { sandbox.__badgeRenders += 1; } };
    sandbox.__badgeRenders = 0;
    sandbox.window._tunerUI = (state) => {
        state.uiContainer = el();
        state.vizContainer = el();
        state.skipBtn = el();
        state.closeBtn = el();
        state.backBtn = el();
        return {
            addButton() {},
            initUI() {},
            renderInstrumentOptions() {},
            renderTuningOptions() {},
            renderStringNotes() {},
            updateSaveAsCustomVisibility() {},
            updateFreeTuneUI() {},
            updateFloatingButton() {},
            updatePlayerButton() {},
            updateFloatingButtonVisibility() {},
            updateInstrumentDisplay() {},
            positionPanel() {},
            updateUI() {},
            showMicError() {},
        };
    };
    sandbox.window._tunerAudio = {
        start: async (...args) => { startCalls.push(args); },
        stop() {},
        restart: async () => {},
    };
    sandbox.window._tunerViz_default = () => ({ update() {}, destroy() {} });
    sandbox.__startCalls = startCalls;
    vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(TUNING_UTILS_JS, 'utf8'), sandbox);
    vm.runInContext(SRC, sandbox);
    return sandbox;
}

test('boot block does not call _tunerAudio.start', () => {
    const boot = SRC.match(/\/\/ Boot: load scripts[\s\S]*?\}\)\.catch\(e => console\.error\(e\)\);/);
    assert.ok(boot, 'boot Promise.all block must exist');
    assert.doesNotMatch(boot[0], /_tunerAudio\.start/);
    assert.doesNotMatch(SRC, /Auto-start audio so the v3 badge/);
});

test('plugin boot does not invoke _tunerAudio.start until enable()', async () => {
    const sandbox = createSandbox();
    assert.equal(sandbox.__badgeRenders, 1, 'late-load handshake calls v3Badges.renderTuner');
    await flushMicrotasks();
    await flushMicrotasks();
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(sandbox.__startCalls.length, 0, 'no boot-time start()');

    await sandbox.window.tuner.enable();
    assert.ok(sandbox.__startCalls.length >= 1, 'enable() still starts audio');
});
