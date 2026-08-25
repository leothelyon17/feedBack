// INIT-001/SPEC-006: 3D highway vocabulary parity.
// Fixture is generated at test time from lib/drums.py PIECES — not a fourth
// hand-copied table. screen.js is vm-loaded (no DOM / WebGL / network).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const SCREEN = path.join(__dirname, '..', 'screen.js');

function dumpCoreVocabulary() {
    const env = Object.assign({}, process.env, {
        PYTHONPATH: path.join(REPO_ROOT, 'lib'),
    });
    const src = [
        'import json, drums',
        'print(json.dumps({"pieces": {k: {"midi": list(v["midi"])} for k, v in drums.PIECES.items()}}))',
    ].join('; ');
    const out = execFileSync('python3', ['-c', src], {
        cwd: REPO_ROOT,
        env,
        encoding: 'utf8',
    });
    return JSON.parse(out);
}

function firstWinsMidi(pieces) {
    const map = Object.create(null);
    for (const [pid, meta] of Object.entries(pieces)) {
        for (const n of meta.midi || []) {
            if (map[n] === undefined) map[n] = pid;
        }
    }
    return map;
}

function load(opts) {
    const store = opts && opts.store;
    const window = {
        console,
        location: { protocol: 'http:', host: 'localhost' },
        slopsmith: {},
    };
    if (store) {
        window.localStorage = {
            getItem(k) {
                return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null;
            },
            setItem(k, v) { store[k] = String(v); },
            removeItem(k) { delete store[k]; },
        };
    }
    window.window = window;
    window.globalThis = window;
    const context = vm.createContext(window);
    vm.runInContext(fs.readFileSync(SCREEN, 'utf8'), context, { filename: 'screen.js' });
    return {
        window,
        __test: window.slopsmithViz_drum_highway_3d.__test,
    };
}

function jsonOk(body) {
    return { ok: true, json: async () => body };
}
function jsonFail() {
    return { ok: false, json: async () => null };
}

test('ac-1: effective piece-id set equals PIECES keys when vocabulary is applied', () => {
    const vocab = dumpCoreVocabulary();
    const { __test } = load();
    assert.equal(__test._applyVocabulary(vocab), true);
    const got = new Set(__test._effectivePieceIds());
    const expected = new Set(Object.keys(vocab.pieces));
    assert.deepEqual([...got].sort(), [...expected].sort());
    assert.ok(got.has('stack'), 'stack must be known once vocabulary is applied');
    assert.ok(got.has('bell'), 'bell must be known once vocabulary is applied');
});

test('ac-2: vocabulary MIDI lookup follows core PIECES (first-wins); fallback map stays', () => {
    const vocab = dumpCoreVocabulary();
    const { __test } = load();
    assert.equal(__test._midiToPiece(38), 'snare');
    assert.equal(__test.MIDI_TO_PIECE[58], 'tom_low');
    assert.equal(__test._applyVocabulary(vocab), true);
    const expected = firstWinsMidi(vocab.pieces);
    for (const [n, pid] of Object.entries(expected)) {
        assert.equal(__test._midiToPiece(Number(n)), pid, 'MIDI ' + n);
    }
    assert.equal(__test._midiToPiece(30), 'stack');
    assert.equal(__test._midiToPiece(80), 'bell');
    // Notes core does not list still fall through to MIDI_TO_PIECE (delete nothing).
    assert.equal(__test._midiToPiece(58), 'tom_low');
    assert.equal(__test.MIDI_TO_PIECE[58], 'tom_low');
});

test('ac-2: fetch failure keeps MIDI_TO_PIECE (GM 38 → snare)', async () => {
    const { __test } = load();
    const result = await __test._consumeCoreVocabulary(async () => { throw new Error('offline'); });
    assert.equal(result.vocabulary, false);
    assert.equal(result.activeKit, false);
    assert.equal(__test._midiToPiece(38), 'snare');
    assert.equal(__test._midiToPiece(42), 'hh_closed');
    assert.equal(__test._midiToPiece(30), undefined);
    const ids = new Set(__test._effectivePieceIds());
    assert.equal(ids.has('stack'), false);
    assert.equal(ids.has('bell'), false);
});

test('ac-2: HTTP 404 vocabulary is the same as fetch-failed fallback', async () => {
    const { __test } = load();
    const result = await __test._consumeCoreVocabulary(async () => jsonFail());
    assert.equal(result.vocabulary, false);
    assert.equal(__test._midiToPiece(38), 'snare');
});

test('ac-3: ALL_PIECES / MIDI_TO_PIECE / LS_KIT_CONFIG remain after consume', async () => {
    const vocab = dumpCoreVocabulary();
    const { __test } = load();
    await __test._consumeCoreVocabulary(async (url) => {
        if (url === '/api/drums/vocabulary') return jsonOk(vocab);
        if (url === '/api/settings') return jsonOk({});
        return jsonFail();
    });
    assert.equal(__test.LS_KIT_CONFIG, 'drum_h3d_kit_v1');
    assert.equal(__test.MIDI_TO_PIECE[38], 'snare');
    assert.equal(__test.MIDI_TO_PIECE[35], 'kick');
    const local = [...__test.ALL_PIECES];
    assert.ok(local.includes('kick') && local.includes('snare'));
    assert.equal(local.includes('stack'), false, 'fallback table is kept, not rewritten');
    assert.equal(local.includes('bell'), false);
});

