const defaultKeys = {
    mic: 'F1',
    flashLite: 'F2',
    flash: 'F3',
    pro: 'F4',
    extended: 'F8',
    sendDuringDictation: 'Space',
    cancelDictation: 'Escape',
    stopResponse: 'Escape',
    defaultHomeModel: 'off',
    defaultNewChatModel: 'off'
};

// Load saved settings when the page opens
chrome.storage.sync.get(defaultKeys, (items) => {
    document.getElementById('key-mic').value = items.mic;
    document.getElementById('key-flash-lite').value = items.flashLite;
    document.getElementById('key-flash').value = items.flash;
    document.getElementById('key-pro').value = items.pro;
    document.getElementById('key-extended').value = items.extended;
    document.getElementById('key-send-dictation').value = items.sendDuringDictation;
    document.getElementById('key-cancel-dictation').value = items.cancelDictation;
    document.getElementById('key-stop-response').value = items.stopResponse;
    document.getElementById('default-home-model').value = items.defaultHomeModel;
    document.getElementById('default-new-chat-model').value = items.defaultNewChatModel;
    updateDuplicateWarning();
});

// Two actions bound to the same key can't both work - whichever the page
// checks first wins and the other silently never fires. Say so, naming both.
//
// Exception: Stop Response is checked based on runtime state (a response
// generating right now) completely independent of dictation state, so it
// can safely share a key with EITHER Cancel Dictation or Send During
// Dictation - the two states can never both be true at once. Cancel
// Dictation and Send During Dictation must NOT share a key with EACH
// OTHER though - both only mean something while dictating, so sharing
// means never being able to choose between them. This only recognizes
// those two specific pairs as safe - Stop Response sharing a key with
// anything else (a model switch, say) is a real conflict like any other.
const SAFE_PAIRS = [
    ['Stop Response', 'Cancel Dictation'],
    ['Stop Response', 'Send During Dictation'],
];
function isSafePair(a, b) {
    return SAFE_PAIRS.some(([x, y]) => (x === a && y === b) || (x === b && y === a));
}
// True if this key has a real conflict - i.e. at least one pair among the
// labels sharing it ISN'T a recognized-safe pair.
function hasRealConflict(labels) {
    for (let i = 0; i < labels.length; i++) {
        for (let j = i + 1; j < labels.length; j++) {
            if (!isSafePair(labels[i], labels[j])) return true;
        }
    }
    return false;
}
function updateDuplicateWarning() {
    const byKey = {};
    document.querySelectorAll('input').forEach(input => {
        if (!input.value) return;
        const label = input.previousElementSibling ? input.previousElementSibling.textContent.replace(/:\s*$/, '').trim() : input.id;
        (byKey[input.value] = byKey[input.value] || []).push(label);
    });
    const messages = Object.entries(byKey)
        .filter(([, labels]) => labels.length > 1 && hasRealConflict(labels))
        .map(([key, labels]) => `${key} is assigned to ${labels.map(l => '\u201c' + l + '\u201d').join(' and ')} - only one of them will work.`);
    document.getElementById('warning').textContent = messages.length ? '\u26A0 ' + messages.join(' \u26A0 ') : '';
}

// Capture key presses in the input fields
document.querySelectorAll('input').forEach(input => {
    input.addEventListener('keydown', (e) => {
        e.preventDefault(); 
        
        // If the user just presses a modifier by itself, do nothing yet. Wait for the actual key.
        if (['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) return;
        
        let keys = [];
        
        // Add modifiers in a consistent order
        if (e.ctrlKey) keys.push('Ctrl');
        if (e.altKey) keys.push('Alt');
        if (e.shiftKey) keys.push('Shift');
        if (e.metaKey) keys.push('Meta');
        
        // Format the main key
        let mainKey = e.key;
        if (mainKey === ' ') mainKey = 'Space';
        // Capitalize single letters (like 'm' -> 'M') for a cleaner look
        if (mainKey.length === 1) mainKey = mainKey.toUpperCase();
        
        keys.push(mainKey);
        
        // Set the input box value to the combined string (e.g., "Alt+M")
        input.value = keys.join('+');
        updateDuplicateWarning();
    });
});

// Save settings to browser storage
document.getElementById('save').addEventListener('click', () => {
    const keys = {
        mic: document.getElementById('key-mic').value,
        flashLite: document.getElementById('key-flash-lite').value,
        flash: document.getElementById('key-flash').value,
        pro: document.getElementById('key-pro').value,
        extended: document.getElementById('key-extended').value,
        sendDuringDictation: document.getElementById('key-send-dictation').value,
        cancelDictation: document.getElementById('key-cancel-dictation').value,
        stopResponse: document.getElementById('key-stop-response').value,
        defaultHomeModel: document.getElementById('default-home-model').value,
        defaultNewChatModel: document.getElementById('default-new-chat-model').value
    };

    chrome.storage.sync.set(keys, () => {
        const status = document.getElementById('status');
        status.textContent = 'Settings saved successfully!';
        setTimeout(() => { status.textContent = ''; }, 2500);
    });
});