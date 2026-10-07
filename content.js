// ==========================================
// DEFAULT KEYBINDS
// ==========================================
// F1: Toggle Microphone
// F2: Flash Lite
// F3: Flash
// F4: Pro / Advanced
// F8: Extended thinking
// Enter: Send immediately (intercepts dictation, waits out image uploads,
//         native handler does the rest for a plain send)

// Guards against a duplicate injection setting up a second, independent set
// of listeners - e.g. if the extension gets reloaded while a tab is still
// open, an old instance of this script can end up still running alongside
// the new one. With two active keydown listeners, every hotkey fires
// twice: F1 would start dictation, then the second listener would
// immediately see it's now on and stop it again before anything gets said.
if (window.__geminiHotkeysInjected) {
    console.log('%c[GeminiHotkeys] duplicate injection detected - skipping (an existing instance is already running).', 'color:#f59e0b;font-weight:bold;');
} else {
    window.__geminiHotkeysInjected = true;

// ==========================================
// CONFIG - fragile Gemini-specific selectors and timing values live here.
// If a future Gemini update breaks something, this is the first place to
// look: check the relevant selector against the live DOM before digging
// into the logic below.
// ==========================================

// Set to true to re-enable verbose per-action console logging (model
// switches, mic toggles, send flow, navigation/default-model decisions,
// dictation-cancel tracing, etc). Warnings for actual failures (e.g.
// "trigger not found") always print regardless of this flag.
const DEBUG = true; // TEMP: flip back to false once the chat-bar model-switch bug is diagnosed

// The ~5-second "poll tick" heartbeat is chatty enough to bury everything
// else, so it has its own switch on top of DEBUG (both must be true). Only
// useful when checking whether the browser is throttling the poll loop
// while the tab is hidden - see the tab-highlight code at the bottom.
const DEBUG_POLL = false;

const SELECTORS = {
    // Matches the compose textbox. Currently a Quill editor (div.ql-editor),
    // but kept generic so it also matches a plain <textarea> or
    // role="textbox" if Gemini's editor implementation changes.
    composeBox: 'textarea, div[contenteditable="true"], [role="textbox"]',
    // The button that opens the Flash/Pro/Extended thinking picker.
    modeMenuTrigger: 'button[data-test-id="bard-mode-menu-button"], button[data-test-id="gemini-mode-menu-button"], [aria-label*="mode picker" i]',
    // Angular CDK overlay panes (dropdowns/menus render into these).
    overlayPane: '.cdk-overlay-pane',
    // Best-effort "something is uploading" indicators. See getUploadingIndicators
    // for why buttons/body/html/oversized elements are filtered back out.
    uploadIndicators: '[role="progressbar"], [class*="spinner" i], [class*="loading" i], [class*="uploading" i], [aria-label*="uploading" i]',
    // A control that lives in the compose box's own toolbar (send / mic).
    // getInputBar() looks for the nearest ancestor of the compose box that
    // contains one of these, to tell the real input bar's buttons apart from
    // look-alikes elsewhere on the page.
    inputBarAnchor: '[aria-label*="send" i], [aria-label*="dictat" i], [aria-label*="microphone" i], [data-test-id*="send" i]',
    // Candidates for the "stop generating" control - a cheap attribute
    // pre-filter, so the poll loop doesn't have to measure every button on
    // the page every tick (see isResponseGenerating).
    stopControls: 'button[aria-label*="stop" i], [role="button"][aria-label*="stop" i], button[data-test-id*="stop" i], [role="button"][data-test-id*="stop" i]',
    // Same idea for the mic's stop button, which can also be identified by
    // title (see getStopMicButton).
    stopMicControls: 'button[aria-label*="stop" i], button[title*="stop" i], button[data-test-id*="stop" i], [role="button"][aria-label*="stop" i], [role="button"][title*="stop" i], [role="button"][data-test-id*="stop" i], [role="switch"][aria-label*="stop" i], [role="switch"][title*="stop" i], [role="switch"][data-test-id*="stop" i]',
};

const TIMING = {
    // The final dictation transcript can land asynchronously with variable
    // timing (confirmed via diagnostics - a fixed delay sometimes fired
    // before the real transcript had even arrived). Both dictation-completion
    // flows below watch for the compose box's content to actually settle,
    // rather than guessing at a fixed delay.
    dictationStablePollInterval: 100,   // how often to recheck content while waiting for it to settle
    dictationStableRequired: 250,       // content must be unchanged for this long to be considered "settled"
    dictationSendSafetyCeiling: 60000,  // stopDictationAndSend gives up after this long rather than ever sending a possibly-incomplete transcript - this should essentially never be hit in practice
    dictationCancelEnforceWindow: 15000, // background-watch ceiling for cancelDictation - decoupled from focus-reclaim speed, so this can be generous
    speechErrorDebounceWindow: 1200,     // ignore speech-backend "errors" this soon after we stopped dictation ourselves - normal connection teardown, not a real failure
    dictationTeardownGrace: 1500,        // after we cancel dictation, how long the UI may still read "dictating" before a dictating UI is taken to be a NEW session (which the cancel watcher must then leave alone)
    defaultModelDictationDefer: 120000,  // how long a default-model switch will wait for an in-progress dictation to finish before skipping the switch
    uploadPollInterval: 200,      // how often to recheck isImageUploading()
    uploadTimeout: 30000,         // give up waiting on a stuck/failed upload after this long
    uploadLogInterval: 3000,      // how often to print a "...still waiting" progress line
    menuPaneTimeout: 3000,        // how long to wait for a model-picker pane to appear
    menuPanePollInterval: 25,     // how often to re-check for the pane (or a superseding request) once waiting has started. Unlike menuOpenRetryInterval/modelSwitchSettleDelay below, this doesn't ask Gemini's UI to do anything faster or risk interrupting an in-progress animation - it only controls how promptly this code NOTICES something that already happened, so there's no reliability tradeoff in lowering it. Kept above a single browser frame (~16ms) rather than pushed lower still, since checking faster than the DOM can plausibly have changed buys nothing
    modelSwitchSettleDelay: 200,  // gap before starting a QUEUED switch right after the previous one finished - clicking to reopen the menu again too soon after closing it can land mid-animation and get ignored by Gemini's own UI, which is exactly what double-tapping (or OS key-repeat) triggers
    menuOpenRetryInterval: 150,   // re-click the trigger if it's produced ZERO overlay panes this long into the wait - confirmed via a captured trace that a single open-click can be silently ignored by Gemini's UI even with completely normal, non-racing preconditions (correct trigger, aria-expanded=false, not superseded); a fixed pre-click delay can't fully solve that since it's guessing how long Gemini needs, so this retries within the existing timeout instead of extending it. Set from real runTimingReport() data: normal click-to-pane response is tightly clustered at 25-27ms (p50=26ms, p90=27ms) with nothing observed in between that and a dropped click, so 150ms leaves ~5x margin above normal response time while cutting worst-case recovery well below the 400ms this was previously set to. Still well above menuPanePollInterval so a single noisy poll tick can't trigger it, and the ZERO-total-panes guard (not just zero visible) means it still won't interrupt a menu that's genuinely mid-render, only one where the click appears to have been dropped entirely - every observed case of this firing has been exactly that ("0 total"), never "some panes exist but aren't visible yet". Re-check with runTimingReport() after a while at this setting - if click-to-pane max stays near 150ms+retry-cost with no failures, there's likely still room to go lower; if "No menu pane appeared" warnings start showing up, this went too far and should come back up
    modelSwitchMaxRetries: 6,     // ceiling on consecutive failed WHOLE-ATTEMPT retries (see runDesiredModel) against the same desired model, so a permanently broken page can't retry forever - generous on purpose since each attempt already has its own internal click-retry and can take up to menuPaneTimeout
    sendButtonRetryWindow: 1500,  // stopDictationAndSend: how long to keep looking for an ENABLED Send button before giving up on it and trying the untrusted-synthetic-Enter fallback - confirmed via a report of a dictated message going missing, most likely because Send was found disabled for one tick right as the dictation UI tore down and the old code never looked again
    sendVerifyDelay: 500,         // plain Enter (not dictating, not uploading): how long to wait before checking whether Gemini's native handler actually sent the message. Confirmed via a report of Enter doing nothing at all until the person alt-tabbed away and back - document.activeElement still correctly pointed at the compose box the whole time (so the existing "nothing focused" failsafe above never triggered), meaning Gemini's own "my Enter listener is live" internal state had desynced invisibly to us. Kept short so the window where the person might keep typing something different stays small
    postSendFocusDelay: 400,      // wait after a plain send before reclaiming focus
    pageLoadFocusDelay: 1000,     // wait after page load before first reclaiming focus
    newChatModelDelay: 10000,     // ceiling for how long to poll for the mode picker trigger to appear before giving up - generous on purpose (it polls every 100ms and stops the moment the trigger exists, so a high ceiling costs nothing, while a low one silently skips the default on a slow load)
    modelSettleTimeout: 2000,     // after we apply a model ourselves, how long to wait for the picker's label to actually show it before moving on (see enableModelRecordingWhenSettled)
    modelRecheckAfterClick: 400,  // re-read the picker's label this long after any click / model switch, to catch a model picked by hand in Gemini's own menu
    healthCheckDelay: 6000,       // the startup self-check runs this long after page load...
    healthCheckRetryDelay: 8000,  // ...and if it found problems, looks once more this much later before warning
    micReadyTimeout: 10000,       // ceiling for how long to wait for the mic button if F1 is pressed before the page finishes loading
    micReadyPollInterval: 150,
    focusRetryDelays: [0, 50, 200, 600, 1500], // reclaimFocus() retry schedule - Gemini
                                                 // appears to (re)steal focus itself shortly
                                                 // after load/send/menu actions, so a single
                                                 // attempt isn't reliable.
};

function log(...args) {
    if (DEBUG) console.log('[GeminiHotkeys]', ...args);
}
function warn(...args) {
    console.warn('[GeminiHotkeys]', ...args);
}

console.log('%c[GeminiHotkeys] content script loaded', 'color:#4CAF50;font-weight:bold;');
console.log('[GeminiHotkeys] tip: run runInspection("manual") in this console any time to log a table of every visible button on the page. Add a delay in seconds as a second argument - e.g. runInspection("mid-dictation", 8) - to capture a state you have to click away from the console to set up. Also: runHealthCheck() reports whether every part of Gemini\'s page this extension depends on can still be found, runDictationReport() prints what happened around recent dictation sessions, and runTimingReport() summarizes how long model switches have actually been taking.');

// Programmatically clicking the mic button (via toggleMicrophone) gives it
// browser focus, which shows as a visible outline ring. toggleMicrophone
// already blurs it immediately after, but that's a timing-dependent fix -
// this CSS rule suppresses the ring outright so there's no flash regardless
// of paint timing. Scoped narrowly to buttons whose aria-label mentions
// dictation ("Dictate" / "Stop dictation" both match "dictat").
(function injectFocusRingSuppression() {
    const style = document.createElement('style');
    style.textContent = `
        button[aria-label*="dictat" i]:focus,
        button[aria-label*="dictat" i].cdk-focused,
        button[aria-label*="dictat" i].cdk-program-focused {
            outline: none !important;
            box-shadow: none !important;
        }
        button[aria-label*="dictat" i] .mat-mdc-focus-indicator::before {
            opacity: 0 !important;
        }
    `;
    (document.head || document.documentElement).appendChild(style);
})();

function runInspection(label) {
    const rows = Array.from(document.querySelectorAll('button, [role="button"], [role="combobox"], [role="option"], [aria-label]'))
        .filter(b => b.getBoundingClientRect().width > 0 && b.getBoundingClientRect().height > 0)
        .map(b => ({
            tag: b.tagName.toLowerCase(),
            text: b.textContent.trim().slice(0, 50),
            ariaLabel: b.getAttribute('aria-label'),
            testId: b.getAttribute('data-test-id'),
            hasPopup: b.getAttribute('aria-haspopup'),
            disabled: b.disabled || b.getAttribute('aria-disabled') === 'true'
        }));
    console.log(`[GeminiHotkeys] --- visible elements (${label}) ---`);
    console.table(rows);
    // console.table copies out of DevTools as just "Array(8)", so also print
    // the same rows as plain text that survives copy/paste.
    if (rows.length) {
        console.log(rows.map((r, i) =>
            `  [${i}] <${r.tag}> text=${JSON.stringify(r.text)} aria-label=${JSON.stringify(r.ariaLabel)} data-test-id=${JSON.stringify(r.testId)} haspopup=${JSON.stringify(r.hasPopup)} disabled=${r.disabled}`
        ).join('\n'));
    }
    return rows;
}
// NOTE: this `window` is the extension's isolated world, NOT the page's - so
// this assignment is only visible if DevTools' console is switched to this
// extension's context (the "top" dropdown). The entry point that works from
// the default console lives in error-monitor.js (MAIN world) and reaches this
// function through the event listener below.
window.runInspection = runInspection;
window.addEventListener('gemini-hotkeys:run-inspection', (e) => {
    runInspection((e.detail && e.detail.label) || 'manual');
});

// Gemini seems to leave initial focus on the Send button rather than the
// compose textbox. Grab it back once the page has had a chance to render.
setTimeout(() => reclaimFocus(), TIMING.pageLoadFocusDelay);

// Alt-tabbing away and back (or similar window-blur situations) can drop
// focus off the compose box entirely. Reclaim it as soon as the window
// becomes active again, rather than waiting for a failed Enter press to
// notice.
window.addEventListener('focus', () => {
    log('Window regained focus - reclaiming textbox focus.');
    if (isDictationActive()) dictTrace('window regained focus while dictating - this extension moved focus/cursor into the compose box');
    reclaimFocus();
    clearTabHighlight();
});
window.addEventListener('blur', () => {
    if (isDictationActive()) dictTrace('window lost focus while dictating');
});

// Gemini's new-chat URL is bare (e.g. https://gemini.google.com/app), while
// an existing conversation has a trailing id (.../app/<hash>). Used below to
// tell whether a page load or in-app navigation has landed on a fresh
// new-chat screen, which is the only place a default model gets applied.
function isNewChatUrl() {
    return /^\/app\/?$/.test(location.pathname);
}

// The argument lists selectModel() expects for each option, shared between
// the keydown handlers below and the homepage-default setting.
const MODEL_ARGS = {
    flashLite: ['Flash Lite', 'Flash-Lite', '8B'],
    flash: ['Flash'],
    pro: ['Pro', 'Advanced'],
    extended: ['Extended thinking', 'Extended'],
};

let activeKeys = {
    mic: 'F1',
    flashLite: 'F2',
    flash: 'F3',
    pro: 'F4',
    extended: 'F8',
    send: 'Enter',
    sendDuringDictation: 'Space',
    cancelDictation: 'Escape',
    // Its own key, defaulting to Escape too. Safe to share a key with
    // EITHER cancelDictation or sendDuringDictation (see the keydown
    // handler below and options.html) since its own condition - a response
    // generating - can never be true at the same time as dictating. Not
    // safe for cancelDictation and sendDuringDictation to share a key with
    // EACH OTHER though, since both only mean something while dictating.
    stopResponse: 'Escape'
};

// 'off' | 'flashLite' | 'flash' | 'pro' - configured on the options page.
// ('extended' is intentionally not offered here - Extended thinking stays
// F8-only, since toggling it as a "default" doesn't map cleanly onto a
// checkbox-style mode the way picking a base model does.)
let defaultHomeModel = 'off';

// Applied when a new-chat screen is reached from *inside* Gemini (clicking
// "New chat" and the like), as opposed to defaultHomeModel, which covers
// arriving fresh (typed URL, bookmark, link from another site). Same values
// as defaultHomeModel, plus 'previous' = whichever model the chat you just
// left was using (see lastKnownModel below). Independently configurable
// since wanting one doesn't imply wanting the other.
let defaultNewChatModel = 'off';

// ------------------------------------------
// Remembering the last-used model
// ------------------------------------------
// Backs the "Same model as previous chat" option. The model currently
// selected is read back out of the mode picker trigger (its aria-label ends
// in "...currently 3.6 Flash") and mapped onto one of the MODEL_ARGS keys.
// It's mirrored into chrome.storage.local - device-local rather than synced,
// since which model you last used on this machine isn't something to sync -
// so it survives a full page load, where all in-memory state is lost.
const LAST_MODEL_STORAGE_KEY = 'lastUsedModel';
let lastKnownModel = null;          // 'flashLite' | 'flash' | 'pro' | null (nothing seen yet) - the remembered preference
let lastSeenDisplayedModel = null;  // what the picker showed the last time we looked; recording keys off CHANGES to this

// Recording is paused whenever the picker might be showing Gemini's own
// reset default instead of a real choice: from script start until the
// initial load has been dealt with, and again from the moment a default is
// applied until the picker has settled. Without this, Gemini resetting the
// picker on arrival at a new chat would get recorded as "the previous
// chat's model" and overwrite the very value we're about to restore.
let modelRecordingEnabled = false;
let modelApplyGeneration = 0;       // lets a newer apply supersede an older one that's still settling

let lastPath = location.pathname;

function modelKeyFromText(text) {
    const t = (text || '').toLowerCase();
    if (/\blite\b|\b8b\b/.test(t)) return 'flashLite';
    if (/\bflash\b/.test(t)) return 'flash';
    if (/\bpro\b|\badvanced\b/.test(t)) return 'pro';
    return null; // e.g. "Extended thinking" alone - not a base model, so nothing to remember
}

// Deliberately uses only the known selector (via getVisibleModeMenuTrigger()),
// not findModelDropdownTrigger()'s fuzzy fallback: that heuristic can latch
// onto an unrelated button that merely mentions a model name (say, a sidebar
// chat titled "Pro tips"), and here a wrong guess would get saved as the
// person's preferred model.
function getCurrentModelKey() {
    const trigger = getVisibleModeMenuTrigger();
    if (!trigger) return null;
    const aria = trigger.getAttribute('aria-label') || '';
    const match = aria.match(/currently\s+(.+)$/i);
    return modelKeyFromText(match ? match[1] : trigger.textContent);
}

function recordModelIfChanged(source) {
    // Any navigation we haven't processed yet has to be handled first: on
    // arrival at a new chat, Gemini may reset the picker to its own default,
    // and recording that before the arrival is noticed would overwrite the
    // value we're about to restore.
    checkForPathChange(`before recording (${source})`);
    if (!modelRecordingEnabled) return;

    const key = getCurrentModelKey();
    if (!key || key === lastSeenDisplayedModel) return;
    lastSeenDisplayedModel = key;
    if (key === lastKnownModel) return;

    lastKnownModel = key;
    log(`Last-used model is now "${key}" (${source}).`);
    try {
        chrome.storage.local.set({ [LAST_MODEL_STORAGE_KEY]: key });
    } catch (err) {
        warn('Could not save the last-used model:', err);
    }
}

// Resumes recording once the picker shows the model we just applied - or
// once the timeout passes, or if the switch failed outright (expectedKey
// null). Whatever the picker shows at that point becomes the baseline
// WITHOUT being recorded: if the switch worked, it matches the remembered
// model anyway; if it didn't (say Pro was greyed out at that moment), the
// remembered preference is left alone rather than being overwritten by a
// model we merely failed to leave. Recording then follows real changes.
function enableModelRecordingWhenSettled(expectedKey) {
    const deadline = Date.now() + TIMING.modelSettleTimeout;
    (function check() {
        if (!expectedKey || getCurrentModelKey() === expectedKey || Date.now() >= deadline) {
            lastSeenDisplayedModel = getCurrentModelKey();
            modelRecordingEnabled = true;
            log(`Picker settled on "${lastSeenDisplayedModel}" - resuming last-used-model recording.`);
            return;
        }
        setTimeout(check, 100);
    })();
}

// Returns true if it started switching the model (recording then stays
// paused until that has settled), false if there was nothing to do - callers
// use that to decide whether they need to resume recording themselves.
function applyModelDefault(modelSetting, contextLabel) {
    if (!isNewChatUrl()) return false;

    // 'previous' resolves to whatever model was last seen in the picker;
    // every other setting is already a MODEL_ARGS key (or 'off').
    const modelKey = modelSetting === 'previous' ? lastKnownModel : modelSetting;
    if (!modelKey || modelKey === 'off' || !MODEL_ARGS[modelKey]) {
        log(`${contextLabel} - no model default to apply (setting="${modelSetting}", resolved to "${modelKey}").`);
        return false;
    }
    log(`${contextLabel} - defaulting to ${modelKey}${modelSetting === 'previous' ? ' (same as previous chat)' : ''}.`);

    const generation = ++modelApplyGeneration;
    modelRecordingEnabled = false;

    let finished = false;
    const finish = (ok) => {
        if (finished) return;
        finished = true;
        if (generation === modelApplyGeneration) enableModelRecordingWhenSettled(ok ? modelKey : null);
    };
    // Safety net: an unexpected failure somewhere inside selectModel must
    // never be able to leave recording paused for good.
    setTimeout(() => finish(false), TIMING.newChatModelDelay + TIMING.menuPaneTimeout + 2000);

    // Switch as soon as the mode picker trigger actually exists, rather
    // than waiting a flat delay - minimizes how long Gemini's own
    // last-used model stays visible before we switch it.
    const deadline = Date.now() + TIMING.newChatModelDelay;
    let dictationDeadline = 0;
    (function waitForTrigger() {
        if (generation !== modelApplyGeneration) return; // superseded by a newer navigation
        if (findModelDropdownTrigger()) {
            // Opening the model menu moves focus, which can end a dictation
            // already in progress (F1 pressed right after opening a new chat,
            // say) - so wait until it's over instead of interrupting it.
            if (isDictationActive()) {
                if (!dictationDeadline) {
                    dictationDeadline = Date.now() + TIMING.defaultModelDictationDefer;
                    dictTrace(`holding the "${contextLabel}" default-model switch until dictation ends (opening the model menu would disturb it)`);
                }
                if (Date.now() < dictationDeadline) return setTimeout(waitForTrigger, 250);
                warn(`Dictation went on too long - skipped the "${contextLabel}" default model switch.`);
                finish(false);
                return;
            }
            selectModel(MODEL_ARGS[modelKey], { silent: true, onDone: finish });
            return;
        }
        if (Date.now() < deadline) return setTimeout(waitForTrigger, TIMING.menuPanePollInterval);
        warn(`Mode picker trigger never appeared - could not apply "${contextLabel}" default model.`);
        finish(false);
    })();
    return true;
}

// Notices in-app navigation onto a fresh new-chat screen (e.g. "New chat"
// clicked from inside a conversation). Deliberately NOT done by wrapping
// history.pushState/replaceState: content scripts run in an isolated world
// with their own copy of `history`, so a wrapper installed here never sees
// the calls Gemini's own code makes (the same limitation error-monitor.js
// documents for fetch/XHR). Instead it listens to signals that do reach an
// isolated world, and any of them may trigger it - checkForPathChange is
// idempotent, so it only acts once per actual path change:
//   1. Navigation API 'currententrychange' - fires for pushState,
//      replaceState and back/forward alike.
//   2. popstate - back/forward.
//   3. The polling interval at the bottom of this file, as a backstop
//      (via recordModelIfChanged, which checks for a path change first).
function checkForPathChange(source) {
    if (location.pathname === lastPath) return;
    log(`${source}: pathname "${lastPath}" -> "${location.pathname}"`);
    lastPath = location.pathname;
    if (isNewChatUrl()) applyModelDefault(defaultNewChatModel, 'New chat opened from inside Gemini');
}

if (window.navigation && typeof window.navigation.addEventListener === 'function') {
    window.navigation.addEventListener('currententrychange', () => checkForPathChange('navigation API'));
}
window.addEventListener('popstate', () => checkForPathChange('popstate'));

// A model picked by hand in Gemini's own menu: re-read the picker shortly
// after any click (long enough for its label to update). The polling
// interval at the bottom of this file is the backstop for anything missed.
document.addEventListener('click', (e) => {
    // The person (isTrusted) using the mic / stop button themselves: see personTouchedMic.
    if (e.isTrusted && e.target && e.target.closest) {
        const btn = e.target.closest('button, [role="button"], [role="switch"]');
        if (btn && isMicControl(btn)) personTouchedMic(`person clicked the mic control ("${btn.getAttribute('aria-label') || ''}")`);
    }
    setTimeout(() => recordModelIfChanged('click'), TIMING.modelRecheckAfterClick);
}, true);

// Last chance to save the model in use before the page goes away. Storage
// writes are asynchronous, so this is best-effort - the click and poll
// checks are what normally keep the stored value current.
window.addEventListener('pagehide', () => recordModelIfChanged('pagehide'));

// True when this page load was reached by navigating from another
// gemini.google.com page - i.e. the person clicked something inside Gemini
// (like "New chat") and it caused a real page load rather than an in-page
// navigation. An empty or external referrer means a fresh visit (typed URL,
// bookmark, link from elsewhere). If Gemini ever sends a stripped referrer
// this just reads as "fresh visit" and the homepage default is used.
function cameFromWithinGemini() {
    if (!document.referrer) return false;
    try {
        return new URL(document.referrer).origin === location.origin;
    } catch (err) {
        return false;
    }
}

function handleInitialLoad() {
    const fromInside = cameFromWithinGemini();
    log(`Page load: pathname="${location.pathname}", referrer="${document.referrer}", fromInsideGemini=${fromInside}, defaultHomeModel="${defaultHomeModel}", defaultNewChatModel="${defaultNewChatModel}", lastKnownModel="${lastKnownModel}"`);
    const applying = applyModelDefault(
        fromInside ? defaultNewChatModel : defaultHomeModel,
        fromInside ? 'Landed on new chat from inside Gemini (page load)' : 'Landed on new chat via fresh visit (page load)'
    );
    // Nothing being restored, so whatever the picker shows is the real state.
    if (!applying) modelRecordingEnabled = true;
}

try {
    chrome.storage.sync.get({ ...activeKeys, defaultHomeModel, defaultNewChatModel }, (items) => {
        activeKeys = {
            mic: items.mic, flashLite: items.flashLite, flash: items.flash,
            pro: items.pro, extended: items.extended, send: items.send,
            sendDuringDictation: items.sendDuringDictation, cancelDictation: items.cancelDictation,
            stopResponse: items.stopResponse
        };
        defaultHomeModel = items.defaultHomeModel;
        defaultNewChatModel = items.defaultNewChatModel;
        // Only apply defaults once settings AND the remembered model have
        // actually loaded, so they respect what's configured rather than a
        // hardcoded fallback ("Same model as previous chat" depends on the
        // remembered model being in memory before anything is applied).
        chrome.storage.local.get({ [LAST_MODEL_STORAGE_KEY]: null }, (local) => {
            lastKnownModel = local[LAST_MODEL_STORAGE_KEY];
            handleInitialLoad();
        });
    });
    chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'sync') {
            for (let [key, { newValue }] of Object.entries(changes)) {
                if (key === 'defaultHomeModel') defaultHomeModel = newValue;
                else if (key === 'defaultNewChatModel') defaultNewChatModel = newValue;
                else if (key in activeKeys) activeKeys[key] = newValue;
            }
        }
    });
} catch (err) {
    warn('chrome.storage unavailable, using default keybinds:', err);
    handleInitialLoad(); // falls back to 'off' above
}

