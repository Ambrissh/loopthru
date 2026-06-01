# LoopNote Security Rules

- NEVER hardcode API keys.
- API keys must never exist in source files.
- The Groq key prefix must never appear in code.
- API keys only live inside chrome.storage.local.
- Always read keys at runtime.

- NEVER use innerHTML with user-generated content.
- Always use textContent or createElement.

- NEVER access ChatGPT session cookies.

- NEVER intercept ChatGPT WebSocket traffic.

- NEVER modify OpenAI requests.

- Only request permissions actually used.

- Wrap all fetch calls in try/catch.

- Wrap all chrome.storage calls in try/catch.

- Before any git operation:
  search project files for:
  the Groq key prefix

  If found:
  STOP.
