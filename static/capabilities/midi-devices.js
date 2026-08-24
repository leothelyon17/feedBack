// Core MIDI-device accessor (INIT-003/SPEC-011).
//
// The only in-page writer against SPEC-009 `/api/midi/devices` and the
// `active_midi_device` settings pointer. Display labels never persist;
// `source_id` must be a logical midi-input id (`web-midi::…`).
//
// `notes` are the user map only (default {}). They are never seeded from
// GM or a shipped kit. Drum profiles are never written from this module.
//
// Activate POSTs `/api/settings` then dispatches one
// `feedback:midi-device-change` with `{device_id}` only.
//
// Learn: PUT/DELETE `/api/midi/devices/{id}/notes/{midi}`. A 409 is
// surfaced on the thrown error and is never retried.
//
// In-flight activate/save/learn: last-write-wins via generation counters.
(function () {
    'use strict';

    window.feedBack = window.feedBack || {};
    if (window.feedBack.midiDevices && window.feedBack.midiDevices.version === 1) return;

    const VERSION = 1;
    const EVENT_NAME = 'feedback:midi-device-change';
    const DEVICE_ID_RE = /^[a-z0-9-]+$/;
    const TYPE_ID_RE = /^[a-z0-9-]+$/;
    const TRIGGER_ID_RE = /^[a-z0-9][a-z0-9_]*$/;
    // Same floor as drum-profiles.js / lib/midi_devices.py — empty string
    // allowed; rejects spaces and parentheses so raw MIDIIN2 (Foo) labels
    // cannot persist.
    const SOURCE_ID_RE = /^[a-z0-9][a-z0-9._-]*(::[a-z0-9._-]+)*$/;

    const _cache = {
        byId: new Map(),
        activeId: null,
        list: [],
        types: [],
        typesById: new Map(),
    };
    let _activateGen = 0;
    let _saveGen = 0;
    let _hydrateGen = 0;
    let _noteGen = 0;
    let _lastActivate = null;
    const _registrations = [];

    function _fetch() {
        return (typeof window.fetch === 'function') ? window.fetch.bind(window) : null;
    }

    function _httpError(resp, data) {
        const detail = data && (data.detail || data.error);
        const err = new Error(typeof detail === 'string' ? detail : ('HTTP ' + resp.status));
        err.status = resp.status;
        err.body = data;
        return err;
    }

    async function _request(method, url, body) {
        const fetchFn = _fetch();
        if (!fetchFn) throw new Error('midiDevices: fetch unavailable');
        const opts = { method, headers: { Accept: 'application/json' } };
        if (body !== undefined) {
            opts.headers['Content-Type'] = 'application/json';
            opts.body = JSON.stringify(body);
        }
        const resp = await fetchFn(url, opts);
        let data = null;
        try { data = await resp.json(); } catch (_) { data = null; }
        if (!resp.ok) throw _httpError(resp, data);
        return data;
    }

    function _stripDangerous(obj, depth) {
        if (!obj || typeof obj !== 'object' || depth > 8) return;
        if (Array.isArray(obj)) {
            for (let i = 0; i < obj.length; i += 1) _stripDangerous(obj[i], depth + 1);
            return;
        }
        for (const key of Object.keys(obj)) {
            if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
                delete obj[key];
                continue;
            }
            _stripDangerous(obj[key], depth + 1);
        }
    }

    function _sourceIdOk(raw) {
        if (raw == null) return true;
        if (typeof raw !== 'string') return false;
        if (raw === '') return true;
        if (/\s/.test(raw) || raw.indexOf('(') !== -1 || raw.indexOf(')') !== -1) return false;
        return SOURCE_ID_RE.test(raw);
    }

    function _sanitizeInput(raw) {
        const out = { midi_channel: -1, hit_detection: false, synth_volume: 0.7 };
        if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return out;
        const ch = Math.round(Number(raw.midi_channel));
        if (Number.isFinite(ch)) {
            if (ch < -1) out.midi_channel = -1;
            else if (ch > 15) out.midi_channel = 15;
            else out.midi_channel = ch;
        }
        if (raw.hit_detection === true || raw.hit_detection === false) out.hit_detection = raw.hit_detection;
        const vol = Number(raw.synth_volume);
        if (Number.isFinite(vol)) {
            if (vol < 0) out.synth_volume = 0;
            else if (vol > 1) out.synth_volume = 1;
            else out.synth_volume = vol;
        }
        return out;
    }

    function _sanitizeNotes(raw) {
        const out = {};
        if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return out;
        for (const key of Object.keys(raw)) {
            if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
            const note = Math.round(Number(key));
            if (!Number.isInteger(note) || note < 0 || note > 127) continue;
            const piece = raw[key];
            if (typeof piece !== 'string' || !TRIGGER_ID_RE.test(piece)) continue;
            out[String(note)] = piece;
        }
        return out;
    }

    function _toWire(device) {
        const sourceId = device.source_id == null ? '' : device.source_id;
        if (!_sourceIdOk(sourceId)) {
            throw new Error('source_id must be a logical midi-input id');
        }
        const typeId = device.device_type_id != null ? String(device.device_type_id) : '';
        if (!TYPE_ID_RE.test(typeId)) throw new Error('invalid device type id');
        const wire = {
            id: String(device.id || ''),
            name: device.name != null ? String(device.name) : String(device.id || ''),
            source_id: sourceId,
            device_type_id: typeId,
        };
        if (device.family != null && device.family !== '') {
            wire.family = String(device.family);
        }
        const includeNotes = Object.prototype.hasOwnProperty.call(device, 'notes');
        if (includeNotes) {
            wire.notes = _sanitizeNotes(device.notes);
            wire.input = _sanitizeInput(device.input);
            if (!wire.family) {
                const catalog = _cache.typesById.get(typeId);
                wire.family = (catalog && catalog.family) || 'drums';
            }
        }
        return wire;
    }

    function _remember(device) {
        if (!device || typeof device !== 'object' || !device.id) return device;
        try {
            const cloned = JSON.parse(JSON.stringify(device));
            _stripDangerous(cloned, 0);
            if (!cloned.notes || typeof cloned.notes !== 'object' || Array.isArray(cloned.notes)) {
                cloned.notes = {};
            }
            cloned.input = _sanitizeInput(cloned.input);
            _cache.byId.set(cloned.id, cloned);
            return cloned;
        } catch (_) {
            _cache.byId.set(device.id, device);
            return device;
        }
    }

    function _emitChange(deviceId) {
        const detail = { device_id: deviceId != null ? String(deviceId) : null };
        try {
            if (window.feedBack && typeof window.feedBack.emit === 'function') {
                window.feedBack.emit(EVENT_NAME, detail);
            }
        } catch (_) { /* eventing must not break the accessor */ }
        return detail;
    }

    function subscribe(fn) {
        if (typeof fn !== 'function') return function unsubscribeNoop() {};
        const handler = (event) => { try { fn(event && event.detail); } catch (_) { /* subscriber isolation */ } };
        const registration = { fn, handler };
        _registrations.push(registration);
        try {
            if (window.feedBack && typeof window.feedBack.on === 'function') window.feedBack.on(EVENT_NAME, handler);
        } catch (_) { /* best-effort */ }
        let cleaned = false;
        return function unsubscribeThis() {
            if (cleaned) return;
            cleaned = true;
            unsubscribe(fn);
        };
    }

    function unsubscribe(fn) {
        const idx = _registrations.findIndex((r) => r.fn === fn);
        if (idx === -1) return false;
        const [registration] = _registrations.splice(idx, 1);
        try {
            if (window.feedBack && typeof window.feedBack.off === 'function') window.feedBack.off(EVENT_NAME, registration.handler);
        } catch (_) { /* best-effort */ }
        return true;
    }

    async function list() {
        const data = await _request('GET', '/api/midi/devices');
        const devices = (data && Array.isArray(data.devices)) ? data.devices : [];
        _cache.list = devices;
        for (const d of devices) _remember(d);
        return devices.slice();
    }

    async function get(deviceId) {
        const id = String(deviceId || '');
        if (!DEVICE_ID_RE.test(id)) throw new Error('invalid device id');
        const device = await _request('GET', '/api/midi/devices/' + encodeURIComponent(id));
        return _remember(device);
    }

    async function listTypes() {
        const data = await _request('GET', '/api/midi/device-types');
        const types = (data && Array.isArray(data.device_types)) ? data.device_types : [];
        _cache.types = types;
        _cache.typesById.clear();
        for (const t of types) {
            if (t && typeof t.id === 'string' && TYPE_ID_RE.test(t.id)) {
                _cache.typesById.set(t.id, t);
            }
        }
        return types.slice();
    }

    async function save(device) {
        if (device == null || typeof device !== 'object' || Array.isArray(device)) {
            throw new Error('device must be an object');
        }
        const wire = _toWire(device);
        if (!DEVICE_ID_RE.test(wire.id)) throw new Error('invalid device id');
        const gen = ++_saveGen;
        const saved = await _request('PUT', '/api/midi/devices/' + encodeURIComponent(wire.id), wire);
        if (gen !== _saveGen) return _cache.byId.get(wire.id) || saved;
        return _remember(saved);
    }

    async function create(device) {
        if (device == null || typeof device !== 'object' || Array.isArray(device)) {
            throw new Error('device must be an object');
        }
        const sourceId = device.source_id == null ? '' : device.source_id;
        if (!_sourceIdOk(sourceId)) {
            throw new Error('source_id must be a logical midi-input id');
        }
        const typeId = device.device_type_id != null ? String(device.device_type_id) : '';
        if (!TYPE_ID_RE.test(typeId)) throw new Error('invalid device type id');
        const id = String(device.id || '');
        if (!DEVICE_ID_RE.test(id)) throw new Error('invalid device id');
        const body = {
            id,
            name: device.name != null ? String(device.name) : id,
            source_id: sourceId,
            device_type_id: typeId,
        };
        const gen = ++_saveGen;
        const saved = await _request('POST', '/api/midi/devices', body);
        if (gen !== _saveGen) return _cache.byId.get(id) || saved;
        return _remember(saved);
    }

    async function activate(deviceId) {
        const id = String(deviceId || '');
        if (!DEVICE_ID_RE.test(id)) throw new Error('invalid device id');
        const gen = ++_activateGen;
        const settings = await _request('POST', '/api/settings', { active_midi_device: id });
        if (gen !== _activateGen) return _lastActivate;
        let device = _cache.byId.get(id);
        if (!device) {
            try { device = await get(id); } catch (_) { device = { id, notes: {} }; }
        }
        if (gen !== _activateGen) return _lastActivate;
        _cache.activeId = id;
        if (device) _remember(device);
        const detail = _emitChange(id);
        _lastActivate = { device_id: id, device, settings, detail };
        return _lastActivate;
    }

    function getActive() {
        if (!_cache.activeId) return null;
        return _cache.byId.get(_cache.activeId) || { id: _cache.activeId };
    }

    function hasActive() {
        return typeof _cache.activeId === 'string' && _cache.activeId !== '';
    }

    function writeInputFields(state) {
        if (!hasActive()) return Promise.resolve(null);
        const prev = _cache.byId.get(_cache.activeId) || { id: _cache.activeId };
        return save({
            id: _cache.activeId,
            name: prev.name || _cache.activeId,
            source_id: prev.source_id || '',
            device_type_id: prev.device_type_id || '',
            family: prev.family || '',
            notes: prev.notes && typeof prev.notes === 'object' ? prev.notes : {},
            input: {
                midi_channel: state && state.midi_channel,
                hit_detection: !!(state && state.hit_detection),
                synth_volume: state && state.synth_volume,
            },
        });
    }

    function _requireMidiNote(raw) {
        const note = Math.round(Number(raw));
        if (!Number.isInteger(note) || note < 0 || note > 127) {
            throw new Error('midi note must be an integer 0-127');
        }
        return note;
    }

    async function putNote(deviceId, midi, pieceId) {
        const id = String(deviceId || '');
        if (!DEVICE_ID_RE.test(id)) throw new Error('invalid device id');
        const note = _requireMidiNote(midi);
        const piece = String(pieceId || '');
        if (!TRIGGER_ID_RE.test(piece)) throw new Error('piece_id must be a catalog trigger id');
        const gen = ++_noteGen;
        const data = await _request(
            'PUT',
            '/api/midi/devices/' + encodeURIComponent(id) + '/notes/' + encodeURIComponent(String(note)),
            { piece_id: piece },
        );
        if (gen !== _noteGen) return _cache.byId.get(id);
        const device = data && data.device ? data.device : data;
        return _remember(device);
    }

    async function deleteNote(deviceId, midi) {
        const id = String(deviceId || '');
        if (!DEVICE_ID_RE.test(id)) throw new Error('invalid device id');
        const note = _requireMidiNote(midi);
        const gen = ++_noteGen;
        const data = await _request(
            'DELETE',
            '/api/midi/devices/' + encodeURIComponent(id) + '/notes/' + encodeURIComponent(String(note)),
        );
        if (gen !== _noteGen) return _cache.byId.get(id);
        const device = data && data.device ? data.device : data;
        return _remember(device);
    }

    function mapRows(triggers, notes) {
        const byPiece = {};
        const map = _sanitizeNotes(notes);
        for (const midi of Object.keys(map)) {
            const piece = map[midi];
            if (!byPiece[piece]) byPiece[piece] = [];
            byPiece[piece].push(Number(midi));
        }
        const list = Array.isArray(triggers) ? triggers : [];
        const rows = [];
        for (let i = 0; i < list.length; i += 1) {
            const t = list[i];
            if (!t || typeof t !== 'object') continue;
            const id = typeof t.id === 'string' ? t.id : '';
            if (!TRIGGER_ID_RE.test(id)) continue;
            const midis = byPiece[id] || [];
            rows.push({
                id,
                name: t.name != null ? String(t.name) : id,
                zone: t.zone != null ? String(t.zone) : '',
                midi: midis.length ? midis[0] : null,
                midis,
            });
        }
        return rows;
    }

    async function hydrate() {
        const gen = ++_hydrateGen;
        const settings = await _request('GET', '/api/settings');
        if (gen !== _hydrateGen) return null;
        let devices = [];
        try { devices = await list(); } catch (_) { devices = []; }
        if (gen !== _hydrateGen) return null;
        try { await listTypes(); } catch (_) { /* catalogs optional at first paint */ }
        if (gen !== _hydrateGen) return null;
        const activeId = settings && typeof settings.active_midi_device === 'string'
            ? settings.active_midi_device
            : '';
        if (!activeId || !DEVICE_ID_RE.test(activeId)) {
            return { settings, devices, device: null };
        }
        _cache.activeId = activeId;
        let device = _cache.byId.get(activeId);
        if (!device) {
            try { device = await get(activeId); } catch (_) { device = null; }
        }
        if (gen !== _hydrateGen) return null;
        return { settings, devices, device };
    }

    const api = {
        version: VERSION,
        EVENT: EVENT_NAME,
        list,
        get,
        save,
        create,
        activate,
        getActive,
        hasActive,
        writeInputFields,
        hydrate,
        subscribe,
        unsubscribe,
        listTypes,
        putNote,
        deleteNote,
        mapRows,
    };

    window.feedBack.midiDevices = api;
    if (window.slopsmith && window.slopsmith !== window.feedBack) {
        window.slopsmith.midiDevices = api;
    }
    if (window.feedback && window.feedback !== window.feedBack) {
        window.feedback.midiDevices = api;
    }

    if (_fetch()) {
        hydrate().catch(function () { /* first-load hydrate is best-effort */ });
    }
})();