// True if el (or its nearest element ancestor, for a text node) is
// somewhere a person can type ordinary text: a contenteditable region
// (Gemini's own compose box), a <textarea>, or a text-like <input>.
function isEditableContext(el) {
    if (!el) return false;
    if (el.nodeType === Node.TEXT_NODE) el = el.parentElement;
    if (!el || typeof el.closest !== 'function') return false;
    return !!el.closest(
        '[contenteditable="true"], textarea, ' +
        'input:not([type="checkbox"]):not([type="radio"]):not([type="button"]):not([type="submit"]):not([type="range"])'
    );
}

function matchKey(e, savedKeyStr, { guardTyping = false } = {}) {
    if (!savedKeyStr) return false;
    const parts = savedKeyStr.split('+');
    let mainKey = parts.pop().toLowerCase();
    const needsCtrl = parts.includes('Ctrl');
    const needsAlt = parts.includes('Alt');
    const needsShift = parts.includes('Shift');
    const needsMeta = parts.includes('Meta');

    // A binding saved with NO modifiers, on a key that's currently
    // producing a plain character (e.key.length === 1: letters, digits,
    // punctuation, space), must not fire while the person is typing in an
    // editable field - it would both swallow that character
    // (preventDefault) and fire the action on every occurrence of it in
    // ordinary text. Confirmed by a report of the mode-picker menu
    // visibly reacting on every keystroke while composing a message: a
    // custom model-switch binding had landed on a bare letter.
    //
    // Opted into by mic toggle, the four model-switch keys, and Stop
    // Response (guardTyping: true at each call site below) - all five fire
    // unconditionally (or close to it) the instant the key matches, with
    // nothing else reliably standing between a bare-letter binding and
    // typing it into a message. Stop Response's own precondition (a
    // response is generating) does NOT make it safe to leave unguarded the
    // way it first looks: typing your next message while the previous
    // response is still streaming in is completely ordinary behavior, not
    // a rare overlap - confirmed by a report of exactly that canceling the
    // response mid-generation. Cancel Dictation and Send During Dictation
    // are different and deliberately NOT guarded: dictating and physically
    // typing aren't something a person does at the same time the way
    // typing-while-a-response-streams is, so their own precondition
    // (dictation genuinely active) already makes them harmless during
    // ordinary typing - and guarding them here too would break the real
    // case Send During Dictation is FOR, since its default Space key needs
    // to fire while focus is in the very same compose box dictation types
    // into, which is indistinguishable from "editable context" by this
    // check alone.
    //
    // Bindings that include a modifier (Ctrl+P, Alt+1...), or sit on a key
    // that never produces text regardless of modifiers (F-keys, Escape,
    // arrows - e.key.length !== 1), are completely unaffected either way
    // and keep working everywhere, including mid-typing, exactly as
    // intended - true for every default binding this extension ships.
    if (guardTyping && !needsCtrl && !needsAlt && !needsShift && !needsMeta && e.key.length === 1 && isEditableContext(e.target)) {
        return false;
    }

    let eKey = e.key.toLowerCase();
    if (eKey === ' ') eKey = 'space';
    return (
        e.ctrlKey === needsCtrl &&
        e.altKey === needsAlt &&
        e.shiftKey === needsShift &&
        e.metaKey === needsMeta &&
        eKey === mainKey
    );
}

