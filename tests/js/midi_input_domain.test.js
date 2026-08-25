const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createWindow, ROOT } = require('./capabilities_test_harness');

const CAPABILITIES_JS = path.join(ROOT, 'static', 'capabilities.js');
const MIDI_INPUT_JS = path.join(ROOT, 'static', 'capabilities', 'midi-input.js');

function loadMidiInput(options = {}) {
    const window = createWindow(options);
    const context = vm.createContext(window);
    vm.runInContext(fs.readFileSync(CAPABILITIES_JS, 'utf8'), context, { filename: CAPABILITIES_JS });
    vm.runInContext(fs.readFileSync(MIDI_INPUT_JS, 'utf8'), context, { filename: MIDI_INPUT_JS });
    return window;
}

// A fake provider whose enumerate/open/close are observable by the test.
function fakeProvider(window, overrides = {}) {
    const calls = { enumerate: 0, open: [], close: [] };
    window.feedBack.midiInput.registerProvider({
        providerId: 'web-midi',
        label: 'Web MIDI',
        participantId: 'input_setup',
        enumerate: async () => { calls.enumerate += 1; return overrides.sources || [{ sourceId: 'dev1', label: 'My Keyboard' }]; },
        open: async (sourceId) => { calls.open.push(sourceId); return { addListener() {}, removeListener() {}, _id: sourceId }; },
        close: (sourceId, handle) => { calls.close.push(sourceId); },
        ...overrides.handlers,
    });
    return calls;
}

test('midi-input registers an active sensitive provider-coordinator', () => {
    const window = loadMidiInput();
    const api = window.feedBack.capabilities;
    const pipeline = api.inspect('midi-input');
    assert.ok(pipeline, 'midi-input pipeline exists');
    const owner = (pipeline.participants || []).find(p => p.pluginId === 'core.midi-input');
    assert.ok(owner, 'core.midi-input owner registered');
    assert.equal(owner.safety, 'sensitive');
    assert.equal(owner.kind, 'provider-coordinator');
    for (const cmd of ['inspect', 'list-sources', 'discover', 'select-source', 'open-source', 'close-source']) {
        assert.ok(owner.commands.includes(cmd), `owner exposes ${cmd}`);
    }
    assert.equal(window.feedBack.midiInput.version, 1);
});

test('list-sources and select-source are prompt-free (never enumerate)', async () => {
    const window = loadMidiInput();
    const api = window.feedBack.capabilities;
    const calls = fakeProvider(window);
    const listed = await api.dispatch({ capability: 'midi-input', command: 'list-sources', source: 'tester' });
    assert.equal(listed.outcome, 'handled');
    assert.equal(calls.enumerate, 0, 'list-sources must not request MIDI access');
});

test('discover is the permission boundary and surfaces sources', async () => {
    const window = loadMidiInput();
    const api = window.feedBack.capabilities;
    const calls = fakeProvider(window);
    const r = await api.dispatch({ capability: 'midi-input', command: 'discover', source: 'tester' });
    assert.equal(r.outcome, 'handled');
    assert.equal(calls.enumerate, 1, 'discover requests MIDI access exactly once');
    const sources = window.feedBack.midiInput.listSources();
    assert.equal(sources.length, 1);
    assert.equal(sources[0].logicalSourceKey, 'web-midi::dev1');
    assert.equal(sources[0].kind, 'midi');
});

test('re-discovery drops sources for devices that vanished', async () => {
    const window = loadMidiInput();
    let devices = [{ sourceId: 'dev1', label: 'A' }, { sourceId: 'dev2', label: 'B' }];
    window.feedBack.midiInput.registerProvider({
        providerId: 'web-midi', label: 'Web MIDI',
        enumerate: async () => devices,
        open: async () => ({ addListener() {}, removeListener() {} }),
        close: () => {},
    });
    await window.feedBack.midiInput.discover();
    assert.equal(window.feedBack.midiInput.listSources().length, 2);
    devices = [{ sourceId: 'dev1', label: 'A' }];   // dev2 unplugged
    await window.feedBack.midiInput.discover();
    const keys = window.feedBack.midiInput.listSources().map((s) => s.logicalSourceKey);
    assert.equal(keys.length, 1, 'vanished device is dropped from the source list');
    assert.equal(keys[0], 'web-midi::dev1');
});

