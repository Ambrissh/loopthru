const INTENT_KEY = 'userIntent';
const GROQ_API_KEY_STORAGE = 'groqApiKey';
const LEARNED_SERVERS_KEY = 'learnedServers';
const GROQ_MODEL = 'llama-3.1-8b-instant';
const GROQ_CHAT_URL = 'https://api.groq.com/openai/v1/chat/completions';

const BATCH_MS = 60_000;
const MIN_API_INTERVAL_MS = 30_000;
const MAX_BATCH_MESSAGES = 5;

/** First wait after a 429; doubles each consecutive 429 until capped. */
const RATE_LIMIT_INITIAL_BACKOFF_MS = 60_000;
const RATE_LIMIT_MAX_BACKOFF_MS = 8 * 60_000;

/** Minimal valid 1×1 PNG (data URL); required by chrome.notifications on some platforms. */
const NOTIFICATION_ICON_PNG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const recentClassificationKeys = new Map();
const DEDUPE_MS = 2 * 60 * 1000;

let messageBatch = [];
let batchTimerId = null;
let lastApiCallTime = 0;
let apiQueue = [];
let apiQueueRunning = false;
let consecutiveRateLimit429Hits = 0;

function dedupeKey(author, text) {
  return `${author}|${text}`;
}

function shouldSkipDedupe(key) {
  const now = Date.now();
  for (const [k, t] of recentClassificationKeys) {
    if (now - t > DEDUPE_MS) recentClassificationKeys.delete(k);
  }
  const last = recentClassificationKeys.get(key);
  if (last && now - last < DEDUPE_MS) return true;
  recentClassificationKeys.set(key, now);
  return false;
}

async function resolveNames(guildId, channelId) {
  const stored = await chrome.storage.local.get(LEARNED_SERVERS_KEY);
  const servers = stored[LEARNED_SERVERS_KEY] || {};
  const guild = guildId ? servers[guildId] : null;
  const serverName = guild?.name || '';
  const channelName = guild?.channels?.[channelId] || channelId || '';

  return { serverName, channelName };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildBatchPrompt(userIntent, messages) {
  const lines = messages.map((m, i) => `${i + 1}. ${m.author}: ${m.text}`);
  return (
    `The user is looking for: ${userIntent}. ` +
    'Below are numbered Discord messages. For each message, is it relevant to the user? ' +
    'Reply with ONLY one line per message, in order from 1 to N, each line exactly in the form "1: YES" or "1: NO" (use YES or NO in capital letters). No other text.\n\n' +
    `Messages:\n${lines.join('\n')}`
  );
}

function parseBatchAnswers(text, nMessages) {
  const results = Array.from({ length: nMessages }, () => false);
  const re = /^\s*(\d+)\s*:\s*(YES|NO)\b/i;
  for (const line of String(text).split(/\r?\n/)) {
    const m = line.match(re);
    if (!m) continue;
    const idx = Number.parseInt(m[1], 10) - 1;
    if (idx >= 0 && idx < nMessages) {
      results[idx] = m[2].toUpperCase() === 'YES';
    }
  }
  return results;
}

function extractGroqAssistantText(data) {
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== 'string') return '';
  return content.trim();
}