// Stops dictation and sends, same flow whether triggered by Enter or by
// Space (see the Space handler below) while dictating.
function stopDictationAndSend() {
    log('Dictation active. Stopping and sending...');
    dictTrace('stop-and-send requested (Enter / send-during-dictation key)');
    dictationWatchGeneration++;
    lastDictationActionTime = Date.now();
    dictationStartedByUsAt = 0;

    clickStopDictation('stop-and-send');

    const doSend = () => {
        const sendBtn = getSendButton();
        if (sendBtn) {
            log('Clicking real Send button.');
            sendBtn.click();
            return;
        }
        // Not found on the first look doesn't mean it's not coming - Send can
        // be genuinely disabled for a tick right as the dictation UI tears
        // down (findSendButtonIn() correctly skips a disabled button, so
        // that alone lands here). Confirmed as the most likely cause of a
        // dictated message vanishing outright: the old code gave up after
        // exactly one check and fell straight to a synthetic Enter, which
        // has isTrusted: false and Gemini's own handler appears to just
        // ignore it - so nothing happened, silently, and the text was never
        // sent. Keep looking for a real, clickable button for a bit before
        // ever reaching for that fallback.
        let retries = 0;
        const retryDeadline = Date.now() + TIMING.sendButtonRetryWindow;
        (function retrySend() {
            const btn = getSendButton();
            if (btn) {
                log(`Clicking real Send button (found after ${retries} retr${retries === 1 ? 'y' : 'ies'}).`);
                btn.click();
                return;
            }
            retries++;
            if (Date.now() < retryDeadline) {
                setTimeout(retrySend, TIMING.dictationStablePollInterval);
                return;
            }
            dictTrace(`stop-and-send: no enabled Send button appeared within ${TIMING.sendButtonRetryWindow}ms - text is still in the box, falling back to a synthetic Enter (which may be ignored)`);
            warn('No Send button became available after stopping dictation. The transcribed text is still in the box - send it manually if the fallback below doesn\'t work.');
            const box = getComposeBox();
            if (box) {
                box.focus({ preventScroll: true });
                fireEnterKey(box);
            }
        })();
    };

    const box = getComposeBox();
    if (!box) {
        setTimeout(doSend, TIMING.dictationStableRequired);
        return;
    }

    // Waits for content to stop changing, no matter how long that takes -
    // confirmed the previous fixed ceiling could force a send while the
    // transcript was still actively landing (dictation has been observed
    // taking 5+ seconds to fully settle in some cases), sending a truncated
    // message. The safety ceiling below only gives up and leaves the text
    // in the box for a manual send - it never forces a send on unstable
    // content.
    let lastContent = box.textContent;
    let lastChangeTime = Date.now();
    const safetyDeadline = Date.now() + TIMING.dictationSendSafetyCeiling;
    (function waitForStable() {
        const current = box.textContent;
        if (current !== lastContent) {
            lastContent = current;
            lastChangeTime = Date.now();
        }
        if (Date.now() - lastChangeTime >= TIMING.dictationStableRequired) {
            doSend();
            return;
        }
        if (Date.now() >= safetyDeadline) {
            warn(`Gave up waiting for the dictated text to settle after ${TIMING.dictationSendSafetyCeiling}ms - leaving it in the box rather than risk sending something incomplete. Send it manually when ready.`);
            return;
        }
        setTimeout(waitForStable, TIMING.dictationStablePollInterval);
    })();
}

// Signaled by error-monitor.js (running in the page's own MAIN world - see
// manifest.json) when a request to Gemini's speech-recognition backend
// fails. If dictation is active when that happens, cancel it automatically
// rather than letting the person keep talking to a connection that's
// already broken server-side.
window.addEventListener('gemini-hotkeys:speech-error', (e) => {
    const d = e.detail || {};
    const what = `speech backend request failed (${d.via || '?'}, status ${d.status !== undefined ? d.status : (d.error || '?')})`;
    log('Speech backend error detected:', e.detail);

    const sinceLastAction = Date.now() - lastDictationActionTime;
    if (sinceLastAction < TIMING.speechErrorDebounceWindow) {
        dictTrace(`${what} - ignored: only ${sinceLastAction}ms after a start/stop (ours or the person's), normal connection teardown`);
        return;
    }
    if (!isDictationActive()) {
        dictTrace(`${what} - no stop-dictation button is visible, so nothing to do`);
        return;
    }

    // This exists for one failure: a session started with our mic hotkey whose
    // backend request failed before ANYTHING was transcribed, leaving the mic
    // showing "listening" while nothing is heard. The rescue is deliberately
    // tiny - one click on the stop button, nothing else: no restoring text, no
    // watcher, and never the start button. Any other situation is left alone:
    // dictation the person started or stopped themselves, or a session that
    // already produced text (never discard dictated text over a network error).
    if (!dictationStartedByUsAt) {
        dictTrace(`${what} - this session wasn't started by our hotkey (or the person has taken over since), so leaving it alone`);
        return;
    }
    const box = getComposeBox();
    const nothingTranscribed = preDictationSnapshot !== null && !!box && box.textContent === preDictationSnapshot;
    if (!nothingTranscribed) {
        dictTrace(`${what} - text is already in the box, so NOT stopping`);
        warn('Speech backend error while dictating - leaving dictation and the transcribed text alone. If dictation has stalled, stop it yourself.');
        return;
    }
    dictTrace(`${what} - nothing transcribed yet: stopping this dictation (stop button only)`);
    warn('Stopping dictation - the speech backend failed before anything was transcribed.');
    lastDictationActionTime = Date.now();
    dictationStartedByUsAt = 0;
    preDictationSnapshot = null;
    if (clickStopDictation('auto-stop')) reclaimFocus();
});

// Stops dictation and reverts the compose box to preDictationSnapshot -
// removing only what THIS dictation session added, not anything typed
// beforehand. Triggered by the cancel key while dictating (see keydown
// handler) or automatically on a speech-backend failure (see above).
function cancelDictation(reason = 'cancel key pressed') {
    dictTrace(`cancel requested (${reason}) - stopping dictation and discarding what this session added`);
    log('Cancelling dictation - stopping and discarding what this session added.');
    const myGeneration = ++dictationWatchGeneration;
    lastDictationActionTime = Date.now();
    dictationStartedByUsAt = 0;

    clickStopDictation('cancel');

    const box = getComposeBox();
    const snapshot = preDictationSnapshot;
    preDictationSnapshot = null;
    log(`cancelDictation: box found=${!!box}, snapshot=${JSON.stringify(snapshot)}, current text=${JSON.stringify(box ? box.textContent : null)}`);

    if (!box || snapshot === null) {
        reclaimFocus();
        return;
    }

    // The late transcript can arrive well after stopping - sometimes several
    // seconds later. Reclaiming focus quickly (as soon as content looks
    // stable) and reliably catching a much later arrival are in tension
    // using a single loop that stops on the first one: this splits them -
    // focus comes back fast, but a lighter watch keeps running well past
    // that to catch a late arrival, aborting immediately the moment a real
    // (trusted) keydown happens on the box, so it can never overwrite
    // something the person actually typed themselves. It also aborts the
    // instant a NEWER dictation action supersedes it (checked via
    // dictationWatchGeneration) - without this, cancelling twice within the
    // same window left two watchers correcting the box against two
    // different snapshots at once, corrupting the text.
    let userTookOver = false;
    const stopOnRealInput = (e) => {
        if (e.isTrusted) userTookOver = true;
    };
    box.addEventListener('keydown', stopOnRealInput);

    let stableSince = null;
    let tickCount = 0;
    let focusReclaimed = false;
    const startTime = Date.now();
    const deadline = startTime + TIMING.dictationCancelEnforceWindow;
    (function enforceSnapshot() {
        if (myGeneration !== dictationWatchGeneration) {
            log(`tick ${tickCount} @ ${Date.now() - startTime}ms: superseded by a newer dictation action - stopping this watch.`);
            box.removeEventListener('keydown', stopOnRealInput);
            return;
        }
        if (userTookOver) {
            log('Person started typing - stopped watching for a late dictation arrival.');
            box.removeEventListener('keydown', stopOnRealInput);
            return;
        }
        // dictationWatchGeneration only counts OUR actions, so a new session
        // started some other way (a mouse click on the mic, say) wouldn't
        // supersede this watch - and it would then clear that session's
        // text every 100ms until the window ended. The grace period is
        // because right after our own stop click the UI can still read
        // "dictating" for a moment.
        if (Date.now() - startTime > TIMING.dictationTeardownGrace && isDictationActive()) {
            dictTrace('cancel watch stopped - dictation is active again (started some other way), so its text must not be wiped');
            box.removeEventListener('keydown', stopOnRealInput);
            return;
        }

        tickCount++;
        const current = box.textContent;
        if (current !== snapshot) {
            log(`tick ${tickCount} @ ${Date.now() - startTime}ms: mismatch, current=${JSON.stringify(current)} - re-clearing.`);
            box.textContent = snapshot;
            box.dispatchEvent(new Event('input', { bubbles: true }));
            stableSince = null; // content just got corrected - restart the stability clock
        } else if (stableSince === null) {
            stableSince = Date.now();
        }

        if (!focusReclaimed && stableSince !== null && Date.now() - stableSince >= TIMING.dictationStableRequired) {
            log(`Stable after ${tickCount} ticks (${Date.now() - startTime}ms) - reclaiming focus, background watch continues.`);
            reclaimFocus();
            focusReclaimed = true;
            // Deliberately not returning here - keep watching in the
            // background for the rest of the window.
        }

        if (Date.now() < deadline) {
            setTimeout(enforceSnapshot, TIMING.dictationStablePollInterval);
        } else {
            box.removeEventListener('keydown', stopOnRealInput);
            log(`Background watch ended after ${TIMING.dictationCancelEnforceWindow}ms (${tickCount} ticks). Final text=${JSON.stringify(box.textContent)}`);
            if (!focusReclaimed) reclaimFocus();
        }
    })();
}