test('discover with no provider reports unavailable', async () => {
    const window = loadMidiInput();
    const api = window.feedBack.capabilities;
    const r = await api.dispatch({ capability: 'midi-input', command: 'discover', source: 'tester' });
    assert.equal(r.outcome, 'unavailable');
});

test('discover surfaces denied when MIDI access is rejected', async () => {
    const window = loadMidiInput();
    const api = window.feedBack.capabilities;
    fakeProvider(window, { handlers: { enumerate: async () => { throw new Error('SecurityError: permission denied'); } } });
    const r = await api.dispatch({ capability: 'midi-input', command: 'discover', source: 'tester' });
    assert.equal(r.outcome, 'denied');
    assert.match(r.reason, /denied/i);
});

test('select-source persists by logicalSourceKey', async () => {
    const window = loadMidiInput();
    const api = window.feedBack.capabilities;
    fakeProvider(window);
    await api.dispatch({ capability: 'midi-input', command: 'discover', source: 'tester' });
    const sel = await api.dispatch({ capability: 'midi-input', command: 'select-source', source: 'tester', payload: { logicalSourceKey: 'web-midi::dev1' } });
    assert.equal(sel.outcome, 'handled');
    assert.equal(window.__storage.get('feedBack.midiInput.selectedLogicalSourceKey'), 'web-midi::dev1');
    assert.ok(window.feedBack.midiInput.listSources()[0].selected);
});

test('open/close share one session and release on the last requester', async () => {
    const window = loadMidiInput();
    const api = window.feedBack.capabilities;
    const calls = fakeProvider(window);
    await window.feedBack.midiInput.discover();
    await window.feedBack.midiInput.select('web-midi::dev1');
    const a = await api.dispatch({ capability: 'midi-input', command: 'open-source', source: 'reqA', payload: { logicalSourceKey: 'web-midi::dev1' } });
    const b = await api.dispatch({ capability: 'midi-input', command: 'open-source', source: 'reqB', payload: { logicalSourceKey: 'web-midi::dev1' } });
    assert.equal(a.outcome, 'handled');
    assert.equal(b.outcome, 'handled');
    assert.equal(calls.open.length, 1, 'provider.open called once for a shared session');
    // First release keeps the session open; second closes it.
    await api.dispatch({ capability: 'midi-input', command: 'close-source', source: 'reqA', payload: { logicalSourceKey: 'web-midi::dev1' } });
    assert.equal(calls.close.length, 0, 'session stays open while a requester holds it');
    await api.dispatch({ capability: 'midi-input', command: 'close-source', source: 'reqB', payload: { logicalSourceKey: 'web-midi::dev1' } });
    assert.equal(calls.close.length, 1, 'provider.close after the last release');
});

test('concurrent opens for one source coalesce onto a single provider.open', async () => {
    const window = loadMidiInput();
    const api = window.feedBack.capabilities;
    // A provider whose open() stays pending until we release it, so both
    // dispatches are genuinely in flight at the same time.
    let release;
    const gate = new Promise((r) => { release = r; });
    const calls = { open: 0, close: 0 };
    window.feedBack.midiInput.registerProvider({
        providerId: 'web-midi', label: 'Web MIDI',
        enumerate: async () => [{ sourceId: 'dev1', label: 'My Keyboard' }],
        open: async () => { calls.open += 1; await gate; return { addListener() {}, removeListener() {} }; },
        close: () => { calls.close += 1; },
    });
    await window.feedBack.midiInput.discover();
    await window.feedBack.midiInput.select('web-midi::dev1');
    const p1 = api.dispatch({ capability: 'midi-input', command: 'open-source', source: 'reqA', payload: { logicalSourceKey: 'web-midi::dev1' } });
    const p2 = api.dispatch({ capability: 'midi-input', command: 'open-source', source: 'reqB', payload: { logicalSourceKey: 'web-midi::dev1' } });
    release();
    const [a, b] = await Promise.all([p1, p2]);
    assert.equal(a.outcome, 'handled');
    assert.equal(b.outcome, 'handled');
    assert.equal(calls.open, 1, 'provider.open called exactly once despite concurrent opens');
    // Both requesters joined the single shared session: it survives the first
    // release and only closes on the last, with exactly one provider.close.
    await api.dispatch({ capability: 'midi-input', command: 'close-source', source: 'reqA', payload: { logicalSourceKey: 'web-midi::dev1' } });
    assert.equal(calls.close, 0, 'shared session stays open while reqB holds it');
    await api.dispatch({ capability: 'midi-input', command: 'close-source', source: 'reqB', payload: { logicalSourceKey: 'web-midi::dev1' } });
    assert.equal(calls.close, 1, 'provider.close once after the last requester releases');
});

