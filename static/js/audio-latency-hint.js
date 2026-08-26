// INIT-006/SPEC-004: seeded audio-output-latency hint with player override.
//
// Probe a short-lived AudioContext for baseLatency + outputLatency (sum, in
// ms) and show it as an estimate. Default: display only — persist happens on
// explicit confirm through feedBack.midiDevices.writeTiming. The probe never
// writes the judged composite or the visual A/V offset and never replaces
// the playback graph.
(function () {
    'use strict';

    window.feedBack = window.feedBack || {};
    if (window.feedBack.audioLatencyHint && window.feedBack.audioLatencyHint.version === 1) return;

    const NOT_REPORTED = Object.freeze({
        state: 'not-reported',
        ms: null,
        source: 'none',
        text: 'Not reported',
    });

    function _notReported(source) {
        if (!source || source === 'none') return NOT_REPORTED;
        return { state: 'not-reported', ms: null, source: source, text: 'Not reported' };
    }

    // Finite and strictly positive: browsers often report 0 when the figure
    // is unknown. Silent 0 is not a measured latency.
    function isTrustedLatencySeconds(value) {
        const n = Number(value);
        return Number.isFinite(n) && n > 0;
    }

    function secondsToMs(seconds) {
        const n = Number(seconds);
        if (!Number.isFinite(n)) return null;
        return n * 1000;
    }

    function estimateFromSeconds(baseSeconds, outputSeconds, source) {
        let total = 0;
        let any = false;
        if (isTrustedLatencySeconds(baseSeconds)) {
            total += Number(baseSeconds);
            any = true;
        }
        if (isTrustedLatencySeconds(outputSeconds)) {
            total += Number(outputSeconds);
            any = true;
        }
        if (!any) return _notReported(source);
        const ms = secondsToMs(total);
        if (ms == null || !(ms > 0)) return _notReported(source);
        const rounded = Math.round(ms);
        if (!(rounded > 0) || !Number.isFinite(rounded)) return _notReported(source);
        return {
            state: 'estimate',
            ms: rounded,
            source: source || 'webaudio',
            text: rounded + ' ms (estimate)',
        };
    }

    function estimateFromMs(ms, source) {
        const n = Number(ms);
        if (!Number.isFinite(n) || !(n > 0)) return _notReported(source);
        const rounded = Math.round(n);
        if (!(rounded > 0) || !Number.isFinite(rounded)) return _notReported(source);
        return {
            state: 'estimate',
            ms: rounded,
            source: source || 'juce',
            text: rounded + ' ms (estimate)',
        };
    }

    function _closeProbe(ctx) {
        if (!ctx || typeof ctx.close !== 'function') return;
        try {
            const p = ctx.close();
            if (p && typeof p.catch === 'function') p.catch(function () { /* probe teardown */ });
        } catch (_) { /* already closed or stub */ }
    }

    // Create/close a probe context. Never connect nodes and never touch the
    // playback AudioContext / <audio> / JUCE graph (aud-2).
    function probeWebAudio(AudioContextCtor) {
        const Ctor = AudioContextCtor;
        if (typeof Ctor !== 'function') return _notReported('webaudio');
        let ctx = null;
        try {
            ctx = new Ctor();
        } catch (_) {
            return _notReported('webaudio');
        }
        try {
            const base = ctx ? ctx.baseLatency : undefined;
            const output = ctx ? ctx.outputLatency : undefined;
            return estimateFromSeconds(base, output, 'webaudio');
        } catch (_) {
            return _notReported('webaudio');
        } finally {
            _closeProbe(ctx);
        }
    }

    // Existing JUCE device object only — no new native bridge. Known ms keys
    // already present on getCurrentDevice() payloads; missing → not reported.
    function probeJuce(device) {
        if (!device || typeof device !== 'object' || Array.isArray(device)) {
            return _notReported('juce');
        }
        const keys = ['latencyMs', 'outputLatencyMs', 'deviceLatencyMs'];
        for (let i = 0; i < keys.length; i += 1) {
            const key = keys[i];
            if (!Object.prototype.hasOwnProperty.call(device, key)) continue;
            const result = estimateFromMs(device[key], 'juce');
            if (result.state === 'estimate') return result;
        }
        return _notReported('juce');
    }

    function selectedBackend(win) {
        const w = win || window;
        return w && w._juceMode ? 'juce' : 'webaudio';
    }

    function probe(opts) {
        const options = opts || {};
        const win = options.window || window;
        const backend = selectedBackend(win);
        if (backend === 'juce') {
            // Do not report Web Audio outputLatency as if it applied on JUCE.
            if (options.juceDevice) return probeJuce(options.juceDevice);
            const desktop = win.feedBackDesktop && win.feedBackDesktop.audio;
            if (desktop && typeof desktop.getCurrentDevice === 'function') {
                try {
                    const got = desktop.getCurrentDevice();
                    if (got && typeof got.then === 'function') {
                        return got.then(function (dev) { return probeJuce(dev); }, function () {
                            return _notReported('juce');
                        });
                    }
                    return probeJuce(got);
                } catch (_) {
                    return _notReported('juce');
                }
            }
            return _notReported('juce');
        }
        const Ctor = options.AudioContext
            || (win && (win.AudioContext || win.webkitAudioContext));
        return probeWebAudio(Ctor);
    }

    function _timingFromDevice(device) {
        return device && typeof device === 'object' && device.timing && typeof device.timing === 'object'
            ? device.timing
            : {};
    }

    // Persist the hint only. offset_ms is copied unchanged so the API
    // deep-merge keeps profiles. Never fold the hint into offset_ms.
    function confirmHint(opts) {
        const options = opts || {};
        const devices = options.midiDevices;
        if (!devices || typeof devices.writeTiming !== 'function') {
            return Promise.reject(new Error('midiDevices.writeTiming is required'));
        }
        const hint = Number(options.hintMs);
        if (!Number.isFinite(hint)) {
            return Promise.reject(new Error('hint must be finite'));
        }
        const device = options.device
            || (typeof devices.getActive === 'function' ? devices.getActive() : null);
        const prev = _timingFromDevice(device);
        const offset = Number(prev.offset_ms);
        if (!Number.isFinite(offset)) {
            return Promise.reject(new Error('offset_ms is required'));
        }
        const body = {
            offset_ms: offset,
            audio_latency_hint_ms: hint,
        };
        if (Object.prototype.hasOwnProperty.call(prev, 'origin') && prev.origin != null) {
            body.origin = prev.origin;
        }
        if (Object.prototype.hasOwnProperty.call(prev, 'audio_backend') && prev.audio_backend != null) {
            body.audio_backend = prev.audio_backend;
        } else {
            const win = options.window || window;
            body.audio_backend = selectedBackend(win) === 'juce' ? 'juce' : 'html5';
        }
        return Promise.resolve(devices.writeTiming(body));
    }

    function _el(doc, id) {
        try { return doc.getElementById(id); } catch (_) { return null; }
    }

    function _setText(node, value) {
        if (!node) return;
        node.textContent = value == null ? '' : String(value);
    }

    function parseOverrideMs(raw, probeResult) {
        const trimmed = raw == null ? '' : String(raw).trim();
        if (trimmed === '') {
            if (probeResult && probeResult.state === 'estimate' && Number.isFinite(probeResult.ms)) {
                return probeResult.ms;
            }
            return null;
        }
        const n = Number(trimmed);
        if (!Number.isFinite(n)) return null;
        return n;
    }

    function mount(doc, opts) {
        const documentRef = doc || (typeof document !== 'undefined' ? document : null);
        if (!documentRef || typeof documentRef.getElementById !== 'function') return null;
        const panel = _el(documentRef, 'midi-calibration-panel');
        if (!panel) return null;
        const probeNode = _el(documentRef, 'audio-latency-hint-probe');
        const overrideNode = _el(documentRef, 'audio-latency-hint-override');
        const confirmNode = _el(documentRef, 'audio-latency-hint-confirm');
        const statusNode = _el(documentRef, 'audio-latency-hint-status');
        const options = opts || {};

        let lastProbe = _notReported('none');

        function paintProbe(result) {
            lastProbe = result && result.state ? result : _notReported('none');
            _setText(probeNode, lastProbe.text);
        }

        function runProbe() {
            const result = probe({
                window: options.window || window,
                AudioContext: options.AudioContext,
                juceDevice: options.juceDevice,
            });
            if (result && typeof result.then === 'function') {
                result.then(paintProbe, function () { paintProbe(_notReported('juce')); });
                return result;
            }
            paintProbe(result);
            return result;
        }

        if (confirmNode && !confirmNode._audioLatencyHintWired) {
            confirmNode._audioLatencyHintWired = true;
            confirmNode.addEventListener('click', function () {
                const devices = options.midiDevices
                    || (window.feedBack && window.feedBack.midiDevices);
                const hintMs = parseOverrideMs(overrideNode && overrideNode.value, lastProbe);
                if (!Number.isFinite(hintMs)) {
                    _setText(statusNode, 'Enter a finite override or confirm a reported estimate.');
                    return;
                }
                confirmHint({
                    hintMs: hintMs,
                    midiDevices: devices,
                    device: options.device,
                    window: options.window || window,
                }).then(function () {
                    _setText(statusNode, 'Saved audio latency hint (' + hintMs + ' ms). Hit offset unchanged.');
                }).catch(function (err) {
                    const msg = err && err.message ? String(err.message) : 'Could not save hint';
                    _setText(statusNode, msg);
                });
            });
        }

        runProbe();
        return { runProbe: runProbe, lastProbe: function () { return lastProbe; } };
    }

    const api = {
        version: 1,
        isTrustedLatencySeconds: isTrustedLatencySeconds,
        secondsToMs: secondsToMs,
        estimateFromSeconds: estimateFromSeconds,
        estimateFromMs: estimateFromMs,
        probeWebAudio: probeWebAudio,
        probeJuce: probeJuce,
        probe: probe,
        selectedBackend: selectedBackend,
        confirmHint: confirmHint,
        parseOverrideMs: parseOverrideMs,
        mount: mount,
        NOT_REPORTED: NOT_REPORTED,
    };

    window.feedBack.audioLatencyHint = api;
    if (window.slopsmith && window.slopsmith !== window.feedBack) {
        window.slopsmith.audioLatencyHint = api;
    }
    if (window.feedback && window.feedback !== window.feedBack) {
        window.feedback.audioLatencyHint = api;
    }

    function boot() {
        try { mount(document); } catch (_) { /* panel optional in tests */ }
    }
    if (typeof document !== 'undefined' && document.getElementById) {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', boot, { once: true });
        } else {
            boot();
        }
    }
})();