window.addEventListener('keydown', (e) => {
    // Gemini's own dictation shortcut (its stop button is labelled "^⇧D"): the person again.
    if (e.isTrusted && e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey && String(e.key).toLowerCase() === 'd') {
        personTouchedMic("person used Gemini's own dictation shortcut (Ctrl+Shift+D)");
    }
    if (matchKey(e, activeKeys.mic, { guardTyping: true })) {
        e.preventDefault(); e.stopImmediatePropagation();
        toggleMicrophone();
    }
    // Cancel Dictation, Send During Dictation and Stop Response are handled
    // together in one branch, not as three separate else-if links. Reason:
    // Stop Response's own condition (a response generating) can never be
    // true at the same time as dictating, so it's safe - and deliberately
    // supported (see options.html) - for it to share a key with EITHER of
    // the other two. A plain else-if chain can't express that correctly
    // though: once one branch's key matches, the chain never even looks at
    // the next branch, regardless of whether that first branch's own
    // condition turned out false - so if Stop Response's key matched but
    // nothing was generating, a key it shared with Send During Dictation
    // would go nowhere, silently breaking Send During Dictation right when
    // dictation was actually active and waiting for that exact key.
    // Checking all three together up front avoids that: whichever one's
    // precondition is actually true right now is the one that fires.
    // Cancel Dictation and Send During Dictation are NOT meant to share a
    // key with EACH OTHER (see the warning in options.html) - if they are
    // set to the same key anyway, Cancel Dictation takes priority.
    else if (matchKey(e, activeKeys.cancelDictation) || matchKey(e, activeKeys.sendDuringDictation) || matchKey(e, activeKeys.stopResponse, { guardTyping: true })) {
        if (matchKey(e, activeKeys.cancelDictation) && isDictationActive()) {
            e.preventDefault(); e.stopImmediatePropagation();
            cancelDictation();
        } else if (matchKey(e, activeKeys.sendDuringDictation) && isDictationActive()) {
            e.preventDefault(); e.stopImmediatePropagation();
            log('Send-during-dictation key pressed - stopping and sending.');
            stopDictationAndSend();
        } else if (matchKey(e, activeKeys.stopResponse, { guardTyping: true })) {
            const stopBtn = getStopGeneratingButton();
            if (stopBtn) {
                e.preventDefault(); e.stopImmediatePropagation();
                log('Stop-response key pressed while a response was generating - stopping it.');
                stopBtn.click();
                suppressFocusRing(stopBtn);
                reclaimFocus();
            }
        }
        // Else: one of these three keys matched, but its own precondition
        // isn't true right now (not dictating, nothing generating) - leave
        // it alone entirely, no preventDefault, so its normal job (closing
        // a menu, typing a space, etc.) still happens.
    }
    else if (matchKey(e, activeKeys.flashLite, { guardTyping: true })) {
        e.preventDefault(); e.stopImmediatePropagation();
        selectModel(MODEL_ARGS.flashLite, { silent: true });
    }
    else if (matchKey(e, activeKeys.flash, { guardTyping: true })) {
        e.preventDefault(); e.stopImmediatePropagation();
        selectModel(MODEL_ARGS.flash, { silent: true });
    }
    else if (matchKey(e, activeKeys.pro, { guardTyping: true })) {
        e.preventDefault(); e.stopImmediatePropagation();
        selectModel(MODEL_ARGS.pro, { silent: true });
    }
    else if (matchKey(e, activeKeys.extended, { guardTyping: true })) {
        e.preventDefault(); e.stopImmediatePropagation();
        // Just clicks the same menu item every time - Gemini's own
        // checkbox-style behavior handles turning it on and off.
        selectModel(MODEL_ARGS.extended, { silent: true });
    }
    else if (matchKey(e, activeKeys.send)) {
        if (isDictationActive()) {
            e.preventDefault(); e.stopImmediatePropagation();
            stopDictationAndSend();
        } else if (isImageUploading()) {
            // Gemini's own Enter handler seems to just no-op while an
            // attachment is still uploading. Since the person already
            // expressed intent to send by pressing Enter, queue the send:
            // wait for the upload indicator to clear, then click Send
            // ourselves instead of leaving them to guess why nothing happened.
            e.preventDefault(); e.stopImmediatePropagation();
            if (DEBUG) {
                const lines = getUploadingIndicators().map((el, idx) =>
                    `  [${idx}] <${el.tagName.toLowerCase()}> role="${el.getAttribute('role') || ''}" class="${(el.className || '').toString().slice(0, 80)}" aria-label="${el.getAttribute('aria-label') || ''}" text="${el.textContent.trim().slice(0, 40)}"`
                );
                log('Image still uploading - will send once it finishes. Matched indicators:\n' + lines.join('\n'));
            }
            waitForUploadThenSend();
        } else {
            const active = document.activeElement;
            const nothingFocused = !active || active === document.body;

            if (nothingFocused) {
                // Failsafe: Gemini's own Enter-to-send listener is bound to
                // the textbox element itself, so if nothing currently has
                // focus (the classic symptom after alt-tabbing away and
                // back), the keydown never reaches it and Enter silently
                // does nothing. Take over explicitly rather than trusting
                // native handling to receive an event it structurally can't.
                // Deliberately narrow: only fires when NOTHING is focused,
                // so it won't hijack Enter while some other input/dialog is
                // legitimately focused.
                e.preventDefault(); e.stopImmediatePropagation();
                log('Nothing focused (likely lost after alt-tab) - sending via Send button directly.');
                const sendBtn = getSendButton();
                if (sendBtn) sendBtn.click();
                else warn('Failsafe send: no Send button found.');
                reclaimFocus();
            } else {
                log('No dictation active, nothing uploading - leaving Enter alone for native handler.');

                // Verification failsafe for the narrower variant of the
                // "nothing focused" problem above: document.activeElement
                // looks completely normal (it's why we're in this branch
                // at all), yet Gemini's own Enter handling can still
                // silently do nothing - confirmed by a report of exactly
                // that, fixed only by alt-tabbing away and back (which
                // just forces a fresh focus event; see the comment on
                // TIMING.sendVerifyDelay). Only acts on the unambiguous
                // case - the box's text completely unchanged after a
                // beat - so it won't fire if the send actually succeeded
                // (text clears) or if the person kept typing something
                // different in the meantime (text changed but didn't
                // clear): forcing a send in that second case would send
                // the wrong, still-in-progress text, which is worse than
                // doing nothing.
                const composeBoxNow = getComposeBox();
                const textBefore = composeBoxNow ? composeBoxNow.textContent.trim() : '';
                if (textBefore) {
                    setTimeout(() => {
                        const boxAfter = getComposeBox();
                        const textAfter = boxAfter ? boxAfter.textContent.trim() : '';
                        // Unchanged entirely, OR unchanged apart from
                        // gaining one or more newlines - safe to treat the
                        // second case the same as the first (not as "the
                        // person wanted a newline") because matchKey
                        // already required e.shiftKey === false to reach
                        // this branch at all, so a newline appearing here
                        // can't be an intended Shift+Enter.
                        const stripNewlines = (s) => s.replace(/\n/g, '');
                        const sameIgnoringNewlines = stripNewlines(textAfter) === stripNewlines(textBefore);
                        const stuck = textAfter === textBefore || (sameIgnoringNewlines && textAfter.length > textBefore.length);
                        if (textAfter && stuck) {
                            warn('Enter appears to have been silently ignored by Gemini\'s own handler (message still sitting in the box, unsent) - sending via the Send button directly.');
                            const sendBtn = getSendButton();
                            if (sendBtn) sendBtn.click();
                            else warn('Failsafe send: no Send button found.');
                        }
                    }, TIMING.sendVerifyDelay);
                }
                // Gemini clears focus from the textbox to <body> shortly after
                // a send completes, rather than leaving it ready for the next
                // message. Grab it back once the send has had time to process.
                setTimeout(() => reclaimFocus(), TIMING.postSendFocusDelay);
            }
        }
    }
}, true);

// Focuses the compose textbox, retrying a few times over ~1.5s. A single
// attempt isn't reliable - Gemini appears to (re)steal focus itself shortly
// after page load, after a send completes, and after menu interactions
// (moving it to the Send button, <body>, or the menu item just clicked).
// Places the caret at the very end of a contenteditable element's content.
// Plain .focus() alone tends to leave the browser's default caret position
// (typically the start), which is the wrong place to keep typing from after
// dictation adds text, after a send clears the box, etc.
function moveCursorToEnd(el) {
    if (!el) return;
    try {
        const range = document.createRange();
        range.selectNodeContents(el);
        range.collapse(false); // false = collapse to the end, not the start
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
    } catch (err) {
        warn('Could not move cursor to end:', err);
    }
}

function reclaimFocus() {
    const focusBox = () => {
        const inputBox = getComposeBox();
        if (!inputBox) return;

        // Don't disturb an active text selection - whether it's elsewhere
        // on the page (e.g. double-clicking a response to copy it) or
        // inside the compose box itself (e.g. Ctrl+A to select the prompt).
        // Moving the cursor or refocusing would collapse either one. This
        // used to only check selections OUTSIDE the box, which is exactly
        // why a Ctrl+A made after tabbing back into the window (which
        // triggers reclaimFocus) kept getting cancelled.
        const selection = window.getSelection();
        if (selection && selection.toString().length > 0) {
            return;
        }

        // Set the cursor position before focusing, not after - focusing
        // first (then moving the cursor) left a brief window where the
        // browser's default start-of-content caret could actually get
        // painted before the correction landed. A contenteditable
        // generally preserves an already-set selection when it gains
        // focus, rather than resetting it to the start.
        moveCursorToEnd(inputBox);
        // preventScroll stops the browser's default "scroll this element
        // into view on focus" behavior. Without it, since this fires after
        // almost every action (sends, model switches, dictation stops,
        // regaining window focus), it could reset Gemini's own tracking of
        // whether the chat is scrolled to the bottom - suspected cause of
        // the response no longer auto-scrolling into view while streaming.
        inputBox.focus({ preventScroll: true });
    };
    TIMING.focusRetryDelays.forEach(delay => setTimeout(focusBox, delay));
}

// First VISIBLE match, falling back to the first match of any kind (early in
// page load nothing is laid out yet). A bare querySelector would happily
// return a hidden textbox that a future Gemini update renders earlier in the
// DOM than the real compose box.
function getComposeBox() {
    const all = Array.from(document.querySelectorAll(SELECTORS.composeBox)).filter(isReallyVisible);
    if (all.length <= 1) return all[0] || null;

    // Same disambiguation as getVisibleModeMenuTrigger() below, and for the
    // same reason: more than one compose box can pass isReallyVisible() at
    // once if a layout swap (e.g. the chat-bar relocation) leaves the
    // superseded one mounted inside a shrunk/clipped ancestor instead of
    // actually hiding it. Prefer whichever is really on screen.
    const onScreen = all.filter(isActuallyOnScreen);
    if (onScreen.length) return onScreen[0];
    return all[0];
}

// Same "prefer visible, fall back to whatever's there" reasoning as
// getComposeBox(): more than one element can match SELECTORS.modeMenuTrigger
// at once - e.g. Gemini keeping a narrow-viewport trigger in the DOM, hidden
// via CSS, alongside the wide-viewport one it actually shows - and a bare
// querySelector returns whichever is FIRST IN THE DOM, not whichever is on
// screen. Getting this wrong breaks two things at once: clicking the wrong
// (hidden, inert) trigger opens no menu, and reading its label reads the
// wrong model. Shared here so findModelDropdownTrigger() (which clicks it)
// and getCurrentModelKey() (which reads it) always agree on the same
// element. If several matches are genuinely visible at once, the one
// actually on screen wins (see isActuallyOnScreen() below); DOM order is
// only the last-resort tiebreak, same as getComposeBox() uses throughout.
function getVisibleModeMenuTrigger() {
    const all = Array.from(document.querySelectorAll(SELECTORS.modeMenuTrigger)).filter(isReallyVisible);
    if (all.length <= 1) return all[0] || null;

    // More than one candidate passed isReallyVisible() at the same time.
    // Confirmed cause: Gemini moving the mode picker from the top-left
    // header into the chat bar (or back) doesn't always hide the
    // now-superseded trigger via display/visibility/opacity - sometimes
    // it's left mounted inside a shrunk/clipped ancestor instead. That
    // still satisfies every check in isReallyVisible() (getBoundingClientRect
    // reports an element's OWN box, not what an ancestor's overflow clips
    // away), so the stale trigger keeps matching until Angular gets around
    // to actually removing/hiding it - which a click (any click, including
    // our own failed attempt on it) tends to trigger. That's the
    // "sometimes takes two tries right after the picker relocates" bug:
    // the first press can land on the stale trigger and silently no-op,
    // the second lands on the real one because by then Angular has
    // cleaned up the first. isActuallyOnScreen() below disambiguates
    // immediately instead of relying on that incidental cleanup.
    const onScreen = all.filter(isActuallyOnScreen);
    if (onScreen.length) {
        if (onScreen.length > 1) {
            log(`${onScreen.length} mode-menu trigger candidates are genuinely on screen at once - taking the first in DOM order.`);
        } else if (all.length > 1) {
            log(`${all.length} mode-menu trigger candidates matched isReallyVisible(); isActuallyOnScreen() picked the real one and ruled out ${all.length - onScreen.length} stale match(es).`);
        }
        return onScreen[0];
    }
    // None passed the stricter check (e.g. mid-transition, or the page is
    // using a hit-testing trick isActuallyOnScreen doesn't anticipate) -
    // fall back to the original tiebreak rather than returning nothing.
    return all[0];
}

function isReallyVisible(el) {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return false;
    const style = getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none') return false;
    if (parseFloat(style.opacity) === 0) return false;
    if (el.getAttribute('aria-hidden') === 'true') return false;
    return true;
}

// Stricter than isReallyVisible(): also confirms the element is actually
// the thing hit-tested at its own center, not merely passing the
// self-styling checks above while sitting behind something else or inside
// an ancestor that clips it out of view. Deliberately kept separate from
// isReallyVisible() rather than folded into it: elementFromPoint() is
// comparatively expensive and isReallyVisible() also runs inside tight
// loops (e.g. scanning every leaf node inside an open mode menu in
// selectModel()), where the extra cost buys nothing and could even
// misfire on small overlapping icon/text leaves within a single option.
// Used only to disambiguate the rare case where more than one trigger (or
// compose box) candidate is already "really visible" at once.
function isActuallyOnScreen(el) {
    const rect = el.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const vw = window.innerWidth || document.documentElement.clientWidth;
    const vh = window.innerHeight || document.documentElement.clientHeight;
    if (cx < 0 || cy < 0 || cx > vw || cy > vh) return false;
    const hit = document.elementFromPoint(cx, cy);
    return !!hit && (hit === el || el.contains(hit) || hit.contains(el));
}

// The compose box's own toolbar (where the mic and Send live), located as
// the nearest ancestor of the compose box that also contains a send / mic
// control. Used to prefer the real buttons over look-alikes elsewhere on the
// page. Null when it can't be located - every caller then falls back to the
// original page-wide search, so this can only narrow a choice, never lose one.
function getInputBar() {
    const box = getComposeBox();
    let node = box && box.parentElement;
    for (let hops = 0; node && hops < 8; hops++, node = node.parentElement) {
        if (node.querySelector(SELECTORS.inputBarAnchor)) return node;
    }
    return null;
}

// Mic buttons are found by label keywords (the conditions below), which is
// loose by nature: "mic" also appears inside other words, "listen" is also a
// read-aloud button on every response, "voice" may be a different feature
// entirely. So a match inside the input bar always wins over one elsewhere;
// only when the bar has no candidate does the page-wide match (last one in
// DOM order - the original behaviour) get used.
function findMicButtonsIn(root) {
    const allButtons = root.querySelectorAll('button, [role="button"], [role="switch"]');
    let startBtn = null;
    let stopBtn = null;

    for (let btn of allButtons) {
        const rect = btn.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        const label = (btn.getAttribute('aria-label') || '').toLowerCase().trim();
        const title = (btn.getAttribute('title') || '').toLowerCase().trim();
        const testId = (btn.getAttribute('data-test-id') || '').toLowerCase().trim();
        const combined = `${label} ${title} ${testId}`;

        if (combined.includes('generat') || combined.includes('respond') || combined.includes('response')) continue;

        if (
            (combined.includes('stop') && (combined.includes('listen') || combined.includes('mic') || combined.includes('record') || combined.includes('dictat'))) ||
            label === 'stop' || title === 'stop' || testId === 'stop-button'
        ) {
            stopBtn = btn;
        } else if (combined.includes('mic') || combined.includes('voice') || combined.includes('dictate') || combined.includes('listen')) {
            startBtn = btn;
        }
    }
    return { startBtn, stopBtn };
}

function getMicButtons() {
    const everywhere = findMicButtonsIn(document);
    const bar = getInputBar();
    if (!bar) return everywhere;
    const local = findMicButtonsIn(bar);
    return {
        startBtn: local.startBtn || everywhere.startBtn,
        stopBtn: local.stopBtn || everywhere.stopBtn,
    };
}