test('public open() surfaces the live handle (in-page only)', async () => {
    const window = loadMidiInput();
    fakeProvider(window);
    await window.feedBack.midiInput.discover();
    await window.feedBack.midiInput.select('web-midi::dev1');
    const res = await window.feedBack.midiInput.open({ requester: 'input_setup', logicalSourceKey: 'web-midi::dev1' });
    assert.equal(res.outcome, 'handled');
    assert.ok(res.handle && typeof res.handle.addListener === 'function', 'live handle exposed via public global');
});

// Load the domain with a Web-MIDI-capable navigator so the built-in provider
// self-registers (the shared harness has no navigator, so it normally skips).
function loadWithWebMidi(inputs) {
    const window = createWindow();
    window.isSecureContext = true;
    window.navigator = {
        requestMIDIAccess: async () => ({
            onstatechange: null,
            inputs: new Map(inputs.map((i) => [i.id, i])),
        }),
    };
    const context = vm.createContext(window);
    vm.runInContext(fs.readFileSync(CAPABILITIES_JS, 'utf8'), context, { filename: CAPABILITIES_JS });
    vm.runInContext(fs.readFileSync(MIDI_INPUT_JS, 'utf8'), context, { filename: MIDI_INPUT_JS });
    return window;
}

test('built-in Web-MIDI open shares one dispatcher (second open does not drop listeners)', async () => {
    const port = {
        id: 'kb1',
        name: 'My Keyboard',
        onmidimessage: null,
        opened: 0,
        async open() { this.opened += 1; },
    };
    const window = loadWithWebMidi([port]);
    await window.feedBack.midiInput.discover();
    const a = await window.feedBack.midiInput.open({ requester: 'learn', logicalSourceKey: 'web-midi::kb1' });
    const seen = [];
    a.handle.addListener((d) => seen.push(Array.from(d.data)));
    const b = await window.feedBack.midiInput.open({ requester: 'drums', logicalSourceKey: 'web-midi::kb1' });
    assert.ok(b.handle);
    port.onmidimessage({ data: new Uint8Array([0x99, 38, 100]) });
    assert.deepEqual(seen, [[0x99, 38, 100]]);
    assert.ok(port.opened >= 1, 'MIDIPort.open() must run so Chrome starts the stream');
});

test('watchMessages sees hits after discover without a session open', async () => {
    const port = {
        id: 'kb1',
        name: 'Alesis Prime Drum Module MIDI',
        onmidimessage: null,
        addEventListener() {},
        removeEventListener() {},
        async open() { this.opened = true; },
    };
    const window = loadWithWebMidi([port]);
    const seen = [];
    window.feedBack.midiInput.watchMessages((m) => seen.push(m));
    await window.feedBack.midiInput.discover();
    assert.equal(typeof port.onmidimessage, 'function');
    port.onmidimessage({ data: new Uint8Array([0x99, 38, 100]) });
    const hits = seen.filter((m) => m && m.data && m.data[1] === 38);
    assert.equal(hits.length, 1);
    assert.equal(hits[0].label, 'Alesis Prime Drum Module MIDI');
});

test('second discover reuses MIDIAccess and keeps onmidimessage', async () => {
    let calls = 0;
    const port = {
        id: 'kb1',
        name: 'Kit',
        onmidimessage: null,
        async open() { this.opened = true; },
    };
    const window = createWindow();
    window.isSecureContext = true;
    window.navigator = {
        requestMIDIAccess: async () => {
            calls += 1;
            return { onstatechange: null, inputs: new Map([[port.id, port]]) };
        },
    };
    const context = vm.createContext(window);
    vm.runInContext(fs.readFileSync(CAPABILITIES_JS, 'utf8'), context, { filename: CAPABILITIES_JS });
    vm.runInContext(fs.readFileSync(MIDI_INPUT_JS, 'utf8'), context, { filename: MIDI_INPUT_JS });
    await window.feedBack.midiInput.discover();
    const handler = port.onmidimessage;
    await window.feedBack.midiInput.discover();
    assert.equal(calls, 1, 'requestMIDIAccess must run once');
    assert.equal(typeof handler, 'function');
    assert.equal(port.onmidimessage, handler, 'Detect must not replace the live handler');
});