async function fetchGroqClassification(groqApiKey, userIntent, messages) {
  const prompt = buildBatchPrompt(userIntent, messages);
  const body = JSON.stringify({
    model: GROQ_MODEL,
    messages: [{ role: 'user', content: prompt }],
    temperature: 0,
  });

  for (;;) {
    const res = await fetch(GROQ_CHAT_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${groqApiKey}`,
      },
      body,
    });

    if (res.status === 429) {
      const waitMs = Math.min(
        RATE_LIMIT_INITIAL_BACKOFF_MS * 2 ** consecutiveRateLimit429Hits,
        RATE_LIMIT_MAX_BACKOFF_MS,
      );
      consecutiveRateLimit429Hits += 1;
      console.warn('[Signal] Groq 429 rate limit — exponential backoff', {
        waitSeconds: Math.round(waitMs / 1000),
        consecutive429Count: consecutiveRateLimit429Hits,
      });
      await sleep(waitMs);
      continue;
    }

    if (!res.ok) {
      consecutiveRateLimit429Hits = 0;
      const errText = await res.text().catch(() => '');
      throw new Error(`Groq HTTP ${res.status}: ${errText.slice(0, 200)}`);
    }

    consecutiveRateLimit429Hits = 0;

    const data = await res.json();
    const extracted = extractGroqAssistantText(data);
    console.log(
      '[Signal] Groq raw response (truncated JSON):',
      JSON.stringify(data).slice(0, 2500),
    );
    console.log('[Signal] Groq extracted answer text:', extracted);
    return extracted;
  }
}

function classifyBatch(userIntent, messages) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get([GROQ_API_KEY_STORAGE], async (result) => {
      const groqApiKey = result[GROQ_API_KEY_STORAGE];
      if (!groqApiKey) {
        console.warn('[LoopThru] No API key set — skipping batch');
        resolve(null);
        return;
      }
      try {
        const answer = await fetchGroqClassification(groqApiKey, userIntent, messages);
        resolve(answer);
      } catch (e) {
        reject(e);
      }
    });
  });
}

async function processBatch(messages) {
  console.log('[Signal] Processing batch', {
    count: messages.length,
    previews: messages.map((m) => ({
      author: m.author,
      textPreview: m.text.slice(0, 120),
    })),
  });

  const { [INTENT_KEY]: intentRaw } = await chrome.storage.local.get([INTENT_KEY]);
  const userIntent = (intentRaw || '').trim();
  if (!userIntent || !messages.length) {
    console.log('[Signal] Skipping batch: no intent or empty messages');
    return;
  }

  const answerText = await classifyBatch(userIntent, messages);
  if (answerText == null) return;

  const flags = parseBatchAnswers(answerText, messages.length);
  const relevantIndices = flags
    .map((f, idx) => (f ? idx + 1 : null))
    .filter((n) => n != null);
  console.log('[Signal] Parsed relevance flags (per message index):', flags);
  console.log(
    '[Signal] Relevant message indices (1-based):',
    relevantIndices.length ? relevantIndices : '(none)',
  );

  let notifyCount = 0;
  for (let i = 0; i < messages.length; i += 1) {
    if (!flags[i]) continue;
    const { author, text, guildId, channelId } = messages[i];
    const preview = text.length > 180 ? `${text.slice(0, 180)}…` : text;
    const message = preview.trim() || 'Relevant Discord message.';
    const { serverName, channelName } = await resolveNames(guildId, channelId);
    const title = serverName
      ? `LoopThru · ${serverName} · #${channelName}`
      : 'LoopThru · Discord';
    const nid = `signal-${Date.now()}-${i}`;
    console.log(`[Signal] Triggering notification for message #${i + 1}`, {
      notificationId: nid,
      serverName: serverName || null,
      channelId: channelId || null,
      preview: message,
    });
    try {
      await chrome.notifications.create(nid, {
        type: 'basic',
        iconUrl: NOTIFICATION_ICON_PNG_DATA_URL,
        title,
        message,
      });
      notifyCount += 1;
      console.log('[Signal] chrome.notifications.create resolved', { notificationId: nid });
    } catch (notifyErr) {
      console.error('[Signal] chrome.notifications.create failed', notifyErr);
    }
  }
  console.log('[Signal] Batch complete. Notifications shown:', notifyCount);
}

async function runApiQueue() {
  if (apiQueueRunning) return;
  apiQueueRunning = true;
  try {
    while (apiQueue.length) {
      const wait = Math.max(0, MIN_API_INTERVAL_MS - (Date.now() - lastApiCallTime));
      if (wait > 0) await sleep(wait);

      const batch = apiQueue.shift();
      if (!batch?.length) continue;

      await processBatch(batch);
      lastApiCallTime = Date.now();
    }
  } catch (e) {
    console.error('[Signal]', e);
  } finally {
    apiQueueRunning = false;
    if (apiQueue.length) runApiQueue();
  }
}

function enqueueBatchForApi(messages) {
  if (!messages.length) return;
  console.log('[Signal] Batch received — queued for Groq', {
    count: messages.length,
    previews: messages.map((m) => ({
      author: m.author,
      textPreview: m.text.slice(0, 120),
    })),
    queueLengthAfter: apiQueue.length + 1,
  });
  apiQueue.push(messages);
  runApiQueue();
}

function flushBatchWindow() {
  batchTimerId = null;
  if (!messageBatch.length) return;

  const snapshot = messageBatch;
  messageBatch = [];

  const trimmed =
    snapshot.length > MAX_BATCH_MESSAGES ? snapshot.slice(-MAX_BATCH_MESSAGES) : snapshot;

  enqueueBatchForApi(trimmed);
}

function scheduleBatchFlush() {
  if (batchTimerId != null) return;
  batchTimerId = setTimeout(flushBatchWindow, BATCH_MS);
}

function enqueueIncomingMessage(author, text, guildId = null, channelId = null) {
  messageBatch.push({ author, text, guildId, channelId });
  scheduleBatchFlush();
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'GUILD_DATA') {
    (async () => {
      try {
        const payload = msg.payload || {};
        if (!payload.guildId) {
          sendResponse({ ok: true, skipped: true });
          return;
        }

        const stored = await chrome.storage.local.get(LEARNED_SERVERS_KEY);
        const servers = stored[LEARNED_SERVERS_KEY] || {};

        const channelMap = {};
        (payload.channels || []).forEach(ch => {
          if (ch.id && ch.name) channelMap[ch.id] = ch.name;
        });

        servers[payload.guildId] = { name: payload.guildName, channels: channelMap };

        await chrome.storage.local.set({ [LEARNED_SERVERS_KEY]: servers });
        console.log('[Signal] Stored guild data', { guildId: payload.guildId, guildName: payload.guildName, channelCount: Object.keys(channelMap).length });
        sendResponse({ ok: true });
      } catch (e) {
        console.error('[Signal] Error storing guild data', e);
        sendResponse({ ok: false, error: String(e?.message || e) });
      }
    })();
    return true;
  }

  if (msg?.type !== 'DISCORD_MESSAGE') return;

  (async () => {
    try {
      const { author, text, guildId, channelId } = msg.payload || {};
      if (!text) {
        sendResponse({ ok: true, skipped: true });
        return;
      }

      const { [INTENT_KEY]: intentRaw } = await chrome.storage.local.get([INTENT_KEY]);
      const userIntent = (intentRaw || '').trim();
      if (!userIntent) {
        sendResponse({ ok: true, skipped: true, reason: 'no_intent' });
        return;
      }

      const key = dedupeKey(author || '', text);
      if (shouldSkipDedupe(key)) {
        sendResponse({ ok: true, skipped: true, reason: 'deduped' });
        return;
      }

      enqueueIncomingMessage(author || 'Unknown', text, guildId || null, channelId || null);
      sendResponse({ ok: true, batched: true });
    } catch (e) {
      console.error('[Signal]', e);
      sendResponse({ ok: false, error: String(e?.message || e) });
    }
  })();

  return true;
});
