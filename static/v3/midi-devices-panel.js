// Settings → MIDI panel (INIT-003/SPEC-011).
//
// Core-owned chrome over feedBack.midiDevices. Labels via textContent.
// Display names never persist. Learn 409 is shown in #midi-map-status
// (aria-live) and is never retried.
(function () {
    'use strict';

    const DEVICE_ID_RE = /^[a-z0-9-]+$/;
    const TYPE_ID_RE = /^[a-z0-9-]+$/;
    const SOURCE_ID_RE = /^[a-z0-9][a-z0-9._-]*(::[a-z0-9._-]+)*$/;
    const TRIGGER_ID_RE = /^[a-z0-9_]+$/;
    const TRIGGER_ZONES = ['head', 'rim', 'bell', 'edge', 'choke'];
    const CREATE_SENTINEL = '__create__';

    let _learnPiece = null;
    let _learnHandle = null;
    let _learnHandles = [];
    let _wired = false;
    let _devices = [];
    let _types = [];
    let _typesById = new Map();
    let _lastDeviceId = '';

    function md() {
        return window.feedBack && window.feedBack.midiDevices;
    }

    function sourceIdOk(raw) {
        if (raw == null || raw === '') return true;
        if (typeof raw !== 'string') return false;
        if (/\s/.test(raw) || raw.indexOf('(') !== -1 || raw.indexOf(')') !== -1) return false;
        return SOURCE_ID_RE.test(raw);
    }

    function sanitizeInput(raw) {
        const out = { midi_channel: -1, hit_detection: false, synth_volume: 0.7 };
        if (!raw || typeof raw !== 'object') return out;
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

    function el(id) {
        try { return document.getElementById(id); } catch (_) { return null; }
    }

    function setText(node, value) {
        if (!node) return;
        node.textContent = value == null ? '' : String(value);
    }

    function status(msg) {
        setText(el('midi-map-status'), msg || '');
    }

    function fillSelect(select, items, valueKey, labelKey, selected, emptyLabel, footer) {
        if (!select) return;
        const prev = selected != null ? String(selected) : select.value;
        select.textContent = '';
        if (emptyLabel != null) {
            const blank = document.createElement('option');
            blank.value = '';
            blank.textContent = emptyLabel;
            select.appendChild(blank);
        }
        const list = Array.isArray(items) ? items : [];
        for (let i = 0; i < list.length; i += 1) {
            const item = list[i];
            if (!item) continue;
            const opt = document.createElement('option');
            opt.value = String(item[valueKey] == null ? '' : item[valueKey]);
            opt.textContent = String(item[labelKey] != null ? item[labelKey] : opt.value);
            select.appendChild(opt);
        }
        if (footer && footer.value != null) {
            const extra = document.createElement('option');
            extra.value = String(footer.value);
            extra.textContent = String(footer.label != null ? footer.label : footer.value);
            select.appendChild(extra);
        }
        if (prev && Array.from(select.options).some((o) => o.value === prev)) {
            select.value = prev;
        }
    }

    function hideCreateRow() {
        const row = el('midi-device-create-row');
        if (row) row.hidden = true;
        const nameEl = el('midi-device-name');
        if (nameEl) nameEl.value = '';
    }

    function showCreateRow() {
        const row = el('midi-device-create-row');
        if (row) row.hidden = false;
        const nameEl = el('midi-device-name');
        if (nameEl) {
            nameEl.value = '';
            try { nameEl.focus(); } catch (_) { /* best-effort */ }
        }
    }

    function nameTaken(name) {
        const want = String(name || '').trim().toLowerCase();
        if (!want) return false;
        for (let i = 0; i < _devices.length; i += 1) {
            const d = _devices[i];
            if (!d) continue;
            const have = String(d.name || d.id || '').trim().toLowerCase();
            if (have === want) return true;
        }
        return false;
    }

    function restoreDeviceSelect() {
        const sel = el('midi-device-select');
        if (!sel) return;
        const prev = _lastDeviceId && DEVICE_ID_RE.test(_lastDeviceId) ? _lastDeviceId : '';
        if (prev && Array.from(sel.options).some((o) => o.value === prev)) {
            sel.value = prev;
        } else {
            sel.value = '';
        }
    }

    function sources() {
        const mi = window.feedBack && window.feedBack.midiInput;
        if (!mi || typeof mi.listSources !== 'function') return [];
        try {
            const list = mi.listSources() || [];
            return list.filter((s) => s && sourceIdOk(s.logicalSourceKey));
        } catch (_) {
            return [];
        }
    }

    function selectedDevice() {
        const api = md();
        const sel = el('midi-device-select');
        const id = sel && sel.value;
        if (id && DEVICE_ID_RE.test(id)) {
            for (let i = 0; i < _devices.length; i += 1) {
                if (_devices[i] && _devices[i].id === id) return _devices[i];
            }
        }
        return api && typeof api.getActive === 'function' ? api.getActive() : null;
    }

    function selectedType() {
        const sel = el('midi-device-type');
        const id = sel && sel.value;
        if (!id || !TYPE_ID_RE.test(id)) return null;
        return _typesById.get(id) || null;
    }

    function triggerIdOk(raw) {
        return typeof raw === 'string' && TRIGGER_ID_RE.test(raw)
            && raw !== '__proto__' && raw !== 'constructor' && raw !== 'prototype';
    }

    function cloneTriggers(list) {
        const out = [];
        const src = Array.isArray(list) ? list : [];
        for (let i = 0; i < src.length; i += 1) {
            const t = src[i];
            if (!t || typeof t !== 'object') continue;
            const id = typeof t.id === 'string' ? t.id : '';
            if (!triggerIdOk(id)) continue;
            const row = { id, name: t.name != null ? String(t.name) : id };
            const zone = t.zone != null ? String(t.zone) : '';
            if (zone && TRIGGER_ZONES.indexOf(zone) !== -1) row.zone = zone;
            out.push(row);
        }
        return out;
    }

    function deviceTriggers(device) {
        if (device && Array.isArray(device.triggers)) return cloneTriggers(device.triggers);
        const catalog = selectedType();
        return cloneTriggers(catalog && catalog.triggers);
    }

    function triggerSlug(name, taken) {
        let id = String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
        if (!triggerIdOk(id)) id = 'trigger';
        if (!taken.has(id)) return id;
        let n = 2;
        while (taken.has(id + '_' + n)) n += 1;
        return id + '_' + n;
    }

    function syncAddRow(device) {
        const ok = !!(device && device.id);
        const row = el('midi-map-add-row');
        const nameEl = el('midi-map-add-name');
        const zoneEl = el('midi-map-add-zone');
        const btn = el('midi-map-add');
        if (row) row.hidden = !ok;
        if (nameEl) nameEl.disabled = !ok;
        if (zoneEl) zoneEl.disabled = !ok;
        if (btn) btn.disabled = !ok;
    }

    async function persistDeviceMap(device, triggers, notes) {
        const api = md();
        if (!api || !device || !device.id) return null;
        const saved = await api.save({
            id: device.id,
            name: device.name || device.id,
            source_id: device.source_id || '',
            device_type_id: device.device_type_id,
            family: device.family || '',
            notes: notes && typeof notes === 'object' && !Array.isArray(notes) ? notes : {},
            input: device.input,
            triggers: Array.isArray(triggers) ? triggers : [],
        });
        if (saved && saved.id) {
            let found = false;
            for (let i = 0; i < _devices.length; i += 1) {
                if (_devices[i] && _devices[i].id === saved.id) {
                    _devices[i] = saved;
                    found = true;
                }
            }
            if (!found) _devices.push(saved);
            renderMap(saved);
        }
        return saved;
    }

    function renderKnobs(device) {
        const input = sanitizeInput(device && device.input);
        const ch = el('midi-input-channel');
        const hit = el('midi-input-hit-detect');
        const vol = el('midi-input-synth-vol');
        const volVal = el('midi-input-synth-vol-val');
        if (ch) ch.value = String(input.midi_channel);
        if (hit) hit.checked = !!input.hit_detection;
        if (vol) vol.value = String(input.synth_volume);
        if (volVal) volVal.textContent = Number(input.synth_volume).toFixed(2);
    }

    function fillZoneSelect(select, current) {
        if (!select) return;
        select.textContent = '';
        const blank = document.createElement('option');
        blank.value = '';
        blank.textContent = '';
        select.appendChild(blank);
        for (let i = 0; i < TRIGGER_ZONES.length; i += 1) {
            const z = TRIGGER_ZONES[i];
            const opt = document.createElement('option');
            opt.value = z;
            opt.textContent = z;
            select.appendChild(opt);
        }
        const zone = current != null ? String(current) : '';
        select.value = TRIGGER_ZONES.indexOf(zone) !== -1 ? zone : '';
    }

    function renderMap(device) {
        const body = el('midi-map-body');
        const api = md();
        syncAddRow(device);
        if (!body || !api || typeof api.mapRows !== 'function') return;
        body.textContent = '';
        const catalog = selectedType();
        const triggers = (device && Array.isArray(device.triggers))
            ? device.triggers
            : ((catalog && Array.isArray(catalog.triggers)) ? catalog.triggers : []);
        const notes = device && device.notes ? device.notes : {};
        const rows = api.mapRows(triggers, notes);
        for (let i = 0; i < rows.length; i += 1) {
            const row = rows[i];
            const tr = document.createElement('tr');
            tr.setAttribute('data-trigger-id', row.id);

            const nameTd = document.createElement('td');
            const nameIn = document.createElement('input');
            nameIn.type = 'text';
            nameIn.value = row.name;
            nameIn.className = 'w-full bg-dark-700 border border-gray-800 rounded-lg px-3 py-1.5 text-xs text-gray-300 outline-none';
            nameIn.setAttribute('aria-label', 'Trigger name');
            nameIn.setAttribute('data-trigger-name', row.id);
            nameTd.appendChild(nameIn);
            tr.appendChild(nameTd);

            const zoneTd = document.createElement('td');
            const zoneSel = document.createElement('select');
            zoneSel.className = 'bg-dark-700 border border-gray-800 rounded-lg px-3 py-1.5 text-xs text-gray-300 outline-none';
            zoneSel.setAttribute('aria-label', 'Trigger zone');
            zoneSel.setAttribute('data-trigger-zone', row.id);
            fillZoneSelect(zoneSel, row.zone);
            zoneTd.appendChild(zoneSel);
            tr.appendChild(zoneTd);

            nameIn.addEventListener('change', function () {
                persistRename(row.id, nameIn.value, zoneSel.value);
            });
            zoneSel.addEventListener('change', function () {
                persistRename(row.id, nameIn.value, zoneSel.value);
            });

            const midiTd = document.createElement('td');
            midiTd.className = 'midi-map-midi';
            midiTd.textContent = row.midi == null ? '' : String(row.midi);
            tr.appendChild(midiTd);

            const actTd = document.createElement('td');
            const learn = document.createElement('button');
            learn.type = 'button';
            learn.className = 'px-3 py-1.5 text-xs text-gray-400 hover:text-white';
            learn.setAttribute('data-learn-trigger', row.id);
            const pending = _learnPiece === row.id;
            learn.textContent = pending ? '...' : 'Learn';
            learn.setAttribute('aria-label', (pending ? 'Cancel learn for ' : 'Learn MIDI note for ') + row.name);
            learn.addEventListener('click', function () {
                toggleLearn(row.id, row.name);
            });
            actTd.appendChild(learn);
            if (row.midi != null) {
                const rm = document.createElement('button');
                rm.type = 'button';
                rm.className = 'px-1.5 py-0.5 text-xs text-red-400 hover:text-red-300';
                rm.textContent = '×';
                rm.setAttribute('aria-label', 'Remove MIDI note ' + row.midi + ' from ' + row.name);
                rm.addEventListener('click', function () {
                    removeMapping(row.midi);
                });
                actTd.appendChild(rm);
            }
            const del = document.createElement('button');
            del.type = 'button';
            del.className = 'px-1.5 py-0.5 text-xs text-red-400 hover:text-red-300';
            del.textContent = 'Delete';
            del.setAttribute('data-delete-trigger', row.id);
            del.setAttribute('aria-label', 'Delete trigger ' + row.name);
            del.addEventListener('click', function () {
                deleteTrigger(row.id);
            });
            actTd.appendChild(del);
            tr.appendChild(actTd);
            body.appendChild(tr);
        }
    }

    async function persistRename(triggerId, name, zone) {
        const device = selectedDevice();
        if (!device || !device.id || !triggerIdOk(triggerId)) return;
        const triggers = deviceTriggers(device);
        let found = false;
        for (let i = 0; i < triggers.length; i += 1) {
            if (triggers[i].id !== triggerId) continue;
            found = true;
            const nextName = String(name || '').trim() || triggerId;
            triggers[i].name = nextName;
            const z = zone != null ? String(zone) : '';
            if (z && TRIGGER_ZONES.indexOf(z) !== -1) triggers[i].zone = z;
            else delete triggers[i].zone;
        }
        if (!found) return;
        try {
            await persistDeviceMap(device, triggers, device.notes);
            status('');
        } catch (err) {
            status((err && err.message) || 'Could not rename trigger');
        }
        await refresh();
    }

    async function addTrigger() {
        const device = selectedDevice();
        if (!device || !device.id) {
            status('Select a MIDI device before adding a trigger.');
            return;
        }
        const nameEl = el('midi-map-add-name');
        const zoneEl = el('midi-map-add-zone');
        const name = nameEl ? String(nameEl.value || '').trim() : '';
        if (!name) {
            status('Enter a trigger name.');
            return;
        }
        const triggers = deviceTriggers(device);
        const taken = new Set(triggers.map((t) => t && t.id));
        const id = triggerSlug(name, taken);
        const row = { id, name };
        const zone = zoneEl ? String(zoneEl.value || '') : '';
        if (zone && TRIGGER_ZONES.indexOf(zone) !== -1) row.zone = zone;
        triggers.push(row);
        try {
            await persistDeviceMap(device, triggers, device.notes);
            status('');
            if (nameEl) nameEl.value = '';
            if (zoneEl) zoneEl.value = '';
        } catch (err) {
            status((err && err.message) || 'Could not add trigger');
        }
        await refresh();
    }

    async function deleteTrigger(triggerId) {
        const device = selectedDevice();
        if (!device || !device.id || !triggerIdOk(triggerId)) return;
        if (_learnPiece === triggerId) {
            _learnPiece = null;
            stopLearnListen();
        }
        const triggers = deviceTriggers(device).filter((t) => t.id !== triggerId);
        const notes = {};
        const prev = device.notes && typeof device.notes === 'object' ? device.notes : {};
        for (const key of Object.keys(prev)) {
            if (prev[key] !== triggerId) notes[key] = prev[key];
        }
        try {
            await persistDeviceMap(device, triggers, notes);
            status('');
        } catch (err) {
            status((err && err.message) || 'Could not delete trigger');
        }
        await refresh();
    }

    function pickerSourceId() {
        const sel = el('midi-source-picker');
        const id = sel && sel.value;
        if (!id || !sourceIdOk(id)) return '';
        return id;
    }

    function liveSourceId(device) {
        const fromPicker = pickerSourceId();
        if (fromPicker) return fromPicker;
        const fromDevice = device && device.source_id;
        if (fromDevice && sourceIdOk(fromDevice)) return fromDevice;
        return '';
    }

    async function persistSourceId(sourceId) {
        const api = md();
        const device = selectedDevice();
        if (!api || !device || !device.id) return;
        if (!sourceIdOk(sourceId)) return;
        if (typeof api.writeSourceId === 'function') {
            await api.writeSourceId(device.id, sourceId || '');
            return;
        }
        if ((device.source_id || '') === (sourceId || '')) return;
        await api.save({
            id: device.id,
            name: device.name || device.id,
            source_id: sourceId || '',
            device_type_id: device.device_type_id,
            family: device.family || '',
            notes: device.notes && typeof device.notes === 'object' ? device.notes : {},
            input: device.input,
            triggers: Array.isArray(device.triggers) ? device.triggers : [],
        });
    }

    let _runStatus = 0;

    function midiBytes(payload) {
        if (!payload) return null;
        let data = payload;
        if (payload.data != null && !ArrayBuffer.isView(payload) && !Array.isArray(payload)) {
            data = payload.data;
        }
        if (!data || data.length < 1) return null;
        const first = data[0];
        if (first < 0x80 && _runStatus) {
            const out = new Uint8Array(data.length + 1);
            out[0] = _runStatus;
            for (let i = 0; i < data.length; i += 1) out[i + 1] = data[i];
            data = out;
        } else if (first >= 0x80 && first < 0xf0) {
            _runStatus = first;
        }
        return data;
    }

    let _watching = false;

    function describeMidi(data) {
        if (!data || data.length < 2) return '';
        const st = data[0];
        const cmd = st & 0xf0;
        const ch = (st & 0x0f) + 1;
        const n = data[1];
        const v = data.length > 2 ? data[2] : 0;
        if (data.length >= 3 && cmd === 0x90 && v > 0) {
            return 'note-on  ch' + ch + '  note ' + n + '  vel ' + v;
        }
        if (cmd === 0x80 || (cmd === 0x90 && v === 0)) {
            return 'note-off  ch' + ch + '  note ' + n;
        }
        return 'ch' + ch + '  note ' + n;
    }

    function onLiveMidi(msg) {
        const data = midiBytes(msg);
        if (!data) return;
        const probe = el('midi-hit-probe');
        const label = (msg && msg.label) ? String(msg.label) : 'MIDI';
        const desc = describeMidi(data);
        if (desc) setText(probe, label + ' — ' + desc);
        if (msg && msg.logicalSourceKey && sourceIdOk(msg.logicalSourceKey)) {
            const sel = el('midi-source-picker');
            if (sel && !pickerSourceId()) sel.value = msg.logicalSourceKey;
        }
        if (_learnPiece) onLearnMidi(data);
    }

    function startWatch() {
        if (_watching) return;
        const mi = window.feedBack && window.feedBack.midiInput;
        if (!mi || typeof mi.watchMessages !== 'function') return;
        mi.watchMessages(onLiveMidi);
        _watching = true;
    }

    function stopLearnListen() {
        const handles = _learnHandles.slice();
        if (_learnHandle) handles.push(_learnHandle);
        for (let i = 0; i < handles.length; i += 1) {
            const handle = handles[i];
            if (handle && typeof handle.removeListener === 'function' && handle._onMsg) {
                try { handle.removeListener(handle._onMsg); } catch (_) { /* best-effort */ }
            }
        }
        _learnHandle = null;
        _learnHandles = [];
    }

    function onLearnMidi(payload) {
        const data = midiBytes(payload);
        if (!_learnPiece || !data || data.length < 3) return;
        const statusByte = data[0] & 0xf0;
        const vel = data[2];
        const ch = data[0] & 0x0f;
        const note = data[1];
        const device = selectedDevice();
        const input = sanitizeInput(device && device.input);
        if (input.midi_channel !== -1 && ch !== input.midi_channel) {
            status('Heard MIDI on channel ' + (ch + 1) + ' — waiting for the mapped channel.');
            return;
        }
        if (statusByte !== 0x90 || vel <= 0) {
            status('Heard MIDI (not a note-on). Hit the pad again.');
            return;
        }
        const piece = _learnPiece;
        _learnPiece = null;
        stopLearnListen();
        learnWrite(piece, note);
    }

    async function learnWrite(pieceId, midi) {
        const api = md();
        const device = selectedDevice();
        if (!api || !device || !device.id) {
            status('Select a MIDI device before Learn.');
            renderMap(device);
            return;
        }
        try {
            await api.putNote(device.id, midi, pieceId);
            status('');
        } catch (err) {
            // 409 (and any other failure): surface once, never retry.
            status((err && err.message) || 'Learn failed');
        }
        await refresh();
    }

    async function toggleLearn(pieceId, pieceName) {
        if (_learnPiece === pieceId) {
            _learnPiece = null;
            stopLearnListen();
            status('');
            renderMap(selectedDevice());
            return;
        }
        const device = selectedDevice();
        if (!device || !device.id) {
            status('Select a MIDI device before Learn.');
            return;
        }
        const mi = window.feedBack && window.feedBack.midiInput;
        const picked = pickerSourceId();
        if (mi && typeof mi.discover === 'function') {
            try { await mi.discover(); } catch (_) { /* permission denied → empty picker */ }
            await refresh();
        }
        const sourceId = picked || liveSourceId(selectedDevice() || device);
        if (sourceId) {
            try {
                await persistSourceId(sourceId);
            } catch (err) {
                status((err && err.message) || 'Could not save MIDI source');
                return;
            }
        }
        const keys = [];
        if (sourceId) keys.push(sourceId);
        const listed = (mi && typeof mi.listSources === 'function') ? (mi.listSources() || []) : [];
        for (let i = 0; i < listed.length; i += 1) {
            const key = listed[i] && listed[i].logicalSourceKey;
            if (key && sourceIdOk(key) && keys.indexOf(key) === -1) keys.push(key);
        }
        if (!keys.length) {
            status('Select a detected MIDI source, then Learn.');
            return;
        }
        stopLearnListen();
        _learnPiece = pieceId;
        status('Listening for a MIDI note for ' + (pieceName || pieceId) + '…');
        renderMap(selectedDevice() || device);
        if (!mi || typeof mi.open !== 'function') {
            _learnPiece = null;
            status('MIDI input is not available in this browser.');
            renderMap(selectedDevice() || device);
            return;
        }
        try {
            if (sourceId && typeof mi.select === 'function') mi.select(sourceId);
            for (let i = 0; i < keys.length; i += 1) {
                const opened = await mi.open({ requester: 'midi-devices-panel', logicalSourceKey: keys[i] });
                const handle = opened && opened.handle;
                if (handle && typeof handle.addListener === 'function') {
                    handle._onMsg = onLearnMidi;
                    handle.addListener(onLearnMidi);
                    _learnHandles.push(handle);
                    _learnHandle = handle;
                }
            }
            if (_learnHandles.length) return;
            _learnPiece = null;
            status('Could not open that MIDI source.');
            renderMap(selectedDevice() || device);
        } catch (err) {
            _learnPiece = null;
            status((err && err.message) || 'Could not open MIDI source');
            renderMap(selectedDevice() || device);
        }
    }

    async function removeMapping(midi) {
        const api = md();
        const device = selectedDevice();
        if (!api || !device || !device.id) return;
        try {
            await api.deleteNote(device.id, midi);
            status('');
        } catch (err) {
            status((err && err.message) || 'Could not remove mapping');
        }
        await refresh();
    }

    async function persistKnobs() {
        const api = md();
        const device = selectedDevice();
        if (!api || !device || !device.id) return;
        const ch = el('midi-input-channel');
        const hit = el('midi-input-hit-detect');
        const vol = el('midi-input-synth-vol');
        const volVal = el('midi-input-synth-vol-val');
        const synth = vol ? Number(vol.value) : 0.7;
        if (volVal) volVal.textContent = Number.isFinite(synth) ? synth.toFixed(2) : '0.70';
        if (!api.hasActive() || (api.getActive() && api.getActive().id !== device.id)) {
            try { await api.activate(device.id); } catch (_) { /* knobs still try to save */ }
        }
        try {
            await api.writeInputFields({
                midi_channel: ch ? Number(ch.value) : -1,
                hit_detection: !!(hit && hit.checked),
                synth_volume: synth,
            });
        } catch (err) {
            status((err && err.message) || 'Could not save input knobs');
        }
    }

    async function onTypeChange() {
        const api = md();
        const device = selectedDevice();
        const type = selectedType();
        if (!api || !device || !device.id || !type) {
            renderMap(device);
            return;
        }
        if (device.device_type_id === type.id) {
            renderMap(device);
            return;
        }
        try {
            // PUT without notes → server create-from-type; never copies kit notes.
            await api.save({
                id: device.id,
                name: device.name || device.id,
                source_id: device.source_id || '',
                device_type_id: type.id,
            });
            status('');
        } catch (err) {
            status((err && err.message) || 'Could not change device type');
        }
        await refresh();
    }

    function slugFrom(raw) {
        const s = String(raw || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
        return DEVICE_ID_RE.test(s) ? s : '';
    }

    async function onCreate() {
        const api = md();
        const type = selectedType();
        const sourceSel = el('midi-source-picker');
        const nameEl = el('midi-device-name');
        const sourceId = sourceSel ? sourceSel.value : '';
        if (!api) return;
        if (sourceId && !sourceIdOk(sourceId)) {
            status('Source must be a logical MIDI id, not a port label.');
            return;
        }
        if (!type) {
            hideCreateRow();
            restoreDeviceSelect();
            status('Choose a device type.');
            return;
        }
        const name = nameEl ? String(nameEl.value || '').trim() : '';
        if (!name) {
            status('Enter a unique device name.');
            return;
        }
        if (nameTaken(name)) {
            status('That name is already in the Device List.');
            return;
        }
        let id = slugFrom(name) || slugFrom(type.id) || 'midi-device';
        const existing = new Set(_devices.map((d) => d && d.id));
        if (existing.has(id)) {
            let n = 2;
            while (existing.has(id + '-' + n)) n += 1;
            id = id + '-' + n;
        }
        try {
            const created = await api.create({
                id,
                name,
                source_id: sourceId || '',
                device_type_id: type.id,
            });
            await api.activate(created.id);
            status('');
        } catch (err) {
            status((err && err.message) || 'Could not create device');
            return;
        }
        hideCreateRow();
        await refresh();
    }

    function onCreateCancel() {
        hideCreateRow();
        restoreDeviceSelect();
        status('');
        renderKnobs(selectedDevice());
        renderMap(selectedDevice());
    }

    async function onActivate() {
        const api = md();
        const sel = el('midi-device-select');
        const id = sel && sel.value;
        if (!api || !id || !DEVICE_ID_RE.test(id)) return;
        try {
            await api.activate(id);
            const src = pickerSourceId();
            if (src) await persistSourceId(src);
            status('');
        } catch (err) {
            status((err && err.message) || 'Could not activate device');
        }
        await refresh();
    }

    async function onSourceChange() {
        const src = pickerSourceId();
        if (!src) return;
        try {
            await persistSourceId(src);
            status('');
        } catch (err) {
            status((err && err.message) || 'Could not save MIDI source');
        }
        await refresh();
    }

    async function refresh() {
        const panel = el('midi-devices-panel');
        const api = md();
        if (!panel || !api) return;
        try { _devices = await api.list(); } catch (_) { /* keep last list */ }
        if (!_types.length) {
            try {
                _types = await api.listTypes();
                _typesById = new Map();
                for (let i = 0; i < _types.length; i += 1) {
                    const t = _types[i];
                    if (t && TYPE_ID_RE.test(t.id)) _typesById.set(t.id, t);
                }
            } catch (_) { /* catalogs optional */ }
        }
        const active = api.getActive && api.getActive();
        const creating = el('midi-device-create-row') && !el('midi-device-create-row').hidden;
        fillSelect(
            el('midi-device-select'),
            _devices.map((d) => ({ id: d.id, name: d.name || d.id })),
            'id',
            'name',
            creating ? CREATE_SENTINEL : ((active && active.id) || ''),
            '— select a device —',
            { value: CREATE_SENTINEL, label: 'Create New' },
        );
        const deviceSel = el('midi-device-select');
        if (creating && deviceSel) deviceSel.value = CREATE_SENTINEL;
        else if (deviceSel && DEVICE_ID_RE.test(deviceSel.value)) {
            _lastDeviceId = deviceSel.value;
        }
        fillSelect(
            el('midi-device-type'),
            _types.map((t) => ({ id: t.id, name: t.name || t.id })),
            'id',
            'name',
            (selectedDevice() && selectedDevice().device_type_id) || '',
            '— select a type —',
        );
        const srcList = sources().map((s) => ({
            logicalSourceKey: s.logicalSourceKey,
            label: s.label || s.logicalSourceKey,
        }));
        fillSelect(
            el('midi-source-picker'),
            srcList,
            'logicalSourceKey',
            'label',
            (selectedDevice() && selectedDevice().source_id) || '',
            srcList.length ? '— select a source —' : 'No MIDI sources',
        );
        const device = selectedDevice();
        const typeSel = el('midi-device-type');
        if (device && device.device_type_id && typeSel) typeSel.value = device.device_type_id;
        renderKnobs(device);
        renderMap(device);
    }

    async function onDiscover() {
        const mi = window.feedBack && window.feedBack.midiInput;
        if (mi && typeof mi.discover === 'function') {
            try { await mi.discover(); } catch (_) { /* permission denied → empty picker */ }
        }
        await refresh();
    }

    function wire() {
        if (_wired) return;
        const panel = el('midi-devices-panel');
        if (!panel) return;
        _wired = true;
        startWatch();
        const activateBtn = el('midi-device-use');
        if (activateBtn) activateBtn.addEventListener('click', onActivate);
        const createBtn = el('midi-device-create');
        if (createBtn) createBtn.addEventListener('click', onCreate);
        const createCancel = el('midi-device-create-cancel');
        if (createCancel) createCancel.addEventListener('click', onCreateCancel);
        const nameEl = el('midi-device-name');
        if (nameEl) {
            nameEl.addEventListener('keydown', function (e) {
                if (e && e.key === 'Enter') {
                    if (e.preventDefault) e.preventDefault();
                    onCreate();
                }
                if (e && e.key === 'Escape') {
                    if (e.preventDefault) e.preventDefault();
                    onCreateCancel();
                }
            });
        }
        hideCreateRow();
        const typeSel = el('midi-device-type');
        if (typeSel) typeSel.addEventListener('change', onTypeChange);
        const deviceSel = el('midi-device-select');
        if (deviceSel) {
            deviceSel.addEventListener('change', function () {
                if (deviceSel.value === CREATE_SENTINEL) {
                    if (!selectedType()) {
                        hideCreateRow();
                        restoreDeviceSelect();
                        status('Choose a device type.');
                        return;
                    }
                    showCreateRow();
                    status('Enter a unique name for the new device.');
                    return;
                }
                hideCreateRow();
                if (DEVICE_ID_RE.test(deviceSel.value)) _lastDeviceId = deviceSel.value;
                renderKnobs(selectedDevice());
                renderMap(selectedDevice());
            });
        }
        const discoverBtn = el('midi-discover');
        if (discoverBtn) discoverBtn.addEventListener('click', onDiscover);
        const sourceSel = el('midi-source-picker');
        if (sourceSel) sourceSel.addEventListener('change', onSourceChange);
        const ch = el('midi-input-channel');
        const hit = el('midi-input-hit-detect');
        const vol = el('midi-input-synth-vol');
        if (ch) ch.addEventListener('change', persistKnobs);
        if (hit) hit.addEventListener('change', persistKnobs);
        if (vol) {
            vol.addEventListener('input', function () {
                const volVal = el('midi-input-synth-vol-val');
                if (volVal) volVal.textContent = Number(vol.value).toFixed(2);
            });
            vol.addEventListener('change', persistKnobs);
        }
        const addBtn = el('midi-map-add');
        if (addBtn) addBtn.addEventListener('click', addTrigger);
        const addName = el('midi-map-add-name');
        if (addName) {
            addName.addEventListener('keydown', function (e) {
                if (e && e.key === 'Enter') {
                    if (e.preventDefault) e.preventDefault();
                    addTrigger();
                }
            });
        }
        const bar = el('settings-tabbar');
        if (bar) {
            bar.addEventListener('click', function (e) {
                const btn = e.target && e.target.closest ? e.target.closest('.fb-tab') : null;
                if (btn && btn.dataset.tab === 'midi') refresh();
            });
        }
        try {
            if (window.feedBack && typeof window.feedBack.on === 'function') {
                window.feedBack.on('screen:changed', function (e) {
                    if (e && e.id === 'settings') refresh();
                });
            }
        } catch (_) { /* best-effort */ }
        const api = md();
        if (api && typeof api.subscribe === 'function') {
            api.subscribe(function () { refresh(); });
        }
    }

    function boot() {
        wire();
        refresh();
    }

    if (typeof document === 'undefined' || !document.getElementById) return;
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot, { once: true });
    } else {
        boot();
    }
})();