// Just the stop side of getMicButtons(), found through a cheap attribute
// pre-filter: the stop condition above can only be true for a control whose
// label, title or test id contains "stop", so nothing else needs measuring.
// Same result as getMicButtons().stopBtn. This is what the dictation-state
// check uses, since that runs on every Space / Enter / Escape press and the
// full search would measure every button on the page each time.
function findStopMicButtonIn(root) {
    let stopBtn = null;
    for (let btn of root.querySelectorAll(SELECTORS.stopMicControls)) {
        const rect = btn.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        const label = (btn.getAttribute('aria-label') || '').toLowerCase().trim();
        const title = (btn.getAttribute('title') || '').toLowerCase().trim();
        const testId = (btn.getAttribute('data-test-id') || '').toLowerCase().trim();
        const combined = `${label} ${title} ${testId}`;

        if (combined.includes('generat') || combined.includes('respond') || combined.includes('response')) continue;

        if (
            (combined.includes('stop') && (combined.includes('listen') || combined.includes('mic') || combined.includes('record') || combined.includes('dictat'))) ||
            label === 'stop' || title === 'stop' || testId === 'stop-button'
        ) {
            stopBtn = btn;
        }
    }
    return stopBtn;
}

function getStopMicButton() {
    const bar = getInputBar();
    return (bar && findStopMicButtonIn(bar)) || findStopMicButtonIn(document);
}

// Finds the real "Send message" button, so we can .click() it directly
// instead of faking an Enter keypress. Synthetic KeyboardEvents dispatched
// from JS always have isTrusted: false, and some apps' submit logic ignores
// untrusted key events entirely - clicking the actual button is far more
// reliable since click handlers don't typically discriminate on trust.
function findSendButtonIn(root) {
    const allButtons = root.querySelectorAll('button, [role="button"]');
    for (let btn of allButtons) {
        const rect = btn.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        if (btn.disabled || btn.getAttribute('aria-disabled') === 'true') continue;

        const label = (btn.getAttribute('aria-label') || '').toLowerCase().trim();
        const testId = (btn.getAttribute('data-test-id') || '').toLowerCase().trim();
        const combined = `${label} ${testId}`;

        if (combined.includes('resend') || combined.includes('regenerate') || combined.includes('feedback')) continue;

        if (combined.includes('send')) {
            return btn;
        }
    }
    return null;
}

// Input bar first, so a stray "Send ..." control elsewhere on the page
// (earlier in the DOM than the compose bar, where the original first-match
// search would have found it) can't be mistaken for the message Send button.
function getSendButton() {
    const bar = getInputBar();
    return (bar && findSendButtonIn(bar)) || findSendButtonIn(document);
}

// Best-effort detection of "an attachment is still uploading". We don't
// know Gemini's exact markup for this state, so this casts a fairly wide
// net - any visible progressbar/spinner/loading-labeled element - while
// explicitly excluding:
//   - buttons/controls (an earlier, broader version matched the compose
//     bar's permanent "Upload file" attach button via "upload" in its
//     aria-label, and thought an upload was in progress forever)
//   - <body>/<html> (an earlier version matched <body>'s permanent
//     "enable-lm-loading-animation" class - an app-wide UI flag, not a
//     per-upload spinner - which also never cleared)
//   - anything larger than a generous icon/badge size (real spinners are
//     small; this guards against catching broad layout wrappers by the
//     same kind of accident)
function getUploadingIndicators() {
    const candidates = document.querySelectorAll(SELECTORS.uploadIndicators);
    return Array.from(candidates).filter(el => {
        if (!isReallyVisible(el)) return false;
        if (el.tagName === 'BUTTON' || el.getAttribute('role') === 'button') return false;
        if (el.tagName === 'BODY' || el.tagName === 'HTML') return false;
        const rect = el.getBoundingClientRect();
        if (rect.width > 300 || rect.height > 300) return false;
        return true;
    });
}

function isImageUploading() {
    return getUploadingIndicators().length > 0;
}

// Polls until isImageUploading() clears, then clicks the real Send button.
// Gives up after TIMING.uploadTimeout so a stuck/failed upload doesn't leave
// this looping forever.
function waitForUploadThenSend() {
    const deadline = Date.now() + TIMING.uploadTimeout;
    let lastLogTime = 0;
    (function poll() {
        const stillUploading = isImageUploading();

        if (DEBUG && Date.now() - lastLogTime > TIMING.uploadLogInterval) {
            log(`...still waiting, ${getUploadingIndicators().length} indicator(s) present.`);
            lastLogTime = Date.now();
        }

        if (!stillUploading) {
            const sendBtn = getSendButton();
            if (sendBtn) {
                log('Upload finished - sending now.');
                sendBtn.click();
            } else {
                warn('Upload finished but no Send button found.');
            }
            return;
        }
        if (Date.now() < deadline) {
            setTimeout(poll, TIMING.uploadPollInterval);
        } else {
            warn('Gave up waiting for image upload to finish after 30s.');
        }
    })();
}

// Angular Material draws its focus ring as its own ::before pseudo-element,
// controlled by CDK-added classes (cdk-focused, cdk-program-focused, etc.),
// not the browser's native outline/:focus state - which is why blur() alone
// didn't remove it. Strip those classes directly in addition to blurring.
function suppressFocusRing(btn) {
    if (!btn) return;
    btn.blur();
    btn.classList.remove('cdk-focused', 'cdk-program-focused', 'cdk-keyboard-focused', 'cdk-mouse-focused', 'cdk-touch-focused');
}

// Snapshot of the compose box's content taken right when dictation starts,
// used by cancelDictation() (Escape) below to revert to exactly this point
// rather than wiping the whole box.
let preDictationSnapshot = null;

let pendingDictationStart = false;

// Incremented by any dictation action (start, stop-and-send, or cancel).
// cancelDictation()'s background watch (further below) captures the value
// at the moment it starts and checks it on every tick - if this counter has
// since moved on, that watcher knows it's stale and stops touching the box.
// Without this, cancelling dictation twice within the same ~15s window left
// two independent watchers correcting the box against two different
// snapshots simultaneously, corrupting the text (confirmed via diagnostics -
// duplicated snapshot text appearing) and sometimes wiping out a
// brand-new, unrelated dictation session that had nothing to do with the
// original cancel.
let dictationWatchGeneration = 0;

// Companion to dictationWatchGeneration - tracks when any dictation action
// last happened, so the speech-error listener (further up) can tell the
// difference between a genuine mid-session failure and the normal
// connection-teardown noise that happens right after WE stop dictation
// ourselves (confirmed via diagnostics: a "speech backend error" fired
// immediately after a successful Send, wiping out the just-sent message).
let lastDictationActionTime = 0;

// ------------------------------------------
// Dictation timeline
// ------------------------------------------
// A small always-on record of what happened around dictation sessions - ours
// and the page's - so "a session dropped" can be traced to a cause after the
// fact instead of guessed at. Costs nothing when unused; print it on demand
// with runDictationReport().
const dictationTimeline = [];
let wasDictating = false;
let dictationStartedByUsAt = 0; // when OUR mic hotkey started the current session; 0 = not a session of ours (or someone has since taken over)

// Does this control look like the mic / stop-dictation button? Only used to
// notice the PERSON using it (see the click listener below).
function isMicControl(btn) {
    const combined = ['aria-label', 'title', 'data-test-id'].map(a => (btn.getAttribute(a) || '').toLowerCase()).join(' ');
    if (combined.includes('generat') || combined.includes('respond') || combined.includes('response')) return false;
    return combined.includes('dictat') || combined.includes('microphone') || /\bmic\b/.test(combined) || combined.includes('listen') || combined.includes('record');
}

// The person operated dictation themselves (clicked the mic / stop button, or
// used Gemini's own shortcut). Stopping it that way makes the speech channel
// throw teardown errors - including real-looking HTTP 400s - and none of that
// may be mistaken for a failed session and "handled". So this counts as an
// action of ours for the teardown debounce, and the session stops being one
// the auto-stop is allowed to touch.
function personTouchedMic(why) {
    lastDictationActionTime = Date.now();
    dictationStartedByUsAt = 0;
    dictTrace(why);
}

function dictTrace(message) {
    dictationTimeline.push({ at: Date.now(), message });
    if (dictationTimeline.length > 80) dictationTimeline.shift();
    log('[dictation] ' + message);
}

function runDictationReport() {
    const clock = (ms) => `${new Date(ms).toLocaleTimeString([], { hour12: false })}.${String(ms % 1000).padStart(3, '0')}`;
    console.log(`[GeminiHotkeys] --- dictation timeline (last ${dictationTimeline.length} events, oldest first) ---`);
    console.log(dictationTimeline.length
        ? dictationTimeline.map(e => `  ${clock(e.at)}  ${e.message}`).join('\n')
        : '  (nothing recorded yet)');
    return dictationTimeline.slice();
}
window.runDictationReport = runDictationReport; // isolated world only - the console-callable entry point is in error-monitor.js
window.addEventListener('gemini-hotkeys:run-dictation-report', () => runDictationReport());

// The only way this extension ends dictation: click a VISIBLE stop button.
// Never the start button - when no stop button is showing, dictation isn't
// running, so a "toggle" fallback there doesn't stop anything, it STARTS a new
// session (which is exactly how dictation used to restart itself a moment
// after the person clicked stop). Returns whether a stop button was clicked.
function clickStopDictation(reason) {
    const stopBtn = getStopMicButton();
    if (stopBtn && isReallyVisible(stopBtn)) {
        stopBtn.click();
        return true;
    }
    dictTrace(`${reason}: no stop-dictation button is visible, so the mic was left alone`);
    return false;
}

function startDictation(startBtn) {
    dictationWatchGeneration++;
    lastDictationActionTime = Date.now();
    dictationStartedByUsAt = Date.now();
    dictTrace('started by the mic hotkey');
    const box = getComposeBox();
    preDictationSnapshot = box ? box.textContent : null;
    startBtn.click();
    suppressFocusRing(startBtn);
    reclaimFocus();
}

// A stopped session's final transcript chunk can keep arriving well after
// the stop click - sometimes several seconds later (see the comment on
// cancelDictation() below, where the same lag was confirmed and is the
// whole reason that function has a background watch at all). Starting a
// BRAND NEW session immediately after a stop races that late chunk against
// the new session's own text, and nothing here controls which one Gemini's
// own dictation logic ends up placing where - confirmed via a report of an
// old session's leftover text landing ahead of what was just freshly
// dictated after a quick pause/resume. So: if the mic hotkey is pressed to
// start again soon after a stop, wait for the box to actually stop changing
// on its own first (same stability check stopDictationAndSend() uses before
// sending), THEN start the new session - rather than starting immediately
// and hoping the two sessions don't collide. Only kicks in soon after a
// stop (see toggleMicrophone) so a normal, cold mic-hotkey press isn't
// delayed for no reason.
function startDictationOnceSettled(startBtn) {
    const box = getComposeBox();
    if (!box) { startDictation(startBtn); return; }

    const myGeneration = dictationWatchGeneration; // bumped by the stop that led here; a newer action (e.g. the person typing, or pressing a dictation key again) should take priority over this wait
    let lastContent = box.textContent;
    let lastChangeTime = Date.now();
    // Bounded so a box that's still changing for some unrelated reason can
    // never block the person from starting dictation indefinitely - worst
    // case, it just starts anyway once this is reached.
    const deadline = Date.now() + TIMING.dictationStableRequired * 4;
    (function waitThenStart() {
        if (myGeneration !== dictationWatchGeneration) {
            dictTrace('settle-wait before starting dictation abandoned - superseded by a newer dictation action');
            return;
        }
        const current = box.textContent;
        if (current !== lastContent) {
            lastContent = current;
            lastChangeTime = Date.now();
        }
        if (Date.now() - lastChangeTime >= TIMING.dictationStableRequired || Date.now() >= deadline) {
            startDictation(startBtn);
            return;
        }
        setTimeout(waitThenStart, TIMING.dictationStablePollInterval);
    })();
}

function toggleMicrophone() {
    const { startBtn, stopBtn } = getMicButtons();
    if (stopBtn) {
        dictationWatchGeneration++;
        lastDictationActionTime = Date.now();
        dictationStartedByUsAt = 0;
        dictTrace('stopped by the mic hotkey');
        stopBtn.click();
        suppressFocusRing(stopBtn);
        log('Stopped microphone.');
        reclaimFocus();
        return;
    }
    if (startBtn) {
        const sinceLastAction = Date.now() - lastDictationActionTime;
        if (lastDictationActionTime && sinceLastAction < TIMING.dictationTeardownGrace) {
            dictTrace(`resuming only ${sinceLastAction}ms after the last dictation action - waiting for the box to settle before starting, in case the previous session's transcript is still landing`);
            startDictationOnceSettled(startBtn);
        } else {
            startDictation(startBtn);
        }
        log('Started microphone.');
        return;
    }

    // Mic button isn't in the DOM yet - most likely F1 was pressed before
    // the page finished loading. Queue it and poll for the button to
    // appear, instead of silently doing nothing.
    if (pendingDictationStart) {
        log('Already waiting for the page to finish loading before starting dictation.');
        return;
    }
    pendingDictationStart = true;
    log('Mic button not found yet (page still loading?) - will start dictation as soon as it appears.');
    const deadline = Date.now() + TIMING.micReadyTimeout;
    (function waitForMic() {
        const ready = getMicButtons();
        if (ready.startBtn) {
            pendingDictationStart = false;
            log('Mic button now available - starting dictation.');
            startDictation(ready.startBtn);
            return;
        }
        if (Date.now() < deadline) return setTimeout(waitForMic, TIMING.micReadyPollInterval);
        pendingDictationStart = false;
        warn('Mic button never appeared within 10s - could not start dictation.');
    })();
}

// "Is the person dictating right now?" - decided ONLY by a visible
// stop-dictation button, the real control itself. Everything that acts on this
// answer (hijacking Space/Enter/Escape, auto-stop) needs that button anyway,
// since stopping means clicking it. An earlier version also accepted loose
// hints (a listening-ish placeholder, "recording"-style class names); those
// linger for a moment after dictation ends, which made Space/Enter get
// hijacked right after the person stopped, and - together with a start-button
// fallback - made dictation restart itself. The hints are still gathered for
// runHealthCheck(), but never acted on.
function isDictationActive() {
    const stopBtn = getStopMicButton();
    return !!(stopBtn && isReallyVisible(stopBtn));
}

// Report-only: the loose hints described above.
function getDictationSignals() {
    let weak = false;
    const box = getComposeBox();
    if (box && (box.getAttribute('data-placeholder') || '').toLowerCase().includes('listen')) {
        weak = true;
    } else {
        const root = getInputBar() || document; // whole page only when the bar can't be located
        const indicators = root.querySelectorAll('[aria-label*="listening" i], [class*="listening" i], [class*="recording" i]');
        for (const ind of indicators) {
            if (isReallyVisible(ind)) { weak = true; break; }
        }
    }
    return { strong: isDictationActive(), weak };
}

