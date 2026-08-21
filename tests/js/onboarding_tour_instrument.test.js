'use strict';

// INIT-001/SPEC-004: home onboarding tour skips the tuner step when
// player_instrument is drums. Unset / guitar / keys keep the SPEC-003 list.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..', '..');
const SRC = fs.readFileSync(path.join(ROOT, 'static', 'v3', 'onboarding-tour.js'), 'utf8');

function loadTour(playerInstrument) {
    const win = {
        v3Badges: {
            getPlayerInstrument() { return playerInstrument; },
        },
        feedBackTour: {
            register() { return true; },
            start() {},
            hasSeen() { return false; },
            hasDismissed() { return false; },
        },
        feedBack: { on() {}, off() {} },
        v3OnboardingTour: undefined,
    };
    const sandbox = {
        window: win,
        document: {
            readyState: 'complete',
            addEventListener() {},
            removeEventListener() {},
        },
        setTimeout() { return 0; },
        console,
    };
    vm.createContext(sandbox);
    vm.runInContext(SRC, sandbox);
    return sandbox.window.v3OnboardingTour;
}

function stepIds(tour) {
    // Copy out of the vm realm so node:assert/strict can deep-equal host arrays.
    return Array.prototype.map.call(tour.buildSteps(), (s) => String(s.id));
}

test('unset player_instrument keeps the tuner tour step (SPEC-003 baseline)', () => {
    const ids = stepIds(loadTour(null));
    assert.ok(ids.includes('tuner'));
    assert.ok(ids.includes('instrument'));
    assert.deepEqual(ids, ['hero', 'continue', 'instrument', 'tuner', 'audio', 'profile', 'nav']);
});

test('guitar player_instrument keeps the tuner tour step', () => {
    const ids = stepIds(loadTour('guitar'));
    assert.ok(ids.includes('tuner'));
    assert.deepEqual(ids, ['hero', 'continue', 'instrument', 'tuner', 'audio', 'profile', 'nav']);
});

test('keys player_instrument does not hide the tuner tour step', () => {
    const ids = stepIds(loadTour('keys'));
    assert.ok(ids.includes('tuner'));
});

test('drums player_instrument skips only the tuner tour step', () => {
    const ids = stepIds(loadTour('drums'));
    assert.ok(!ids.includes('tuner'));
    assert.ok(ids.includes('instrument'));
    assert.ok(ids.includes('audio'));
    assert.deepEqual(ids, ['hero', 'continue', 'instrument', 'audio', 'profile', 'nav']);
});

test('filterTourSteps is a no-op for unset and guitar', () => {
    const tour = loadTour(null);
    const steps = [
        { id: 'instrument' },
        { id: 'tuner' },
        { id: 'audio' },
    ];
    const ids = function (inst) {
        return Array.prototype.map.call(tour.filterTourSteps(steps, inst), (s) => String(s.id));
    };
    assert.deepEqual(ids(null), ['instrument', 'tuner', 'audio']);
    assert.deepEqual(ids('guitar'), ['instrument', 'tuner', 'audio']);
    assert.deepEqual(ids('drums'), ['instrument', 'audio']);
});

test('Settings and Pedalboard nav are not gated on player_instrument', () => {
    const shell = fs.readFileSync(path.join(ROOT, 'static', 'v3', 'shell.js'), 'utf8');
    assert.match(shell, /screen:\s*'settings'/);
    assert.match(shell, /screen:\s*'v3-plugins'/);
    assert.doesNotMatch(shell, /player_instrument/);
    const html = fs.readFileSync(path.join(ROOT, 'static', 'v3', 'index.html'), 'utf8');
    assert.match(html, /id="setting-player-instrument"/);
    assert.match(html, /Main instrument/);
    const row = html.match(/Main instrument[\s\S]{0,900}id="setting-player-instrument"/);
    assert.ok(row, 'Main instrument label should sit with the player_instrument control');
    assert.doesNotMatch(row[0], /profile/i);
});
