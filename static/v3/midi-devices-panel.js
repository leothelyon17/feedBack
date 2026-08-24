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

    let _learnPiece = null;
    let _learnHandle = null;
    let _wired = false;
    let _devices = [];
    let _types = [];
    let _typesById = new Map();

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

    function fillSelect(select, items, valueKey, labelKey, selected, emptyLabel) {
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
        if (prev && Array.from(select.options).some((o) => o.value === prev)) {
            select.value = prev;
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

    function renderMap(device) {
        const body = el('midi-map-body');
        const api = md();
        if (!body || !api || typeof api.mapRows !== 'function') return;
        body.textContent = '';
        const catalog = selectedType();
        const triggers = (catalog && Array.isArray(catalog.triggers)) ? catalog.triggers : [];
        const notes = device && device.notes ? device.notes : {};
        const rows = api.mapRows(triggers, notes);
        for (let i = 0; i < rows.length; i += 1) {
            const row = rows[i];
            const tr = document.createElement('tr');
            tr.setAttribute('data-trigger-id', row.id);

            const nameTd = document.createElement('td');
            nameTd.textContent = row.name;
            tr.appendChild(nameTd);

            const zoneTd = document.createElement('td');
            zoneTd.textContent = row.zone;
            tr.appendChild(zoneTd);

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
            tr.appendChild(actTd);
            body.appendChild(tr);
        }
    }

    function stopLearnListen() {
        if (_learnHandle && typeof _learnHandle.removeListener === 'function' && _learnHandle._onMsg) {
            try { _learnHandle.removeListener(_learnHandle._onMsg); } catch (_) { /* best-effort */ }
        }
        _learnHandle = null;
    }

    function onLearnMidi(data) {
        if (!_learnPiece || !data || data.length < 3) return;
        const statusByte = data[0] & 0xf0;
        const vel = data[2];
        if (statusByte !== 0x90 || vel <= 0) return;
        const ch = data[0] & 0x0f;
        const device = selectedDevice();
        const input = sanitizeInput(device && device.input);
        if (input.midi_channel !== -1 && ch !== input.midi_channel) return;
        const note = data[1];
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
        _learnPiece = pieceId;
        status('Listening for a MIDI note for ' + (pieceName || pieceId) + '…');
        renderMap(device);
        const mi = window.feedBack && window.feedBack.midiInput;
        const sourceId = device.source_id;
        if (!mi || typeof mi.open !== 'function' || !sourceIdOk(sourceId) || !sourceId) return;
        try {
            const opened = await mi.open({ requester: 'midi-devices-panel', logicalSourceKey: sourceId });
            const handle = opened && opened.handle;
            if (handle && typeof handle.addListener === 'function') {
                stopLearnListen();
                handle._onMsg = onLearnMidi;
                handle.addListener(onLearnMidi);
                _learnHandle = handle;
            }
        } catch (_) { /* MIDI open is best-effort; Learn still surfaces 409 via putNote */ }
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
            status('Choose a device type.');
            return;
        }
        const name = (nameEl && nameEl.value.trim()) || type.name || type.id;
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
        await refresh();
    }

    async function onActivate() {
        const api = md();
        const sel = el('midi-device-select');
        const id = sel && sel.value;
        if (!api || !id || !DEVICE_ID_RE.test(id)) return;
        try {
            await api.activate(id);
            status('');
        } catch (err) {
            status((err && err.message) || 'Could not activate device');
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
        fillSelect(
            el('midi-device-select'),
            _devices.map((d) => ({ id: d.id, name: d.name || d.id })),
            'id',
            'name',
            (active && active.id) || '',
            '— select a device —',
        );
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
        const activateBtn = el('midi-device-use');
        if (activateBtn) activateBtn.addEventListener('click', onActivate);
        const createBtn = el('midi-device-create');
        if (createBtn) createBtn.addEventListener('click', onCreate);
        const typeSel = el('midi-device-type');
        if (typeSel) typeSel.addEventListener('change', onTypeChange);
        const deviceSel = el('midi-device-select');
        if (deviceSel) {
            deviceSel.addEventListener('change', function () {
                renderKnobs(selectedDevice());
                renderMap(selectedDevice());
            });
        }
        const discoverBtn = el('midi-discover');
        if (discoverBtn) discoverBtn.addEventListener('click', onDiscover);
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
