// Core drum-profile accessor (INIT-003/SPEC-004).
//
// The only in-page writer against SPEC-002 `/api/drums/profiles` and the
// `active_drum_profile` settings pointer. Settings, pause, and both drum
// highways must go through this object so they cannot drift.
//
// Activate POSTs `/api/settings` (server dual-writes `active_kit`) and
// dispatches `feedback:drum-profile-change` on the existing feedBack bus —
// same pattern as `feedback:drum-input-change`, not a second bus.
//
// `notes` never leave this module on a PUT (REQ-003). `device.source_id`
// must be a logical midi-input id; raw port labels are rejected.
//
// In-flight activate/save: last-write-wins via a generation counter. A
// stale response does not apply or emit.
(function () {
    'use strict';

    window.feedBack = window.feedBack || {};
    if (window.feedBack.drumProfiles && window.feedBack.drumProfiles.version === 1) return;

    const VERSION = 1;
    const EVENT_NAME = 'feedback:drum-profile-change';
    const PROFILE_ID_RE = /^[a-z0-9-]+$/;
    // Same floor as lib/drum_profiles.py — empty string allowed; rejects
    // spaces and parentheses so raw MIDIIN2 (Foo) labels cannot persist.
    const SOURCE_ID_RE = /^[a-z0-9][a-z0-9._-]*(::[a-z0-9._-]+)*$/;

    const _cache = {
        byId: new Map(),
        activeId: null,
        list: [],
    };
    let _activateGen = 0;
    let _saveGen = 0;
    let _hydrateGen = 0;
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
        if (!fetchFn) throw new Error('drumProfiles: fetch unavailable');
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

    function _sanitizeDevice(raw) {
        if (raw == null) return { source_id: '', enabled: false };
        if (typeof raw !== 'object' || Array.isArray(raw)) return null;
        const sourceId = raw.source_id == null ? '' : raw.source_id;
        if (!_sourceIdOk(sourceId)) return null;
        return {
            source_id: sourceId,
            enabled: raw.enabled === true,
        };
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

    function _toWire(profile) {
        const device = _sanitizeDevice(profile.device);
        if (device === null) {
            throw new Error('device.source_id must be a logical midi-input id');
        }
        const rawDeviceId = profile.device_id == null ? '' : String(profile.device_id);
        if (rawDeviceId && !PROFILE_ID_RE.test(rawDeviceId)) {
            throw new Error('invalid device id');
        }
        const wire = {
            id: String(profile.id || ''),
            name: profile.name != null ? String(profile.name) : String(profile.id || ''),
            kit_id: profile.kit_id != null ? String(profile.kit_id) : '',
            device_id: rawDeviceId,
            device,
            input: _sanitizeInput(profile.input),
        };
        if (profile.highway && typeof profile.highway === 'object' && !Array.isArray(profile.highway)) {
            try {
                const cloned = JSON.parse(JSON.stringify(profile.highway));
                _stripDangerous(cloned, 0);
                wire.highway = cloned;
            } catch (_) { /* omit an unserializable highway; server defaults it */ }
        }
        return wire;
    }

    function _remember(profile) {
        if (!profile || typeof profile !== 'object' || !profile.id) return profile;
        _cache.byId.set(profile.id, profile);
        return profile;
    }

    function _emitChange(extra) {
        const detail = {
            version: VERSION,
            profile_id: extra.profile_id != null ? String(extra.profile_id) : null,
            kit_id: extra.kit_id != null ? String(extra.kit_id) : '',
        };
        try {
            if (window.feedBack && typeof window.feedBack.emit === 'function') {
                window.feedBack.emit(EVENT_NAME, detail);
            }
        } catch (_) { /* eventing must not break the accessor */ }
        return detail;
    }

    function _applyInputToDrumInput(profile) {
        const di = window.feedBack && window.feedBack.drumInput;
        if (!di || typeof di.applyFromProfile !== 'function' || !profile) return;
        const device = profile.device && typeof profile.device === 'object' ? profile.device : {};
        const input = profile.input && typeof profile.input === 'object' ? profile.input : {};
        const patch = {};
        if (typeof device.enabled === 'boolean') patch.deviceEnabled = device.enabled;
        if (input.midi_channel != null) patch.midiChannel = input.midi_channel;
        if (typeof input.hit_detection === 'boolean') patch.hitDetection = input.hit_detection;
        if (input.synth_volume != null) patch.synthVolume = input.synth_volume;
        if (Object.keys(patch).length === 0) return;
        try { di.applyFromProfile(patch); } catch (_) { /* hydrate must not throw */ }
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
        const data = await _request('GET', '/api/drums/profiles');
        const profiles = (data && Array.isArray(data.profiles)) ? data.profiles : [];
        _cache.list = profiles;
        for (const p of profiles) _remember(p);
        return profiles.slice();
    }

    async function get(profileId) {
        const id = String(profileId || '');
        if (!PROFILE_ID_RE.test(id)) throw new Error('invalid profile id');
        const profile = await _request('GET', '/api/drums/profiles/' + encodeURIComponent(id));
        return _remember(profile);
    }

    async function save(profile) {
        if (profile == null || typeof profile !== 'object' || Array.isArray(profile)) {
            throw new Error('profile must be an object');
        }
        if (Object.prototype.hasOwnProperty.call(profile, 'notes')) {
            throw new Error('notes are not allowed on a profile');
        }
        const wire = _toWire(profile);
        if (!PROFILE_ID_RE.test(wire.id)) throw new Error('invalid profile id');
        if (Object.prototype.hasOwnProperty.call(wire, 'notes')) delete wire.notes;
        const gen = ++_saveGen;
        const saved = await _request('PUT', '/api/drums/profiles/' + encodeURIComponent(wire.id), wire);
        if (gen !== _saveGen) return _cache.byId.get(wire.id) || saved;
        return _remember(saved);
    }

    async function activate(profileId) {
        const id = String(profileId || '');
        if (!PROFILE_ID_RE.test(id)) throw new Error('invalid profile id');
        const gen = ++_activateGen;
        const settings = await _request('POST', '/api/settings', { active_drum_profile: id });
        if (gen !== _activateGen) return _lastActivate;
        let profile = _cache.byId.get(id);
        if (!profile) {
            try { profile = await get(id); } catch (_) { profile = { id, kit_id: (settings && settings.active_kit) || '' }; }
        }
        if (gen !== _activateGen) return _lastActivate;
        _cache.activeId = id;
        if (profile) _remember(profile);
        _applyInputToDrumInput(profile);
        const kitId = (settings && settings.active_kit) || (profile && profile.kit_id) || '';
        const detail = _emitChange({ profile_id: id, kit_id: kitId });
        _lastActivate = { profile_id: id, kit_id: kitId, profile, settings, detail };
        return _lastActivate;
    }

    function getActive() {
        if (!_cache.activeId) return null;
        return _cache.byId.get(_cache.activeId) || { id: _cache.activeId };
    }

    function hasActive() {
        return typeof _cache.activeId === 'string' && _cache.activeId !== '';
    }

    // Persist seam for drum-input.js — merges play-critical fields onto the
    // cached active profile and PUTs through save() (never a second writer).
    function writeInputFields(state) {
        if (!hasActive()) return Promise.resolve(null);
        const prev = _cache.byId.get(_cache.activeId) || { id: _cache.activeId };
        return save({
            id: _cache.activeId,
            name: prev.name || _cache.activeId,
            kit_id: prev.kit_id || '',
            device_id: prev.device_id || '',
            highway: prev.highway,
            device: {
                source_id: (prev.device && prev.device.source_id) || '',
                enabled: !!(state && state.deviceEnabled),
            },
            input: {
                midi_channel: state && state.midiChannel,
                hit_detection: !!(state && state.hitDetection),
                synth_volume: state && state.synthVolume,
            },
        });
    }

    async function hydrate() {
        const gen = ++_hydrateGen;
        const settings = await _request('GET', '/api/settings');
        if (gen !== _hydrateGen) return null;
        let profiles = [];
        try { profiles = await list(); } catch (_) { profiles = []; }
        if (gen !== _hydrateGen) return null;
        const activeId = settings && typeof settings.active_drum_profile === 'string'
            ? settings.active_drum_profile
            : '';
        if (!activeId || !PROFILE_ID_RE.test(activeId)) {
            return { settings, profiles, profile: null };
        }
        _cache.activeId = activeId;
        let profile = _cache.byId.get(activeId);
        if (!profile) {
            try { profile = await get(activeId); } catch (_) { profile = null; }
        }
        if (gen !== _hydrateGen) return null;
        if (profile) _applyInputToDrumInput(profile);
        return { settings, profiles, profile };
    }

    const api = {
        version: VERSION,
        EVENT: EVENT_NAME,
        list,
        get,
        save,
        activate,
        getActive,
        hasActive,
        writeInputFields,
        hydrate,
        subscribe,
        unsubscribe,
    };

    window.feedBack.drumProfiles = api;
    if (window.slopsmith && window.slopsmith !== window.feedBack) {
        window.slopsmith.drumProfiles = api;
    }
    if (window.feedback && window.feedback !== window.feedBack) {
        window.feedback.drumProfiles = api;
    }

    if (_fetch()) {
        hydrate().catch(function () { /* first-load hydrate is best-effort */ });
    }
})();
