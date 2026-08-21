// Core drum-input contract (INIT-002/SPEC-002).
//
// One versioned, core-owned settings contract for the 2D and 3D drum
// highways: MIDI source enablement, MIDI channel filter, hit-detection
// toggle, and synth playback volume. This is the analog of `midi-input.js`'s
// device *identity* plane, but for the drum-specific playback settings both
// highways must agree on.
//
// What this module does NOT own:
//   - Device identity (which MIDI source is selected) — that stays on
//     `feedBack.midiInput.getSelected()` / `.select()`. `deviceEnabled` here
//     is an orthogonal on/off flag; an explicit "None" persists as
//     `deviceEnabled: false` regardless of what `midiInput` has selected, and
//     this module never auto-flips it back on.
//   - Kit note-to-piece mappings (INIT-002/SPEC-001 owns that via the atomic
//     kit API). `notifyMappingChange()` only re-broadcasts that a mapping
//     changed elsewhere so both highways can refetch — it persists nothing.
//
// Persistence: one canonical JSON record at `feedback_drums_input_v1`,
// carrying a deterministic `(clock, origin, sequence)` revision tuple for
// last-write-wins ordering across tabs. Same-tab changes additionally fan
// out through `window.feedBack`'s `feedback:drum-input-change` event;
// cross-tab changes arrive via the browser's `storage` event on the same
// canonical key. Both paths converge on the same `_applyIncoming` merge so a
// consumer only ever has to hold one code path.
//
// Legacy compatibility (INIT-002/GR-005, bounded to this initiative): reads
// migrate missing fields from the 2D drum plugin's existing keys
// (`drums_midi_ch`, `drums_hit_detect`, `drums_synth_vol`, and
// `drums_midi_input`'s presence for `deviceEnabled`), then from the 3D
// highway's own keys (`drum_h3d_midi_pick_v2`, `drum_h3d_midi_input`) — see
// the "3D legacy key shape" note below — before falling back to defaults.
// Once migrated, this module dual-writes the fields it owns back to both
// surfaces' legacy keys so an un-migrated consumer still reads sane values
// during the compatibility window. It never writes or deletes the device-
// identity keys (`drums_midi_input`, `drum_h3d_midi_input`) — those stay
// owned by their respective surfaces / `feedBack.midiInput`.
(function () {
    'use strict';

    window.feedBack = window.feedBack || {};
    if (window.feedBack.drumInput && window.feedBack.drumInput.version === 1) return;

    const VERSION = 1;
    const EVENT_NAME = 'feedback:drum-input-change';
    const STORAGE_KEY = 'feedback_drums_input_v1';

    // 2D drum plugin's existing keys (feedBack-plugin-drums/screen.js
    // STORE_KEYS). `midiInputId` is read-only here — a non-empty device id is
    // used only to infer a prior `deviceEnabled: true`, never written back.
    const LEGACY_2D_KEYS = {
        midiInputId: 'drums_midi_input',
        midiChannel: 'drums_midi_ch',
        hitDetection: 'drums_hit_detect',
        synthVolume: 'drums_synth_vol',
    };
    // The 3D highway's settings surface (INIT-002/SPEC-004) had not landed
    // when this contract was written, so its exact on-disk shape is an
    // ASSUMPTION, not an observed fact — disclosed as a deviation in this
    // spec's completion summary. Assumed shapes, chosen to be the most
    // natural pairing with this module's own field names:
    //   - `drum_h3d_midi_pick_v2`: JSON `{ deviceEnabled, midiChannel,
    //     hitDetection, synthVolume }` (a "v2" full settings snapshot).
    //   - `drum_h3d_midi_input`: a bare device-id string, mirroring the 2D
    //     `drums_midi_input` key — read-only here, same as its 2D sibling.
    // If SPEC-004 lands a different shape, this migration step (only) needs
    // to be revisited; the canonical contract and revision model are
    // unaffected either way.
    const LEGACY_3D_PICK_KEY = 'drum_h3d_midi_pick_v2';
    const LEGACY_3D_INPUT_KEY = 'drum_h3d_midi_input';

    const DEFAULTS = Object.freeze({
        deviceEnabled: false,
        midiChannel: -1,
        hitDetection: false,
        synthVolume: 0.7,
    });
    const FIELDS = Object.freeze(['deviceEnabled', 'midiChannel', 'hitDetection', 'synthVolume']);

    // ── storage seams (getItem/setItem can throw in sandboxed iframes, on
    // Safari file://, or when storage is disabled for the origin) ──────────
    function _readRaw(key) {
        try { return window.localStorage.getItem(key); } catch (_) { return null; }
    }
    function _writeRaw(key, value) {
        try { window.localStorage.setItem(key, value); return true; } catch (_) { return false; }
    }

    // ── field validators — return `undefined` for anything not usable so
    // callers can fall through to the next precedence source ──────────────
    function _validBool(value) {
        return (value === true || value === false) ? value : undefined;
    }
    function _validChannel(value) {
        if (value == null || value === '') return undefined;
        const n = Math.round(Number(value));
        if (!Number.isFinite(n)) return undefined;
        if (n < -1) return -1;
        if (n > 15) return 15;
        return n;
    }
    function _validVolume(value) {
        if (value == null || value === '') return undefined;
        const n = Number(value);
        if (!Number.isFinite(n)) return undefined;
        if (n < 0) return 0;
        if (n > 1) return 1;
        return n;
    }
    function _validRevision(rev) {
        if (!rev || typeof rev !== 'object') return null;
        const clock = Number(rev.clock);
        const sequence = Number(rev.sequence);
        const origin = typeof rev.origin === 'string' && rev.origin ? rev.origin : null;
        if (!Number.isFinite(clock) || !Number.isFinite(sequence) || !origin) return null;
        return { clock, origin, sequence };
    }

    // ── revision tuple: deterministic (clock, origin, sequence) ordering ───
    function _makeOrigin() {
        try {
            if (window.crypto && typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID();
        } catch (_) { /* fall through to the weaker generator below */ }
        return `o-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    }
    const ORIGIN = _makeOrigin();
    let _localSequence = 0;

    function _compareRevision(a, b) {
        if (a.clock !== b.clock) return a.clock - b.clock;
        if (a.origin !== b.origin) return a.origin < b.origin ? -1 : 1;
        return a.sequence - b.sequence;
    }
    function _isNewer(candidate, current) {
        return !current || _compareRevision(candidate, current) > 0;
    }
    // `prior` is the settings revision this bump follows (or null for a
    // fresh record). Mapping-change notifications use their OWN clock
    // baseline (`_nextNotifyRevision` below) so a mapping broadcast never
    // advances the settings revision an in-flight cross-tab `storage` event
    // is being compared against — see notifyMappingChange().
    function _nextRevision(prior) {
        const priorClock = prior ? prior.clock : 0;
        const clock = Math.max(Date.now(), priorClock + 1);
        _localSequence += 1;
        return { clock, origin: ORIGIN, sequence: _localSequence };
    }
    let _notifyClock = 0;
    function _nextNotifyRevision() {
        _notifyClock = Math.max(Date.now(), _notifyClock + 1);
        _localSequence += 1;
        return { clock: _notifyClock, origin: ORIGIN, sequence: _localSequence };
    }

    // ── migration sources, in the fixed precedence order the initiative doc
    // fixes: canonical, 2D legacy keys, drum_h3d_midi_pick_v2,
    // drum_h3d_midi_input, then the hardcoded default ─────────────────────
    function _legacy2D() {
        const midiInputId = _readRaw(LEGACY_2D_KEYS.midiInputId);
        return {
            deviceEnabled: midiInputId != null ? _validBool(midiInputId.trim() !== '') : undefined,
            midiChannel: _validChannel(_readRaw(LEGACY_2D_KEYS.midiChannel)),
            hitDetection: (() => {
                const raw = _readRaw(LEGACY_2D_KEYS.hitDetection);
                return raw == null ? undefined : raw === 'true';
            })(),
            synthVolume: _validVolume(_readRaw(LEGACY_2D_KEYS.synthVolume)),
        };
    }
    function _legacy3DPick() {
        const raw = _readRaw(LEGACY_3D_PICK_KEY);
        if (!raw) return {};
        let parsed;
        try { parsed = JSON.parse(raw); } catch (_) { return {}; }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
        return {
            deviceEnabled: _validBool(parsed.deviceEnabled),
            midiChannel: _validChannel(parsed.midiChannel),
            hitDetection: _validBool(parsed.hitDetection),
            synthVolume: _validVolume(parsed.synthVolume),
        };
    }
    function _legacy3DInput() {
        const raw = _readRaw(LEGACY_3D_INPUT_KEY);
        if (raw == null) return {};
        return { deviceEnabled: _validBool(raw.trim() !== '') };
    }

    function _resolveField(name, canonicalFields, sources) {
        if (canonicalFields[name] !== undefined) return canonicalFields[name];
        for (const src of sources) {
            if (src[name] !== undefined) return src[name];
        }
        return DEFAULTS[name];
    }

    // Parses the canonical record leniently, field by field — a single
    // corrupt/out-of-range field must not discard an otherwise-valid record
    // (REQ-005: "Migrate each missing field with precedence").
    function _parseCanonical(raw) {
        const fields = {};
        if (!raw) return { fields, revision: null };
        let parsed;
        try { parsed = JSON.parse(raw); } catch (_) { return { fields, revision: null }; }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { fields, revision: null };
        const deviceEnabled = _validBool(parsed.deviceEnabled);
        if (deviceEnabled !== undefined) fields.deviceEnabled = deviceEnabled;
        const midiChannel = _validChannel(parsed.midiChannel);
        if (midiChannel !== undefined) fields.midiChannel = midiChannel;
        const hitDetection = _validBool(parsed.hitDetection);
        if (hitDetection !== undefined) fields.hitDetection = hitDetection;
        const synthVolume = _validVolume(parsed.synthVolume);
        if (synthVolume !== undefined) fields.synthVolume = synthVolume;
        return { fields, revision: _validRevision(parsed.revision) };
    }

    function _dualWriteLegacy(state) {
        // Fields this contract owns get mirrored to both surfaces' legacy
        // keys for the bounded compatibility window (GR-005). Device
        // identity keys (`drums_midi_input`, `drum_h3d_midi_input`) are
        // never written here — that stays owned by device selection.
        _writeRaw(LEGACY_2D_KEYS.midiChannel, String(state.midiChannel));
        _writeRaw(LEGACY_2D_KEYS.hitDetection, state.hitDetection ? 'true' : 'false');
        _writeRaw(LEGACY_2D_KEYS.synthVolume, String(state.synthVolume));
        try {
            _writeRaw(LEGACY_3D_PICK_KEY, JSON.stringify({
                deviceEnabled: state.deviceEnabled,
                midiChannel: state.midiChannel,
                hitDetection: state.hitDetection,
                synthVolume: state.synthVolume,
            }));
        } catch (_) { /* best-effort; canonical write is the source of truth */ }
    }

    function _persistCanonical(state, revision) {
        const record = {
            version: VERSION,
            revision,
            deviceEnabled: state.deviceEnabled,
            midiChannel: state.midiChannel,
            hitDetection: state.hitDetection,
            synthVolume: state.synthVolume,
        };
        try { _writeRaw(STORAGE_KEY, JSON.stringify(record)); } catch (_) { /* best-effort */ }
        _dualWriteLegacy(state);
        return record;
    }

    function _loadOrMigrate() {
        const { fields: canonicalFields, revision: canonicalRevision } = _parseCanonical(_readRaw(STORAGE_KEY));
        const allFieldsPresent = FIELDS.every((f) => canonicalFields[f] !== undefined);
        if (canonicalRevision && allFieldsPresent) {
            return {
                state: {
                    deviceEnabled: canonicalFields.deviceEnabled,
                    midiChannel: canonicalFields.midiChannel,
                    hitDetection: canonicalFields.hitDetection,
                    synthVolume: canonicalFields.synthVolume,
                },
                revision: canonicalRevision,
                migrated: false,
            };
        }
        const sources = [_legacy2D(), _legacy3DPick(), _legacy3DInput()];
        const state = {
            deviceEnabled: _resolveField('deviceEnabled', canonicalFields, sources),
            midiChannel: _resolveField('midiChannel', canonicalFields, sources),
            hitDetection: _resolveField('hitDetection', canonicalFields, sources),
            synthVolume: _resolveField('synthVolume', canonicalFields, sources),
        };
        // A migration write is always a fresh, distinguishable revision — even
        // when a valid `canonicalRevision` was found but one field still had
        // to be filled from a legacy key. Reusing that old revision verbatim
        // would let another tab compare revisions, see no change, and never
        // refetch the field this load just repaired.
        return { state, revision: _nextRevision(canonicalRevision), migrated: true };
    }

    // ── module state ─────────────────────────────────────────────────────
    let _current = null;
    let _revision = null;

    (function _init() {
        const { state, revision, migrated } = _loadOrMigrate();
        _current = state;
        _revision = revision;
        if (migrated) _persistCanonical(_current, _revision);
    })();

    function _publicState() {
        return {
            version: VERSION,
            revision: { ..._revision },
            deviceEnabled: _current.deviceEnabled,
            midiChannel: _current.midiChannel,
            hitDetection: _current.hitDetection,
            synthVolume: _current.synthVolume,
        };
    }

    // ── same-tab / cross-tab fan-out ─────────────────────────────────────
    const _registrations = []; // [{ fn, handler }] — see subscribe()/unsubscribe()

    function _emitChange(extra) {
        const detail = {
            version: VERSION,
            revision: { ..._revision },
            origin: ORIGIN,
            changedKeys: extra.changedKeys || [],
            kitId: extra.kitId != null ? extra.kitId : null,
            mutation: extra.mutation != null ? extra.mutation : null,
            midiNote: extra.midiNote != null ? extra.midiNote : null,
        };
        try {
            if (window.feedBack && typeof window.feedBack.emit === 'function') {
                window.feedBack.emit(EVENT_NAME, detail);
            }
        } catch (_) { /* eventing must not break settings */ }
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
            _removeRegistration(registration);
        };
    }

    function _removeRegistration(registration) {
        const idx = _registrations.indexOf(registration);
        if (idx === -1) return false;
        _registrations.splice(idx, 1);
        try {
            if (window.feedBack && typeof window.feedBack.off === 'function') window.feedBack.off(EVENT_NAME, registration.handler);
        } catch (_) { /* best-effort */ }
        return true;
    }

    // Removes one still-active registration matching `fn` (the first found,
    // not all of them) — pairs with subscribe()'s own returned cleanup for
    // callers that keep a handle instead. Returns whether one was removed.
    function unsubscribe(fn) {
        const idx = _registrations.findIndex((r) => r.fn === fn);
        if (idx === -1) return false;
        const [registration] = _registrations.splice(idx, 1);
        try {
            if (window.feedBack && typeof window.feedBack.off === 'function') window.feedBack.off(EVENT_NAME, registration.handler);
        } catch (_) { /* best-effort */ }
        return true;
    }

    // ── public read/update ───────────────────────────────────────────────
    function get() { return _publicState(); }

    function _sanitizeUpdate(partial) {
        const out = {};
        if (partial == null || typeof partial !== 'object') return out;
        if (Object.prototype.hasOwnProperty.call(partial, 'deviceEnabled')) {
            const v = _validBool(partial.deviceEnabled);
            if (v !== undefined) out.deviceEnabled = v;
        }
        if (Object.prototype.hasOwnProperty.call(partial, 'midiChannel')) {
            const v = _validChannel(partial.midiChannel);
            if (v !== undefined) out.midiChannel = v;
        }
        if (Object.prototype.hasOwnProperty.call(partial, 'hitDetection')) {
            const v = _validBool(partial.hitDetection);
            if (v !== undefined) out.hitDetection = v;
        }
        if (Object.prototype.hasOwnProperty.call(partial, 'synthVolume')) {
            const v = _validVolume(partial.synthVolume);
            if (v !== undefined) out.synthVolume = v;
        }
        return out;
    }

    function update(partial) {
        const sanitized = _sanitizeUpdate(partial);
        const changedKeys = Object.keys(sanitized).filter((key) => _current[key] !== sanitized[key]);
        if (changedKeys.length === 0) return _publicState();
        _current = { ..._current, ...sanitized };
        _revision = _nextRevision(_revision);
        _persistCanonical(_current, _revision);
        _emitChange({ changedKeys });
        return _publicState();
    }

    // Re-broadcasts a mapping change made elsewhere (INIT-002/SPEC-001's kit
    // API) so both highways refetch. Persists nothing — kit-note mappings
    // are out of this contract's scope — and advances its OWN clock
    // (`_nextNotifyRevision`), never the settings `_revision`, so a mapping
    // broadcast can never make an in-flight settings `storage` event look
    // stale by comparison.
    function notifyMappingChange(payload) {
        const p = payload && typeof payload === 'object' ? payload : {};
        const kitId = p.kitId != null ? String(p.kitId) : null;
        const mutation = (p.mutation === 'set' || p.mutation === 'delete') ? p.mutation : null;
        const midiNoteNum = Number(p.midiNote);
        const midiNote = Number.isFinite(midiNoteNum) ? midiNoteNum : null;
        const revision = _nextNotifyRevision();
        const detail = {
            version: VERSION,
            revision,
            origin: ORIGIN,
            changedKeys: [],
            kitId,
            mutation,
            midiNote,
        };
        try {
            if (window.feedBack && typeof window.feedBack.emit === 'function') window.feedBack.emit(EVENT_NAME, detail);
        } catch (_) { /* eventing must not break the caller */ }
        return detail;
    }

    // ── cross-tab: the browser `storage` event fires only in OTHER tabs for
    // a real localStorage write, but the `self-origin` + `stale` guards
    // below are kept anyway — the unit-test harness fakes `storage` events
    // without that browser guarantee, and a defensive check here costs
    // nothing in production ──────────────────────────────────────────────
    function _onStorage(event) {
        if (!event || event.key !== STORAGE_KEY || event.newValue == null) return;
        let parsed;
        try { parsed = JSON.parse(event.newValue); } catch (_) { return; }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
        const revision = _validRevision(parsed.revision);
        if (!revision) return;
        if (revision.origin === ORIGIN) return;       // ignore our own echoed write
        if (!_isNewer(revision, _revision)) return;    // ignore stale/out-of-order records
        const nextState = {
            deviceEnabled: _validBool(parsed.deviceEnabled) !== undefined ? parsed.deviceEnabled : _current.deviceEnabled,
            midiChannel: _validChannel(parsed.midiChannel) !== undefined ? _validChannel(parsed.midiChannel) : _current.midiChannel,
            hitDetection: _validBool(parsed.hitDetection) !== undefined ? parsed.hitDetection : _current.hitDetection,
            synthVolume: _validVolume(parsed.synthVolume) !== undefined ? _validVolume(parsed.synthVolume) : _current.synthVolume,
        };
        const changedKeys = FIELDS.filter((key) => nextState[key] !== _current[key]);
        _current = nextState;
        _revision = revision;
        if (changedKeys.length > 0) _emitChange({ changedKeys });
    }
    try {
        if (typeof window.addEventListener === 'function') window.addEventListener('storage', _onStorage);
    } catch (_) { /* best-effort */ }

    window.feedBack.drumInput = {
        version: VERSION,
        EVENT: EVENT_NAME,
        get,
        update,
        subscribe,
        unsubscribe,
        notifyMappingChange,
    };
})();