test('ac-4: unset active_kit keeps drum_h3d_kit_v1 lanes/fallbacks', async () => {
    const custom = {
        version: 1,
        name: 'User 3-piece',
        lanes: [
            { piece: 'hh_closed' },
            { piece: 'snare' },
            { piece: 'kick' },
        ],
        fallbacks: { hh_open: 'hh_closed', ride_bell: 'snare' },
    };
    const store = { drum_h3d_kit_v1: JSON.stringify(custom) };
    const { window, __test } = load({ store });
    const before = window.drumH3dGetKit();
    assert.equal(before.name, 'User 3-piece');
    assert.deepEqual([...before.lanes.map((l) => l.piece)], ['hh_closed', 'snare', 'kick']);
    assert.equal(before.fallbacks.hh_open, 'hh_closed');
    assert.equal(before.fallbacks.ride_bell, 'snare');
    assert.equal(__test.LS_KIT_CONFIG, 'drum_h3d_kit_v1');
    assert.equal(__test._readKitConfig().name, 'User 3-piece');

    const vocab = dumpCoreVocabulary();
    const seen = [];
    await __test._consumeCoreVocabulary(async (url) => {
        seen.push(url);
        if (url === '/api/drums/vocabulary') return jsonOk(vocab);
        if (url === '/api/settings') return jsonOk({});
        return jsonFail();
    });
    assert.equal(seen.includes('/api/drums/vocabulary'), true);
    assert.equal(seen.some((u) => u.startsWith('/api/drums/kits/')), false);
    const after = window.drumH3dGetKit();
    assert.equal(after.name, 'User 3-piece');
    assert.deepEqual([...after.lanes.map((l) => l.piece)], ['hh_closed', 'snare', 'kick']);
    assert.equal(after.fallbacks.hh_open, 'hh_closed');
    assert.equal(after.fallbacks.ride_bell, 'snare');
});

test('ac-2: consume does not apply alesis-strata-prime shipped kit notes as overlay', async () => {
    const vocab = dumpCoreVocabulary();
    const { __test } = load();
    const seen = [];
    const result = await __test._consumeCoreVocabulary(async (url) => {
        seen.push(url);
        if (url === '/api/drums/vocabulary') return jsonOk(vocab);
        if (url === '/api/settings') return jsonOk({ active_kit: 'alesis-strata-prime' });
        if (url === '/api/drums/kits/alesis-strata-prime') {
            return jsonOk({
                id: 'alesis-strata-prime',
                notes: { 38: 'tom_hi', 24: 'kick' },
                extra: 'ignored',
            });
        }
        return jsonFail();
    });
    assert.equal(result.vocabulary, true);
    assert.equal(result.activeKit, false);
    assert.equal(seen.some((u) => String(u).startsWith('/api/drums/kits/')), false);
    // Vocabulary GM still maps until a device document is consumed.
    assert.equal(__test._midiToPiece(38), 'snare');
    assert.ok(new Set(__test._effectivePieceIds()).has('stack'));
});

test('untrusted vocabulary: ignore unknown keys, reject garbage, skip __proto__', () => {
    const { __test } = load();
    assert.equal(__test._parseVocabulary(null), null);
    assert.equal(__test._parseVocabulary([]), null);
    assert.equal(__test._parseVocabulary({ pieces: {} }), null);
    assert.equal(__test._parseVocabulary('kick'), null);
    const pieces = Object.create(null);
    pieces.stack = { midi: [30], category: 'cymbal', color: '#fff' };
    pieces.bell = { midi: [80] };
    pieces['__proto__'] = { midi: [1] };
    pieces.constructor = { midi: [2] };
    const parsed = __test._parseVocabulary({
        pieces,
        presets: { rb4: [] },
        unexpected: true,
    });
    assert.ok(parsed);
    assert.deepEqual([...parsed.pieceIds].sort(), ['bell', 'stack']);
    assert.equal(parsed.midiToPiece[30], 'stack');
    assert.equal(parsed.midiToPiece[80], 'bell');
    assert.equal(parsed.midiToPiece[1], undefined);
});

test('kit notes parser skips non-string values and unsafe keys', () => {
    const { __test } = load();
    assert.equal(__test._parseKitNotes(null), null);
    assert.equal(__test._parseKitNotes({ notes: [] }), null);
    const notes = Object.create(null);
    notes[38] = 'tom_hi';
    notes['not-a-note'] = 'snare';
    notes[200] = 'kick';
    notes[36] = 99;
    notes['__proto__'] = 'kick';
    const overlay = __test._parseKitNotes({ id: 'x', notes });
    assert.equal(overlay[38], 'tom_hi');
    assert.equal(overlay[36], undefined);
});
