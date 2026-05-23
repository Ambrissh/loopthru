const apiKeyInput = document.getElementById('apiKey');
const saveKeyBtn = document.getElementById('saveKey');
const keyStatusEl = document.getElementById('keyStatus');
const intentInput = document.getElementById('intent');
const saveBtn = document.getElementById('save');
const statusEl = document.getElementById('status');

const INTENT_KEY = 'userIntent';
const GROQ_API_KEY_STORAGE = 'groqApiKey';

let keyStatusTimeoutId = null;

function setKeyStatus(text, kind) {
  keyStatusEl.textContent = text;
  keyStatusEl.className = kind ? `status ${kind}` : 'status';
}

function setIntentStatus(text, kind) {
  statusEl.textContent = text;
  statusEl.className = kind ? `status ${kind}` : 'status';
}

chrome.storage.local.get([GROQ_API_KEY_STORAGE, INTENT_KEY], (result) => {
  if (chrome.runtime.lastError) {
    setKeyStatus(chrome.runtime.lastError.message, 'err');
    return;
  }
  if (result[GROQ_API_KEY_STORAGE]) {
    apiKeyInput.value = result[GROQ_API_KEY_STORAGE];
  }
  if (result[INTENT_KEY]) {
    intentInput.value = result[INTENT_KEY];
  }
});

saveKeyBtn.addEventListener('click', () => {
  const value = apiKeyInput.value.trim();
  chrome.storage.local.set({ [GROQ_API_KEY_STORAGE]: value }, () => {
    if (chrome.runtime.lastError) {
      setKeyStatus(chrome.runtime.lastError.message, 'err');
      return;
    }
    setKeyStatus('Key saved ✓', 'ok');
    if (keyStatusTimeoutId) clearTimeout(keyStatusTimeoutId);
    keyStatusTimeoutId = setTimeout(() => {
      setKeyStatus('');
      keyStatusTimeoutId = null;
    }, 2000);
  });
});

saveBtn.addEventListener('click', () => {
  const value = intentInput.value.trim();
  chrome.storage.local.set({ [INTENT_KEY]: value }, () => {
    if (chrome.runtime.lastError) {
      setIntentStatus(chrome.runtime.lastError.message, 'err');
      return;
    }
    setIntentStatus(value ? 'Saved.' : 'Cleared (empty intent).', 'ok');
  });
});