// Fallback only - used when getSendButton() can't find a real button to
// click. See the comment at its call site for why this is a last resort.
function fireEnterKey(el) {
    const opts = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true, composed: true };
    el.dispatchEvent(new KeyboardEvent('keydown', opts));
    el.dispatchEvent(new KeyboardEvent('keypress', opts));
    el.dispatchEvent(new KeyboardEvent('keyup', opts));
}

function findModelDropdownTrigger() {
    const known = getVisibleModeMenuTrigger();
    if (known) return known;

    // Fallback heuristic if the known selectors above stop matching: score
    // visible buttons/comboboxes that mention a model name and prefer ones
    // that look like menu triggers (aria-haspopup, "model" in their label).
    const candidates = Array.from(document.querySelectorAll('button, div[role="button"], div[role="combobox"]'))
        .filter(el => {
            const rect = el.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
        });

    let best = null;
    let bestScore = -Infinity;

    for (const el of candidates) {
        const text = el.textContent.trim();
        const ariaLabel = el.getAttribute('aria-label') || '';
        const hasPopup = el.getAttribute('aria-haspopup');
        const combined = (text + ' ' + ariaLabel).toLowerCase();

        const mentionsModel = /\bpro\b|\badvanced\b|\bflash\b|\blite\b|\bmodel\b/.test(combined);
        if (!mentionsModel) continue;

        let score = 0;
        if (hasPopup) score += 10;
        if (ariaLabel.toLowerCase().includes('model')) score += 5;
        score -= text.length * 0.1;

        if (score > bestScore) {
            bestScore = score;
            best = el;
        }
    }
    return best;
}

// Confirmed live menu structure (Aug 2026): each option is a <gem-menu-item>
// containing a <span class="label"> with text like "3.5 Flash-Lite",
// "3.6 Flash", "3.1 Pro", plus "Extended thinking". Version number prefixes
// can change over time, so we match by substring rather than exact text -
// that keeps this working across version bumps without edits here.
//
// Menu panes are located by diffing SELECTORS.overlayPane elements' VISIBILITY
// before vs. after the click (which ones were already visible vs. which one
// just became visible), rather than searching by ARIA role/class or by node
// identity. Gemini leaves CLOSED menus sitting in the DOM (hidden, not
// removed) - a role/class-based scan can grab stale content from an
// unrelated leftover menu instead of the one just opened, so this only ever
// looks at whatever pane became visible as a direct result of this click.
// Diffing by node identity alone (an earlier version of this) isn't enough:
// confirmed as the cause of the wide-monitor model-switch bug, where Gemini
// reuses an existing hidden pane node for the mode menu instead of creating
// a new one, so "is this element new?" said no even though a pane had, in
// every way that matters, just opened. If this ever needs re-diagnosing:
// temporarily set DEBUG = true and press the relevant key - the "no match"
// warning below lists every option's text as seen at that moment.

// Mutex + single-slot queue around the real worker (selectModelNow, right
// below). Confirmed via a captured console trace (DEBUG=true) that two
// hotkey presses landing close together - a genuine quick double-tap, or
// plain OS key-repeat firing while a key is held a little long, neither of
// which this file ever filtered out - launch two selectModelNow() calls
// that overlap in time. Both read/click the very same trigger and race the
// same menu: one call's click() can close the menu (or re-open it) right
// as the other is mid-poll for the pane or mid-search for the matching
// option, so that call silently times out ("No menu pane appeared") while
// the other succeeds. That was the original "sometimes takes two taps"
// bug - a re-entrancy problem, not a wrong-trigger one.
//
// This is now built around a single source of truth, desiredModelNames:
// whatever the user asked for MOST RECENTLY, full stop. selectModel()
// always overwrites it and, if nothing is running, kicks off
// runDesiredModel(). Every time an attempt finishes - success, failure, or
// superseded mid-wait - runDesiredModel() checks desiredModelNames again
// and, unless the attempt both succeeded AND nothing newer arrived while
// it ran, goes again for whatever is CURRENTLY desired. That covers three
// cases with one mechanism: a newer press superseding an in-flight one
// (the old queuedModelSwitch behavior), a burst of repeats collapsing down
// to just the last one, AND - new - an attempt that ran cleanly but still
// failed (e.g. Gemini silently ignored the open-click even after this
// file's own internal click-retry) automatically trying again rather than
// silently dropping the press. modelSwitchMaxRetries bounds the
// failure-retry case so a permanently broken page can't loop forever.
let desiredModelNames = null;
let desiredModelOpts = {};
let modelSwitchBusy = false;
// Bumped on every selectModel() call. selectModelNow's wait loop compares
// the generation it was started with against this - if they no longer
// match, a newer request has arrived and it stops waiting immediately
// instead of running out its full menuPaneTimeout. Without this,
// double-tapping (or plain OS key-repeat) made the SECOND tap sit behind
// the first for the full timeout whenever the first got stuck - visible
// as a multi-second freeze.
let modelSwitchGeneration = 0;
let modelSwitchRetries = 0; // consecutive FAILED attempts against the current desiredModelNames; reset whenever the desired target actually changes

function selectModel(modelNames, opts = {}) {
    const isNewTarget = desiredModelNames !== modelNames;
    if (isNewTarget) modelSwitchRetries = 0;
    desiredModelNames = modelNames;
    desiredModelOpts = opts;
    if (modelSwitchBusy) {
        if (isNewTarget) {
            // Genuinely different target - the in-flight attempt is now
            // stale, so bump generation to make it stop waiting and hand
            // off to this one once it's done settling.
            modelSwitchGeneration++;
            if (DEBUG) log(`selectModel("${modelNames[0]}") noted as the target - a switch is already in progress and will pick this up once it's free (it will stop waiting now rather than run out its timeout).`);
        } else if (DEBUG) {
            // Same key re-pressed while its own attempt is still working
            // (very natural to do while waiting - see menuOpenRetryInterval
            // above). Deliberately NOT bumping generation here: doing so
            // would abort and restart an attempt that might be about to
            // succeed on its own, compounding the wait instead of just
            // letting it finish. Confirmed via a captured trace where
            // exactly this re-press turned one already-in-progress switch
            // into "superseded mid-wait" -> a full extra retry cycle.
            log(`selectModel("${modelNames[0]}") re-pressed while already the target - letting the in-flight attempt continue rather than restarting it.`);
        }
        return;
    }
    modelSwitchGeneration++;
    runDesiredModel();
}

function runDesiredModel() {
    if (!desiredModelNames) return;
    const modelNames = desiredModelNames;
    const opts = desiredModelOpts;
    const myGeneration = modelSwitchGeneration;
    modelSwitchBusy = true;
    const userOnDone = opts.onDone;
    selectModelNow(modelNames, Object.assign({}, opts, {
        generation: myGeneration,
        onDone: (ok, meta) => {
            if (userOnDone) userOnDone(ok);

            const proceed = () => {
                modelSwitchBusy = false;
                const stillWanted = desiredModelNames === modelNames;

                if (ok && stillWanted) {
                    // Fully settled: succeeded, and nothing asked for
                    // anything different while it ran.
                    desiredModelNames = null;
                    modelSwitchRetries = 0;
                    return;
                }
                if (!stillWanted) {
                    // A newer press arrived (whether this attempt
                    // succeeded or not doesn't matter - something else is
                    // wanted now). Fresh target, so a fresh retry budget.
                    modelSwitchRetries = 0;
                    runDesiredModel();
                    return;
                }
                if (meta && meta.permanent) {
                    // The option was found but is genuinely unavailable
                    // (grayed out - no access on this account/session) -
                    // that won't change between attempts, so retrying would
                    // only reopen and close the menu up to
                    // modelSwitchMaxRetries more times for no benefit.
                    // Confirmed via a report of the mode-picker visibly
                    // flashing repeatedly right after page load: an
                    // unavailable defaultHomeModel was correctly refused
                    // each time, but kept being retried anyway.
                    warn(`Giving up on switching to "${modelNames[0]}" - it's unavailable (grayed out), so retrying won't help.`);
                    desiredModelNames = null;
                    modelSwitchRetries = 0;
                    return;
                }
                // Failed, and nothing newer has come in - this is the
                // still-most-recent press, so retry it rather than
                // silently giving up on it.
                modelSwitchRetries++;
                if (modelSwitchRetries > TIMING.modelSwitchMaxRetries) {
                    warn(`Giving up on switching to "${modelNames[0]}" after ${modelSwitchRetries} failed attempts.`);
                    desiredModelNames = null;
                    modelSwitchRetries = 0;
                    return;
                }
                if (DEBUG) log(`selectModel("${modelNames[0]}") failed - retrying (attempt ${modelSwitchRetries}/${TIMING.modelSwitchMaxRetries}).`);
                runDesiredModel();
            };

            if (meta && meta.justClicked) {
                // This attempt just performed a click that closes the menu
                // (a successful option click, or the "no match" cleanup
                // click) - Gemini's own close animation can still be
                // playing for a beat afterward. Holding the mutex through
                // TIMING.modelSwitchSettleDelay, rather than proceeding
                // immediately, matters for more than whatever's already
                // pending: it also catches a FRESH press that lands in
                // that same window, before the animation has actually
                // finished even though aria-expanded has already flipped
                // back to false. Proceeding immediately let a fresh press
                // like that slip through the mutex entirely and click too
                // soon, which Gemini's UI then silently ignored -
                // confirmed via a solitary, non-superseded attempt that
                // still got "No menu pane appeared" despite everything
                // about the trigger looking perfectly normal.
                setTimeout(proceed, TIMING.modelSwitchSettleDelay);
            } else {
                // No closing click happened (trigger not found, superseded
                // mid-wait, or the pane never appeared at all), so there's
                // no animation to wait out - but still hop through a
                // macrotask rather than recursing synchronously, so a run
                // of instant failures (e.g. a permanently missing trigger)
                // can never build up the call stack.
                setTimeout(proceed, 0);
            }
        }
    }));
}

// True if `text` (should already be lowercased) refers to the model
// named by any of modelNames' aliases - case-insensitive, whole-word, so
// "Pro" doesn't match "Provide feedback" or "Improved". Excludes an
// unqualified "Flash" match against Flash Lite/8B text: that's a
// cheaper, different model that happens to share the word "Flash", not a
// match for plain Flash. Shared between the "already on this model, skip
// the click entirely" check below and the menu-option matching loop
// further down, so the two can never disagree about what counts as a
// match for a given model.
// --- Model-switch timing (runTimingReport() / window.runTimingReport) ---
// A rolling history of every selectModelNow() attempt this session, so
// menuOpenRetryInterval/menuPaneTimeout/modelSwitchSettleDelay can be tuned
// against real observed numbers instead of eyeballing millisecond gaps
// between console timestamps by hand. Capped so a long session doesn't
// grow this unbounded.
const modelSwitchTimings = [];
const MODEL_SWITCH_TIMINGS_CAP = 300;

function recordModelSwitchTiming(entry) {
    entry.at = Date.now();
    modelSwitchTimings.push(entry);
    if (modelSwitchTimings.length > MODEL_SWITCH_TIMINGS_CAP) modelSwitchTimings.shift();

    if (DEBUG) {
        const parts = [`total=${entry.totalMs.toFixed(0)}ms`];
        if (entry.skippedAlreadyOnModel) {
            parts.push('already-on-model (no click)');
        } else if (entry.clickToPaneMs === null) {
            parts.push('menu-already-open (no click)');
        } else {
            parts.push(`click-to-pane=${entry.clickToPaneMs.toFixed(0)}ms`);
            if (entry.openClickCount > 1) parts.push(`${entry.openClickCount} open-clicks`);
        }
        if (!entry.ok) parts.push('FAILED');
        log(`selectModel("${entry.model}") timing: ${parts.join(', ')}`);
    }
}

function percentileOf(sortedNums, p) {
    if (!sortedNums.length) return null;
    return sortedNums[Math.min(sortedNums.length - 1, Math.floor((p / 100) * sortedNums.length))];
}

// Prints a summary of everything recorded so far and returns the raw data
// (e.g. run `runTimingReport().filter(e => e.clickToPaneMs > 500)` to dig
// into just the slow ones). "click-to-pane" is specifically Gemini's own
// response time to our click - the number that matters for tuning
// menuOpenRetryInterval/menuPaneTimeout - separated from the "total" time
// (press to picker fully updated), which also includes this file's own
// (normally negligible) processing and any settle/queue waiting.
function runTimingReport() {
    const n = modelSwitchTimings.length;
    console.log(`[GeminiHotkeys] --- model-switch timing report (last ${n} attempt(s)) ---`);
    if (!n) {
        console.log('  (nothing recorded yet - switch models a few times, then run this again)');
        return [];
    }

    const clickToPane = modelSwitchTimings.map(e => e.clickToPaneMs).filter(ms => ms !== null).sort((a, b) => a - b);
    const totals = modelSwitchTimings.map(e => e.totalMs).sort((a, b) => a - b);
    const skipped = modelSwitchTimings.filter(e => e.skippedAlreadyOnModel).length;
    const menuAlreadyOpen = modelSwitchTimings.filter(e => !e.skippedAlreadyOnModel && e.clickToPaneMs === null).length;
    const multiClick = modelSwitchTimings.filter(e => e.openClickCount > 1).length;
    const failed = modelSwitchTimings.filter(e => !e.ok).length;
    const fmt = (ms) => ms === null ? 'n/a' : `${ms.toFixed(0)}ms`;

    console.log(`  ${n} attempt(s): ${failed} failed, ${skipped} skipped (already on model), ${menuAlreadyOpen} skipped (menu already open), ${multiClick} needed 2+ open-clicks`);
    console.log(`  click-to-pane (Gemini's own response time), n=${clickToPane.length}: ` +
        `min=${fmt(clickToPane[0] ?? null)}  p50=${fmt(percentileOf(clickToPane, 50))}  p90=${fmt(percentileOf(clickToPane, 90))}  max=${fmt(clickToPane[clickToPane.length - 1] ?? null)}`);
    console.log(`  total (press to picker updated), n=${totals.length}: ` +
        `min=${fmt(totals[0] ?? null)}  p50=${fmt(percentileOf(totals, 50))}  p90=${fmt(percentileOf(totals, 90))}  max=${fmt(totals[totals.length - 1] ?? null)}`);
    return modelSwitchTimings.slice();
}
window.runTimingReport = runTimingReport; // isolated world only - the console-callable entry point is in error-monitor.js
window.addEventListener('gemini-hotkeys:run-timing-report', () => runTimingReport());

