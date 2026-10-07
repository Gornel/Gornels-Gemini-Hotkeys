// Runs in the page's own MAIN world (see manifest.json's "world": "MAIN"
// entry), NOT the isolated world content.js runs in. This is necessary
// because isolated-world content scripts get their own separate copies of
// window.fetch/XMLHttpRequest - patching them there would never see
// requests the page's own Angular app actually makes. Communicates back to
// content.js via a CustomEvent, since DOM events (unlike JS objects/globals)
// do cross the isolated/main world boundary.
(function () {
    // Confirmed via a real failure seen in testing: requests to this host
    // returned HTTP 400 right as a dictation session started, and nothing
    // in that session ever got transcribed. If this hostname changes in a
    // future Gemini update, this stops matching anything - that's the
    // first thing to check if detection silently stops working.
    const SPEECH_HOST = 'speechs3proto2-pa.clients6.google.com';

    function reportError(detail) {
        window.dispatchEvent(new CustomEvent('gemini-hotkeys:speech-error', { detail }));
    }

    // --- XMLHttpRequest ---
    // Every speech failure seen so far was an XHR to a /streaming/channel
    // endpoint (Google's usual long-polling pattern), so this is the
    // detection path that matters.
    //
    // Hooks XMLHttpRequest.prototype.open instead of replacing the
    // XMLHttpRequest constructor: replacing it silently drops the real
    // constructor's static members (XMLHttpRequest.DONE etc.), and the hook
    // only ever attaches a listener for speech requests, so every other XHR
    // the page makes is left completely alone. Only open() runs through
    // this code - send() and the network error logging don't, so unrelated
    // failures are never attributed to this file.
    const OriginalXHR = window.XMLHttpRequest;
    if (OriginalXHR && OriginalXHR.prototype && OriginalXHR.prototype.open) {
        const speechXhrUrls = new WeakMap(); // xhr -> URL of its current speech request

        // One shared function on purpose: addEventListener ignores a repeat
        // registration of the same function, so an XHR that gets open()ed
        // again (reuse) can't end up reporting the same failure twice.
        function onSpeechXhrLoadEnd() {
            const url = speechXhrUrls.get(this);
            if (url && (this.status === 0 || this.status >= 400)) {
                reportError({ via: 'xhr', url, status: this.status });
            }
        }

        const originalOpen = OriginalXHR.prototype.open;
        OriginalXHR.prototype.open = function (method, requestUrl, ...rest) {
            const url = String(requestUrl || '');
            if (url.includes(SPEECH_HOST)) {
                speechXhrUrls.set(this, url);
                this.addEventListener('loadend', onSpeechXhrLoadEnd);
            } else {
                speechXhrUrls.delete(this); // a reused XHR moving on to a non-speech URL
            }
            return originalOpen.call(this, method, requestUrl, ...rest);
        };
    }

    // --- fetch: deliberately NOT wrapped ---
    // A window.fetch wrapper has to be installed before any URL is known, so
    // it can't be limited to speech requests - and it sits in the call stack
    // of EVERY fetch the page makes, which made Chrome attribute unrelated
    // failures (ad-blocked telemetry, ERR_BLOCKED_BY_CLIENT) to this file.
    // Speech has only ever used XHR (above), so fetch is left untouched.
    //
    // Tripwire instead of silence: if speech traffic ever does show up on
    // fetch (Gemini changing transports), say so once, so "dictation errors
    // stopped being detected" has an obvious cause. Uses Resource Timing,
    // which observes without wrapping anything.
    try {
        let warned = false;
        new PerformanceObserver((list) => {
            if (warned) return;
            for (const entry of list.getEntries()) {
                if (entry.initiatorType === 'fetch' && entry.name.includes(SPEECH_HOST)) {
                    warned = true;
                    console.warn('[GeminiHotkeys] Speech requests are now being made with fetch(), which is not monitored - dictation failures will not be auto-detected until a fetch hook is added back to error-monitor.js.');
                    return;
                }
            }
        }).observe({ type: 'resource', buffered: true });
    } catch (err) {
        // Resource Timing unavailable - the tripwire is a nicety, not required.
    }

    // --- Console helper ---
    // DevTools' default console context is the page's own MAIN world, not the
    // isolated world content.js runs in - so a `window.runInspection` defined
    // in content.js is invisible from the console (ReferenceError). This
    // script does run in MAIN, so the callable entry point lives here and
    // just forwards to content.js over the same CustomEvent bridge used for
    // speech errors. content.js does the actual inspecting and prints the
    // table to the console as usual.
    //
    // runInspection(label, delaySeconds): the optional delay exists because
    // typing into the DevTools console pulls focus away from the page, which
    // is awkward when the state to capture is "mid-dictation". Run e.g.
    // runInspection("mid-dictation", 8), click back into the page, press the
    // mic key, and the table prints 8 seconds later.
    window.runInspection = function (label = 'manual', delaySeconds = 0) {
        const fire = () => window.dispatchEvent(new CustomEvent('gemini-hotkeys:run-inspection', { detail: { label: String(label) } }));
        if (delaySeconds > 0) {
            setTimeout(fire, delaySeconds * 1000);
            return `Inspection "${label}" scheduled in ${delaySeconds}s.`;
        }
        fire();
        return `Inspection "${label}" requested.`;
    };

    // Same bridge for the self-check: runHealthCheck() reports whether every
    // part of Gemini's page the extension depends on can still be found.
    window.runHealthCheck = function () {
        window.dispatchEvent(new CustomEvent('gemini-hotkeys:run-health-check'));
        return 'Health check requested.';
    };

    // Same bridge for runTimingReport(): prints a summary of how long
    // model switches have actually been taking this session (Gemini's own
    // click-to-pane response time specifically, plus overall totals), for
    // tuning TIMING.menuOpenRetryInterval etc. against real numbers.
    window.runTimingReport = function () {
        window.dispatchEvent(new CustomEvent('gemini-hotkeys:run-timing-report'));
        return 'Timing report requested.';
    };
})();