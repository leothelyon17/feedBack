'use strict';

// INIT-004/SPEC-001: onboarding drums hook + Calibration host + no WS/settings leak.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const SETUP_JS = fs.readFileSync(path.join(ROOT, 'plugins', 'input_setup', 'screen.js'), 'utf8');
const V3_HTML = fs.readFileSync(path.join(ROOT, 'static', 'v3', 'index.html'), 'utf8');
const TAP_JS = fs.readFileSync(path.join(ROOT, 'static', 'js', 'tap-to-beat.js'), 'utf8');
const MIDI_INPUT_JS = fs.readFileSync(path.join(ROOT, 'static', 'capabilities', 'midi-input.js'), 'utf8');
const MIDI_DEVICES_JS = fs.readFileSync(path.join(ROOT, 'static', 'capabilities', 'midi-devices.js'), 'utf8');

test('ac-8: MIDI tab has Calibration head after #midi-devices-panel', () => {
    const devicesAt = V3_HTML.indexOf('id="midi-devices-panel"');
    const calibHeadAt = V3_HTML.indexOf('<h3>Calibration</h3>');
    const calibPanelAt = V3_HTML.indexOf('id="midi-calibration-panel"');
    const pluginAt = V3_HTML.indexOf('id="plugin-settings-midi"');
    assert.ok(devicesAt !== -1 && calibHeadAt !== -1 && calibPanelAt !== -1);
    assert.ok(calibHeadAt > devicesAt, 'Calibration heading must follow MIDI devices panel');
    assert.ok(calibPanelAt > calibHeadAt, '#midi-calibration-panel must follow the Calibration heading');
    assert.ok(pluginAt > calibPanelAt, 'plugin mount stays after the Calibration host');
    const headSlice = V3_HTML.slice(calibHeadAt - 80, calibHeadAt);
    assert.match(headSlice, /fb-tabpanel-head/);
    assert.doesNotMatch(V3_HTML, /Drum timing/);
});

test('ac-8: tap-to-beat script is included in v3 index', () => {
    assert.match(V3_HTML, /\/static\/js\/tap-to-beat\.js/);
});

test('ac-10: drums path launches drumTiming.run overlay when defined', () => {
    assert.match(SETUP_JS, /drumTiming\.run/);
    assert.match(SETUP_JS, /requester:\s*'onboarding'/);
    assert.match(SETUP_JS, /mode:\s*'overlay'/);
    const drumsHook = SETUP_JS.indexOf("inst === 'drums'");
    const keysVerb = SETUP_JS.indexOf("inst === 'drums' ? 'hit a pad'");
    assert.ok(drumsHook !== -1);
    assert.ok(keysVerb > drumsHook, 'keys/missing-module path must remain after the overlay hook');
    assert.match(SETUP_JS, /hit a pad/);
    assert.match(SETUP_JS, /play a note/);
});

test('ac-10: keys path does not call drumTiming.run', () => {
    const renderMidiAt = SETUP_JS.indexOf('async function renderMidiPanel');
    assert.ok(renderMidiAt !== -1);
    const midiFn = SETUP_JS.slice(renderMidiAt, SETUP_JS.indexOf('function _emitOwner', renderMidiAt));
    assert.doesNotMatch(midiFn, /drumTiming\.run/);
    assert.match(midiFn, /play a note|hit a pad/);
});

test('ac-11: no new /api/settings drum field and no /ws frames in SPEC-001 files', () => {
    for (const [name, src] of [
        ['tap-to-beat.js', TAP_JS],
        ['input_setup/screen.js', SETUP_JS],
        ['midi-input.js', MIDI_INPUT_JS],
        ['midi-devices.js', MIDI_DEVICES_JS],
    ]) {
        assert.doesNotMatch(src, /\/ws\/highway|\/ws\/sync/, name + ' must not add /ws frames');
        assert.doesNotMatch(src, /drum_offset_ms|drum_timing_ms/, name + ' must not add a settings drum key');
    }
    // midi-devices activate still POSTs active_midi_device only — no drum offset key.
    const settingsPosts = MIDI_DEVICES_JS.match(/\/api\/settings/g) || [];
    assert.ok(settingsPosts.length >= 1);
    assert.match(MIDI_DEVICES_JS, /active_midi_device/);
    assert.doesNotMatch(MIDI_DEVICES_JS, /av_offset_ms/);
});