function textNamesModel(text, modelNames) {
    if (modelNames.includes('Flash') && (text.includes('lite') || text.includes('8b'))) return false;
    const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return modelNames.some(n => new RegExp(`\\b${escapeRegExp(n.toLowerCase())}\\b`).test(text));
}

function selectModelNow(modelNames, { silent = false, onDone = null, generation = null } = {}) {
    // --- Timing instrumentation, see runTimingReport()/window.runTimingReport ---
    // performance.now(): sub-millisecond and monotonic, unlike Date.now()
    // (~1ms resolution, can jump with clock adjustments) - appropriate for
    // measuring short intervals rather than wall-clock time.
    const tStart = performance.now();
    let tFirstClick = null;  // when we first clicked to OPEN the menu (null if never needed to)
    let tPaneFound = null;   // when a pane was first detected as newly visible
    let openClickCount = 0;  // how many times we clicked specifically to open (initial + retries) - NOT the eventual option click or a close click
    // -----------------------------------------------------------------------------

    // onDone(true) once the option has been clicked, onDone(false) if it
    // couldn't be (no trigger, no pane, no usable match). applyModelDefault
    // uses it to know when it's safe to resume recording the picker's state.
    const finish = (ok, meta) => {
        recordModelSwitchTiming({
            model: modelNames[0],
            ok,
            skippedAlreadyOnModel: !!(meta && meta.skippedAlreadyOnModel),
            openClickCount,
            totalMs: performance.now() - tStart,
            clickToPaneMs: (tFirstClick !== null && tPaneFound !== null) ? (tPaneFound - tFirstClick) : null,
        });
        if (onDone) onDone(ok, meta);
    };

    const dropdownTrigger = findModelDropdownTrigger();
    if (!dropdownTrigger) {
        warn('Model dropdown trigger not found.');
        finish(false);
        return;
    }

    // Captured before opening, so we know which option is already active
    // (and therefore safe/available) once the menu opens - used below to
    // detect restricted options by color rather than a disabled attribute.
    const triggerLabel = dropdownTrigger.getAttribute('aria-label') || dropdownTrigger.textContent || '';
    const currentModelMatch = triggerLabel.match(/currently\s+(.+)$/i);
    const currentModelText = currentModelMatch ? currentModelMatch[1].trim().toLowerCase() : '';

    // TEMP diagnostic (see DEBUG flag comment at the top of the file):
    // dumps exactly which trigger got picked and its on-screen state, so a
    // failing tap can be compared against the very next, successful one -
    // same node or a different one, correct aria-expanded or stale, etc.
    if (DEBUG) {
        const r = dropdownTrigger.getBoundingClientRect();
        log(`selectModel("${modelNames[0]}"): trigger=<${dropdownTrigger.tagName.toLowerCase()}> ` +
            `aria-label=${JSON.stringify(dropdownTrigger.getAttribute('aria-label'))} ` +
            `data-test-id=${JSON.stringify(dropdownTrigger.getAttribute('data-test-id'))} ` +
            `rect={x:${r.x.toFixed(0)},y:${r.y.toFixed(0)},w:${r.width.toFixed(0)},h:${r.height.toFixed(0)}} ` +
            `aria-expanded=${dropdownTrigger.getAttribute('aria-expanded')} ` +
            `currentModelText=${JSON.stringify(currentModelText)}`);
    }

    // Already on the requested model - skip the whole open-menu-and-click
    // cycle entirely instead of performing a no-op switch. This was
    // confirmed to be more than a minor saving: across many captured
    // traces, the single flakiest moment was consistently the very first
    // click right after page load, from applyModelDefault's "switch to my
    // preferred model" call - which very often finds the picker already
    // showing it (Gemini remembers the last model itself), yet was still
    // clicking through a full open/select/close cycle at exactly the
    // moment other scripts are still initializing and a click is most
    // likely to get dropped. Skipping the click here removes that
    // failure class at its source rather than just recovering from it
    // faster. Extended Thinking is unaffected: it's a checkbox toggle,
    // never reflected in the trigger's own "currently X" label, so
    // currentModelText can never match its aliases and this never fires
    // for it - every press still toggles it, as intended.
    if (currentModelText && textNamesModel(currentModelText, modelNames)) {
        if (DEBUG) log(`selectModel("${modelNames[0]}"): already on this model (picker shows "${currentModelText}") - nothing to click.`);
        finish(true, { skippedAlreadyOnModel: true });
        return;
    }

    // For silent mode: inject the off-screen rule BEFORE clicking, so the
    // pane is already positioned off-screen from its very first paint frame.
    // Repositioning reactively (after detecting the pane via polling) was
    // too late - the menu's open animation/transition already renders
    // on-screen in the time it takes our poll interval to catch it.
    // Uses off-screen positioning rather than visibility/opacity, since
    // isReallyVisible() (used just below to find the pane and match options)
    // checks both of those and would otherwise treat everything inside as
    // invisible and break its own matching.
    let silentStyleEl = null;
    if (silent) {
        silentStyleEl = document.createElement('style');
        silentStyleEl.textContent = `${SELECTORS.overlayPane} { position: fixed !important; left: -9999px !important; top: -9999px !important; }`;
        (document.head || document.documentElement).appendChild(silentStyleEl);
    }
    const cleanupSilentStyle = () => {
        if (silentStyleEl) silentStyleEl.remove();
    };

    // Only click to open if it isn't already open, so we don't
    // accidentally toggle it closed.
    const wasAlreadyOpen = dropdownTrigger.getAttribute('aria-expanded') === 'true';
    // Deliberately only the VISIBLE panes, not every .cdk-overlay-pane node -
    // confirmed as the wide-monitor model-switch bug: on that layout Gemini
    // appears to REUSE an existing (already-in-DOM, hidden) overlay pane
    // node for the mode menu rather than creating a fresh one each time it
    // opens. A node-identity diff ("is this element new?") can never catch
    // that - the element was already sitting in panesBefore, just hidden -
    // so the click looked like it opened nothing. Diffing on VISIBILITY
    // instead ("did this element just become visible?") catches both cases:
    // a brand-new pane (wasn't in the DOM at all before) and a reused one
    // (was in the DOM but hidden before). A stale CLOSED leftover menu still
    // can't be mistaken for the new pane either way, since a closed menu is
    // hidden and so was never counted as "before" in the first place.
    // When the menu was already open (most often: this is the retry right
    // after an earlier attempt got superseded mid-wait and left it open,
    // see modelSwitchGeneration above), there is nothing to click and
    // nothing to wait for - the pane we want is already sitting there,
    // fully rendered. Treating panesBefore as empty in that case makes the
    // very first (synchronous) check in waitForNewPane below immediately
    // count that already-visible pane as "new", resolving with no poll
    // delay at all instead of needlessly running the wait loop.
    const panesBefore = wasAlreadyOpen
        ? new Set()
        : new Set(Array.from(document.querySelectorAll(SELECTORS.overlayPane)).filter(isReallyVisible));

    // Tracks the last time WE clicked to open, so the wait loop below can
    // retry it (see TIMING.menuOpenRetryInterval) rather than sitting out
    // the full timeout on a click Gemini's UI may have silently ignored.
    let lastOpenClickTime = Date.now();
    if (!wasAlreadyOpen) {
        dropdownTrigger.click();
        tFirstClick = performance.now();
        openClickCount++;
    }

    const deadline = Date.now() + TIMING.menuPaneTimeout;
    (function waitForNewPane() {
        // A newer selectModel() call means the user has since pressed again
        // (a double-tap, or OS key-repeat) - stop waiting on this one right
        // away rather than riding out the full timeout with the next press
        // queued behind it. See modelSwitchGeneration above selectModel().
        if (generation !== null && generation !== modelSwitchGeneration) {
            if (DEBUG) log(`selectModel("${modelNames[0]}") superseded mid-wait - stopping early instead of riding out the timeout.`);
            cleanupSilentStyle();
            finish(false);
            return;
        }

        const panesNow = Array.from(document.querySelectorAll(SELECTORS.overlayPane));
        const newPane = panesNow.find(p => !panesBefore.has(p) && isReallyVisible(p));

        if (!newPane) {
            if (Date.now() < deadline) {
                // Confirmed via a captured trace: a single open-click can be
                // silently ignored by Gemini's UI with otherwise completely
                // normal preconditions (correct trigger, aria-expanded
                // correctly false, not superseded, not racing anything) -
                // the result was ZERO overlay panes in the DOM at all, not
                // just zero visible ones, meaning Gemini never even started
                // building the menu. Only retried when WE were the one
                // supposed to open it (never when wasAlreadyOpen, to avoid
                // toggling shut a menu that might genuinely be open but not
                // yet detected) and only when there are truly zero panes
                // (not "some exist but none are new/visible yet", which is
                // a normal mid-open-animation state, not a stuck one).
                if (!wasAlreadyOpen && panesNow.length === 0 && Date.now() - lastOpenClickTime >= TIMING.menuOpenRetryInterval) {
                    if (DEBUG) log(`selectModel("${modelNames[0]}"): still zero overlay panes ${TIMING.menuOpenRetryInterval}ms after the last click - retrying the click.`);
                    dropdownTrigger.click();
                    lastOpenClickTime = Date.now();
                    openClickCount++;
                }
                return setTimeout(waitForNewPane, TIMING.menuPanePollInterval);
            }
            // Diagnostic detail on purpose: if this still fires after the
            // visibility-diff fix above, the count here tells us which case
            // we're actually in - 0 total means the selector itself doesn't
            // match anything on this layout; a nonzero total with 0 newly
            // visible means something is suppressing visibility instead.
            warn(`No menu pane appeared for "${modelNames[0]}". ${panesNow.length} "${SELECTORS.overlayPane}" element(s) in the DOM total, ${panesNow.filter(isReallyVisible).length} of them visible right now.`);
            cleanupSilentStyle();
            finish(false);
            return;
        }

        tPaneFound = performance.now();

        const candidates = Array.from(newPane.querySelectorAll('*'))
            .filter(el => isReallyVisible(el) && el.children.length === 0 && el.textContent.trim().length > 0);

        // Perceived brightness of an element's text color (0 = black, 1 =
        // white). Used to compare candidates against the known-active one,
        // since restricted options here turned out to be styled as plain
        // gray text - clickable, not disabled/aria-disabled - rather than
        // using any semantic disabled marker. A real disabled/aria-disabled
        // check is kept too, in case a future version does mark it properly.
        const textLuminance = (el) => {
            const match = getComputedStyle(el).color.match(/rgba?\(([^)]+)\)/);
            if (!match) return null;
            const [r, g, b] = match[1].split(',').map(s => parseFloat(s.trim()));
            return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
        };
        const isDisabled = (el) => el.disabled || el.getAttribute('aria-disabled') === 'true' || el.classList.contains('disabled');

        // A leaf's own text might not say "sign in" (e.g. a sub-line like
        // "Try the latest Flash" sitting under a "Sign in for all models"
        // heading), but its containing block does - walk up a few levels
        // to catch that, so a promo line mentioning a model name by
        // coincidence can't get treated as a real, clickable option.
        const isPartOfSignInPrompt = (el) => {
            let node = el;
            for (let hops = 0; hops < 4 && node; hops++) {
                if (node.textContent && node.textContent.toLowerCase().includes('sign in')) return true;
                node = node.parentElement;
            }
            return false;
        };

        // The trigger's label ("...currently Gemini Flash") and the menu's own
        // option text needn't be worded identically - one can carry a version
        // number or a "Gemini" prefix the other lacks. The original lookup only
        // accepted "option text contains the label", which finds nothing when
        // the label is the longer of the two, and then the gray-out protection
        // below silently switches itself off. So: exact match first, then the
        // original rule, then "the label contains the option text" (most
        // specific option wins) as a last resort.
        const findActiveCandidate = () => {
            if (!currentModelText) return null;
            const texts = candidates.map(c => c.textContent.trim().toLowerCase());
            let i = texts.indexOf(currentModelText);
            if (i === -1) i = texts.findIndex(x => x.includes(currentModelText));
            if (i === -1) {
                let bestLen = 2; // ignore tiny leaves (badges, icons' text)
                texts.forEach((x, idx) => {
                    if (x.length > bestLen && currentModelText.includes(x)) { i = idx; bestLen = x.length; }
                });
            }
            return i === -1 ? null : candidates[i];
        };
        const activeCandidate = findActiveCandidate();
        if (currentModelText && !activeCandidate) {
            log(`could not identify the active option ("${currentModelText}") among the menu items - gray-out detection is off for this switch.`);
        }
        const activeLuminance = activeCandidate ? textLuminance(activeCandidate) : null;

        // Whole-word matching: a bare substring test lets "Pro" match "Provide
        // feedback" or "Improved", and a promo row like "Upgrade to Google AI
        // Pro" mentions a model by name without being one. Promo wording is
        // checked on the row's OWN text only (not its ancestors, as the sign-in
        // check above does) so a single upsell footer can't disqualify every
        // real option.
        const promoWording = /\b(upgrade|subscribe|learn more|try)\b/;

        // Options that pass every check; one is chosen after the loop.
        const eligible = [];
        // Set when a candidate matched by name but was skipped as
        // disabled/grayed out - see the "permanent" no-match handling
        // below, which stops runDesiredModel() from retrying in that case.
        let foundDisabled = false;

        for (const el of candidates) {
            if (isPartOfSignInPrompt(el)) continue;

            const text = el.textContent.toLowerCase();
            if (!textNamesModel(text, modelNames)) continue;
            if (promoWording.test(text)) continue;

            // Walk up from the matched text node to whatever ancestor is
            // actually clickable, since the text usually lives in an inner
            // <span>/<div>, not the menu item itself. Also check for a
            // disabled state along the way - an account without access to
            // a given model (e.g. no paid Pro/Advanced subscription) is
            // likely to see it listed but disabled rather than hidden
            // entirely, and clicking a disabled option shouldn't count as
            // a successful switch.
            let clickTarget = el;
            let disabled = isDisabled(el);
            for (let hops = 0; hops < 5 && clickTarget; hops++) {
                const role = clickTarget.getAttribute && clickTarget.getAttribute('role');
                if (isDisabled(clickTarget)) disabled = true;
                if (clickTarget.tagName === 'BUTTON' || role === 'menuitem' || role === 'menuitemradio' || role === 'option' || clickTarget.onclick) {
                    break;
                }
                clickTarget = clickTarget.parentElement;
            }

            // Restricted options (no access to that model) appear to just
            // use plain lighter-gray text rather than a real disabled
            // attribute - compare against the active option's color as a
            // reference rather than guessing at an absolute threshold,
            // since exact colors could change with a future theme update.
            if (!disabled && activeLuminance !== null) {
                const candidateLuminance = textLuminance(el);
                if (candidateLuminance !== null && candidateLuminance - activeLuminance > 0.15) {
                    disabled = true;
                }
            }

            if (disabled) {
                log(`"${modelNames[0]}" appears unavailable (disabled or grayed out relative to the active option) - not switching, to avoid triggering an unwanted sign-in/upgrade redirect.`);
                foundDisabled = true;
                continue;
            }

            eligible.push({ el, clickTarget });
        }

        if (eligible.length) {
            // More than one option can match a name - e.g. a variant such as
            // "3.1 Pro Deep Think" listed ahead of the plain "3.1 Pro". Take the
            // shortest label (the undecorated model); the sort is stable, so ties
            // keep DOM order. With a single match - the normal case - this changes
            // nothing.
            eligible.sort((a, b) => a.el.textContent.trim().length - b.el.textContent.trim().length);
            if (eligible.length > 1) {
                log(`${eligible.length} options match "${modelNames[0]}" (${eligible.map(x => JSON.stringify(x.el.textContent.trim())).join(', ')}) - taking the shortest.`);
            }
            const { el, clickTarget } = eligible[0];
            (clickTarget || el).click();
            log(`switched to ${modelNames[0]}`);
            cleanupSilentStyle();
            // Clicking the menu item pulls focus onto the menu; once it
            // closes, focus doesn't automatically return to the compose
            // box, which left Enter not registering as "send" until the
            // person clicked back into the textbox themselves.
            reclaimFocus();
            finish(true, { justClicked: true });
            // Pick up the change just made (hotkey switches included)
            // without waiting for the next poll tick.
            setTimeout(() => recordModelIfChanged('model switch'), TIMING.modelRecheckAfterClick);
            return;
        }

        warn(`no match for "${modelNames[0]}" among menu options:`,
            candidates.map(el => el.textContent.trim()).filter(Boolean));
        dropdownTrigger.click();
        cleanupSilentStyle();
        reclaimFocus();
        // permanent: true when the option was actually found but grayed
        // out/disabled (e.g. no access to that model on this account) -
        // that reason won't change on a retry, unlike a menu that simply
        // didn't render in time. Confirmed via a report of the mode-picker
        // visibly flashing open/closed repeatedly right after page load:
        // an unavailable defaultHomeModel was correctly refused each time,
        // but runDesiredModel() kept retrying it up to modelSwitchMaxRetries
        // anyway, each retry opening and closing the menu again for no
        // possible benefit.
        finish(false, { justClicked: true, permanent: foundDisabled });
    })();
}