test('attaches onmidimessage before MIDIPort.open resolves', async () => {
    let resolveOpen;
    const port = {
        id: 'kb1',
        name: 'Kit',
        onmidimessage: null,
        open() { return new Promise((r) => { resolveOpen = r; }); },
    };
    const window = loadWithWebMidi([port]);
    const pending = window.feedBack.midiInput.discover();
    for (let i = 0; i < 80 && typeof port.onmidimessage !== 'function'; i += 1) {
        await Promise.resolve();
    }
    assert.equal(typeof port.onmidimessage, 'function',
        'listeners must attach even while open() is pending');
    resolveOpen();
    await pending;
});

test('built-in Web-MIDI provider self-registers + discovers, filtering loopback ports', async () => {
    const window = loadWithWebMidi([
        { id: 'kb1', name: 'My Keyboard' },
        { id: 'thru', name: 'Midi Through Port-0' }, // loopback → filtered out
    ]);
    const api = window.feedBack.capabilities;
    assert.ok(api.inspect('midi-input').participants.some(p => p.pluginId === 'core.midi-input'),
        'built-in provider registered without any plugin');
    const r = await api.dispatch({ capability: 'midi-input', command: 'discover', source: 'tester' });
    assert.equal(r.outcome, 'handled');
    const sources = window.feedBack.midiInput.listSources();
    assert.equal(sources.length, 1, 'loopback/passthrough ports are filtered');
    assert.equal(sources[0].logicalSourceKey, 'web-midi::kb1');
});

test('ac-1: listeners receive { data, timeStamp } from the DOM event', async () => {
    const port = {
        id: 'kb1',
        name: 'Kit',
        onmidimessage: null,
        async open() { this.opened = true; },
    };
    const window = loadWithWebMidi([port]);
    await window.feedBack.midiInput.discover();
    const opened = await window.feedBack.midiInput.open({
        requester: 'cal',
        logicalSourceKey: 'web-midi::kb1',
    });
    const seen = [];
    opened.handle.addListener((msg) => seen.push(msg));
    port.onmidimessage({ data: new Uint8Array([0x99, 38, 100]), timeStamp: 1234.5 });
    assert.equal(seen.length, 1);
    assert.ok(seen[0].data);
    assert.deepEqual(Array.from(seen[0].data), [0x99, 38, 100]);
    assert.equal(seen[0].timeStamp, 1234.5);
    assert.equal(seen[0].lowConfidence, false);
});

test('ac-1: missing/0 timeStamp falls back and flags low-confidence', async () => {
    const port = {
        id: 'kb1',
        name: 'Kit',
        onmidimessage: null,
        async open() { this.opened = true; },
    };
    const window = loadWithWebMidi([port]);
    await window.feedBack.midiInput.discover();
    const opened = await window.feedBack.midiInput.open({
        requester: 'cal',
        logicalSourceKey: 'web-midi::kb1',
    });
    const seen = [];
    opened.handle.addListener((msg) => seen.push(msg));
    port.onmidimessage({ data: new Uint8Array([0x99, 38, 100]) });
    port.onmidimessage({ data: new Uint8Array([0x99, 38, 90]), timeStamp: 0 });
    port.onmidimessage({ data: new Uint8Array([0x99, 38, 80]), timeStamp: Number.NaN });
    assert.equal(seen.length, 3);
    for (const msg of seen) {
        assert.equal(msg.timeStamp, 0);
        assert.equal(msg.lowConfidence, true);
        assert.ok(Number.isFinite(msg.timeStamp));
    }
});

test('watchMessages includes timeStamp on the live fan-out', async () => {
    const port = {
        id: 'kb1',
        name: 'Kit',
        onmidimessage: null,
        async open() { this.opened = true; },
    };
    const window = loadWithWebMidi([port]);
    const seen = [];
    window.feedBack.midiInput.watchMessages((m) => seen.push(m));
    await window.feedBack.midiInput.discover();
    port.onmidimessage({ data: new Uint8Array([0x99, 36, 80]), timeStamp: 88 });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].timeStamp, 88);
    assert.equal(seen[0].lowConfidence, false);
    assert.equal(seen[0].data[1], 36);
});

test('diagnostics are redaction-safe (no device labels, no raw messages)', async () => {
    const window = loadMidiInput();
    fakeProvider(window);
    await window.feedBack.midiInput.discover();
    const contrib = window.feedBack.diagnostics.snapshotContributions()['midi-input-capability'];
    assert.ok(contrib, 'midi-input contributes diagnostics');
    assert.equal(contrib.schema, 'feedBack.midi_input.diagnostics.v1');
    const serialized = JSON.stringify(contrib);
    assert.ok(!serialized.includes('My Keyboard'), 'device labels are redacted from diagnostics');
    for (const s of contrib.sources) assert.ok(!('label' in s), 'source entries carry no label');
});

function seedSecureContextWarning(window, origin) {
    const el = {
        id: 'midi-secure-context-warning',
        textContent: '',
        hidden: true,
        className: 'hidden text-xs text-gray-300 mb-3',
        attributes: { role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' },
        setAttribute(k, v) { this.attributes[k] = String(v); },
        getAttribute(k) { return this.attributes[k] || null; },
        classList: {
            remove(c) {
                if (c === 'hidden') {
                    el.hidden = false;
                    el.className = el.className.replace(/\bhidden\b/g, '').trim();
                }
            },
        },
    };
    window.__elements.set('midi-secure-context-warning', el);
    window.location = { origin: origin };
    return el;
}

test('INIT-006/SPEC-002: insecure origin warns and never calls requestMIDIAccess', async () => {
    let midiCalls = 0;
    const window = createWindow({ isSecureContext: false });
    const warning = seedSecureContextWarning(window, 'http://192.168.1.10:8000');
    window.navigator = {
        requestMIDIAccess: async () => {
            midiCalls += 1;
            throw new Error('requestMIDIAccess must not run on an insecure origin');
        },
    };
    const context = vm.createContext(window);
    vm.runInContext(fs.readFileSync(CAPABILITIES_JS, 'utf8'), context, { filename: CAPABILITIES_JS });
    vm.runInContext(fs.readFileSync(MIDI_INPUT_JS, 'utf8'), context, { filename: MIDI_INPUT_JS });
    assert.equal(midiCalls, 0, 'must not request MIDI access while !isSecureContext');
    assert.match(warning.textContent, /Warning:/);
    assert.match(warning.textContent, /HTTPS or localhost/);
    assert.match(warning.textContent, /http:\/\/192\.168\.1\.10:8000/);
    assert.equal(warning.hidden, false);
    assert.equal(warning.getAttribute('aria-live'), 'polite');
    assert.ok(!/\bhidden\b/.test(warning.className), 'color is not the only signal: warning is unhidden');
    if (window.feedBack.midiInput && typeof window.feedBack.midiInput.discover === 'function') {
        await window.feedBack.midiInput.discover();
    }
    assert.equal(midiCalls, 0, 'discover must still skip requestMIDIAccess');
});

test('INIT-006/SPEC-002: localhost remains a secure context (no warning)', async () => {
    const window = createWindow({ isSecureContext: true, location: { origin: 'http://localhost:8000' } });
    const warning = seedSecureContextWarning(window, 'http://localhost:8000');
    window.navigator = {
        requestMIDIAccess: async () => ({
            onstatechange: null,
            inputs: new Map(),
        }),
    };
    const context = vm.createContext(window);
    vm.runInContext(fs.readFileSync(CAPABILITIES_JS, 'utf8'), context, { filename: CAPABILITIES_JS });
    vm.runInContext(fs.readFileSync(MIDI_INPUT_JS, 'utf8'), context, { filename: MIDI_INPUT_JS });
    assert.equal(warning.textContent, '');
    assert.equal(warning.hidden, true);
    await window.feedBack.midiInput.discover();
});

test('INIT-006/SPEC-002: Settings MIDI warning is a live region (color is not the only signal)', () => {
    const html = fs.readFileSync(path.join(ROOT, 'static', 'v3', 'index.html'), 'utf8');
    assert.match(html, /id="midi-secure-context-warning"/);
    assert.match(html, /id="midi-secure-context-warning"[^>]*aria-live="polite"/);
    assert.match(html, /id="midi-secure-context-warning"[^>]*role="status"/);
    const midiJs = fs.readFileSync(MIDI_INPUT_JS, 'utf8');
    assert.match(midiJs, /isSecureContext/);
    assert.match(midiJs, /HTTPS or localhost/);
    assert.match(midiJs, /_warnInsecureMidiOrigin\(\)/);
    assert.match(midiJs, /if\s*\(!_midiOriginIsSecure\(\)\)/);
});