// ==========================================
// SELF-DIAGNOSTICS
// ==========================================
// Everything above finds Gemini's UI by aria-labels, roles and class-name
// fragments, which can drift whenever Gemini ships an update. With DEBUG off
// that breakage would otherwise be silent until the moment a hotkey is
// pressed, so this checks that the pieces we depend on can still be found:
// automatically once shortly after load (warning only if something's wrong),
// and on demand from the console with runHealthCheck().

function describeElement(el) {
    if (!el) return 'none';
    const cls = (el.getAttribute('class') || '').split(/\s+/).filter(Boolean).slice(0, 2).join('.');
    return `<${el.tagName.toLowerCase()}${cls ? '.' + cls : ''}>`;
}

// Rows of { check, status, detail }. status: 'ok'; 'info' (worth knowing,
// not a problem); 'WARN' (degraded but working); 'FAIL' (a feature is
// broken).
function collectHealth() {
    const rows = [];
    const add = (check, status, detail) => rows.push({ check, status, detail });

    let alive = true;
    try { alive = !!(chrome.runtime && chrome.runtime.id); } catch (err) { alive = false; }
    if (!alive) add('extension context', 'FAIL', 'invalidated - the extension was reloaded or updated after this tab loaded; refresh the page');

    const boxes = document.querySelectorAll(SELECTORS.composeBox);
    const box = getComposeBox();
    if (box && isReallyVisible(box)) {
        add('compose box', 'ok', `${describeElement(box)} (${boxes.length} candidate${boxes.length === 1 ? '' : 's'})`);
    } else {
        add('compose box', 'FAIL', `no visible match for "${SELECTORS.composeBox}" - focus handling, dictation and send will not work`);
    }

    const allTriggerMatches = document.querySelectorAll(SELECTORS.modeMenuTrigger);
    const trigger = getVisibleModeMenuTrigger();
    if (trigger && isReallyVisible(trigger)) {
        const matchedBy = SELECTORS.modeMenuTrigger.split(/,\s*/).find(sel => trigger.matches(sel));
        // More than one match is expected and fine (a hidden duplicate for
        // another layout) as long as the VISIBLE one is the one being used -
        // noted here mainly so it's visible in the report if that ever stops
        // being true.
        const note = allTriggerMatches.length > 1 ? ` (${allTriggerMatches.length} elements match in total; the rest are hidden)` : '';
        add('mode picker', 'ok', `matched ${matchedBy}${note}`);
        const key = getCurrentModelKey();
        if (key) add('current model', 'ok', `reads as "${key}"`);
        else add('current model', 'WARN', 'the picker\'s label doesn\'t map to a known model - "Same model as previous chat" can\'t track changes');
    } else if (findModelDropdownTrigger()) {
        add('mode picker', 'WARN', 'none of SELECTORS.modeMenuTrigger match a VISIBLE element - only the fuzzy fallback finds it (still working, but the selector needs updating)');
    } else {
        add('mode picker', 'FAIL', 'not found - model hotkeys and defaults will not work');
    }

    const { startBtn, stopBtn } = getMicButtons();
    const mic = stopBtn || startBtn;
    if (mic) add('mic button', 'ok', `${stopBtn ? 'stop' : 'start'}: aria-label="${mic.getAttribute('aria-label') || ''}"`);
    else add('mic button', 'FAIL', 'no start or stop button found - the mic hotkey will not work');

    // Informational only: Send is often absent or disabled while the box is empty.
    const sendBtn = getSendButton();
    add('send button', 'info', sendBtn ? `aria-label="${sendBtn.getAttribute('aria-label') || ''}"` : 'none enabled right now (normal while the box is empty)');

    const bar = getInputBar();
    add('input bar', 'info', bar ? describeElement(bar) : 'not located - mic/send lookups fall back to searching the whole page');

    const { strong, weak } = getDictationSignals();
    if (strong) add('dictation state', 'info', 'a stop-dictation button is visible - dictation looks active right now');
    else if (weak) add('dictation state', 'info', 'loose page hints suggest dictation but no stop-dictation button is visible - ignored: only that button is trusted');
    else add('dictation state', 'ok', 'reads "not dictating" (expected at rest)');

    add('navigation detection', 'info', window.navigation ? 'Navigation API available' : 'Navigation API unavailable - relying on popstate + polling');
    return rows;
}

const isProblemRow = (r) => r.status === 'FAIL' || r.status === 'WARN';
const formatHealthRow = (r) => `  [${r.status}] ${r.check}: ${r.detail}`;

function runHealthCheck() {
    const rows = collectHealth();
    console.log('[GeminiHotkeys] --- health check ---');
    console.table(rows);
    // console.table copies out of DevTools as just "Array(n)", so also print plain text.
    console.log(rows.map(formatHealthRow).join('\n'));
    const problems = rows.filter(isProblemRow).length;
    console.log(problems ? `[GeminiHotkeys] ${problems} problem(s) found.` : '[GeminiHotkeys] All checks passed.');
    return rows;
}
window.runHealthCheck = runHealthCheck; // isolated world only - the console-callable entry point is in error-monitor.js
window.addEventListener('gemini-hotkeys:run-health-check', () => runHealthCheck());

function scheduleStartupHealthCheck() {
    // Chat pages only - the rest of gemini.google.com legitimately has no compose box.
    if (!/^\/app(\/|$)/.test(location.pathname)) return;
    let attempt = 0;
    const run = () => {
        const problems = collectHealth().filter(isProblemRow);
        if (!problems.length) {
            log('Startup health check passed.');
            return;
        }
        // Elements can take a while to appear on a slow load - only complain
        // if it's still wrong on the second look.
        if (++attempt < 2) {
            setTimeout(run, TIMING.healthCheckRetryDelay);
            return;
        }
        warn(`Startup health check found ${problems.length} problem(s) - Gemini's page may have changed:\n${problems.map(formatHealthRow).join('\n')}\nRun runHealthCheck() in this console for the full report.`);
    };
    setTimeout(run, TIMING.healthCheckDelay);
}

// ==========================================
// TAB HIGHLIGHT ON RESPONSE COMPLETE
// ==========================================
// Highlights the tab (title + favicon, no blinking) when a response
// finishes while the tab isn't visible, so you don't have to keep
// switching back just to check. Clears automatically once you do.

// At document_start (see manifest.json), <title> likely hasn't been parsed
// yet, so document.title may be empty here. Re-capture once the DOM has
// actually loaded, so the "restore original title" behavior below has the
// real title rather than "".
let ORIGINAL_TAB_TITLE = document.title;
document.addEventListener('DOMContentLoaded', () => {
    if (document.title) ORIGINAL_TAB_TITLE = document.title;
});

let originalFaviconHref = null;
let tabHighlightActive = false;
let wasGenerating = false;

// Small green dot, built inline as a data URI so no separate icon file is
// needed.
const DONE_FAVICON = 'data:image/svg+xml,' + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle cx="50" cy="50" r="42" fill="#22c55e" stroke="white" stroke-width="8"/></svg>'
);

function getFaviconLink() {
    let link = document.querySelector('link[rel~="icon"]');
    if (!link) {
        link = document.createElement('link');
        link.rel = 'icon';
        (document.head || document.documentElement).appendChild(link);
    }
    return link;
}

// Reuses the same aria-label keyword pattern getMicButtons() already
// carves out an exception for (excluding "generat"/"respond"/"response"
// combined with "stop", so it isn't confused for the mic's own stop
// button) - that exception exists specifically because this "stop
// generating" control is a real, separate button on the page.
//
// Runs on every poll tick (via isResponseGenerating, below) AND on every
// cancel-key press, so it starts from a cheap attribute filter (only
// controls whose label / test id mentions "stop" can possibly pass the
// check below) instead of measuring every button on the page - which in a
// long chat is hundreds of layout reads each time.
function getStopGeneratingButton() {
    const allButtons = document.querySelectorAll(SELECTORS.stopControls);
    for (const btn of allButtons) {
        if (!isReallyVisible(btn)) continue;
        const label = (btn.getAttribute('aria-label') || '').toLowerCase();
        const testId = (btn.getAttribute('data-test-id') || '').toLowerCase();
        const combined = `${label} ${testId}`;
        if (combined.includes('stop') && (combined.includes('generat') || combined.includes('respond') || combined.includes('response'))) {
            return btn;
        }
    }
    return null;
}

function isResponseGenerating() {
    return !!getStopGeneratingButton();
}

function highlightTab() {
    if (tabHighlightActive) return;
    tabHighlightActive = true;
    document.title = '\u2705 ' + ORIGINAL_TAB_TITLE;
    const link = getFaviconLink();
    if (originalFaviconHref === null) originalFaviconHref = link.href;
    link.href = DONE_FAVICON;
    log('highlightTab() fired @', performance.now().toFixed(0) + 'ms. New title:', document.title, 'favicon href now:', link.href.slice(0, 40));
}

function clearTabHighlight() {
    if (!tabHighlightActive) return;
    tabHighlightActive = false;
    document.title = ORIGINAL_TAB_TITLE;
    if (originalFaviconHref !== null) getFaviconLink().href = originalFaviconHref;
    log('clearTabHighlight() fired @', performance.now().toFixed(0) + 'ms.');
}

document.addEventListener('visibilitychange', () => {
    log('visibilitychange fired, document.hidden =', document.hidden, '@', performance.now().toFixed(0) + 'ms');
    if (isDictationActive()) dictTrace(`tab became ${document.hidden ? 'hidden' : 'visible'} while dictating`);
    if (!document.hidden) clearTabHighlight();
});

// Polls for the generation state transitioning from "in progress" to
// "finished" while the tab is hidden. A MutationObserver would be more
// efficient, but polling matches the rest of this script's style and this
// only needs to check a couple times a second.
let lastPollLogTime = 0;
setInterval(() => {
    const generatingNow = isResponseGenerating();
    const now = performance.now();
    // Log roughly every ~5s (not every 700ms tick) to avoid spam, but the
    // gap between consecutive log timestamps below still reveals whether
    // the browser is throttling this interval while the tab is hidden -
    // it should be close to 5000ms; a much larger gap means throttling.
    if (DEBUG && DEBUG_POLL && now - lastPollLogTime > 5000) {
        log(`poll tick @ ${now.toFixed(0)}ms - generatingNow=${generatingNow}, wasGenerating=${wasGenerating}, document.hidden=${document.hidden}`);
        lastPollLogTime = now;
    }
    if (wasGenerating && !generatingNow && document.hidden) {
        log('Detected generation -> finished transition while hidden. Calling highlightTab().');
        highlightTab();
    }
    wasGenerating = generatingNow;

    // Attribute every dictation start/end to a cause, for runDictationReport():
    // a transition with no action of ours just before it was done by the page
    // or the person (mouse click, Gemini's own shortcut) - or the session
    // ended on its own (silence timeout, network) - not by this extension.
    const dictatingNow = isDictationActive();
    if (dictatingNow !== wasDictating) {
        const byUs = Date.now() - lastDictationActionTime < 5000;
        dictTrace(`dictation ${dictatingNow ? 'started' : 'ended'} - ${byUs ? 'right after an action by this extension' : 'NOT caused by this extension (none of its hotkeys / auto-cancel acted just before)'}`);
        wasDictating = dictatingNow;
        if (!dictatingNow) dictationStartedByUsAt = 0;
    }

    // Also the fallback navigation check (recordModelIfChanged begins by
    // calling checkForPathChange), so a "New chat" navigation is noticed
    // within ~700ms even if the Navigation API listener doesn't fire.
    recordModelIfChanged('poll');
}, 700);

scheduleStartupHealthCheck();

} // end duplicate-injection guard