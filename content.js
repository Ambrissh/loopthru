(() => {
  const seenIds = new Set();
  const seenFingerprints = new Set();
  const MAX_CACHE = 400;

  function prune(set) {
    if (set.size <= MAX_CACHE) return;
    const drop = set.size - MAX_CACHE;
    const it = set.values();
    for (let i = 0; i < drop; i += 1) {
      const v = it.next().value;
      if (v !== undefined) set.delete(v);
    }
  }

  function fingerprint(author, text) {
    return `${author}\n${text}`;
  }

  function isExtensionContextValid() {
    try {
      return typeof chrome !== 'undefined' && Boolean(chrome.runtime?.id);
    } catch {
      return false;
    }
  }

  function sendDiscordMessageToBackground(payload) {
    if (!isExtensionContextValid()) {
      return;
    }
    try {
      chrome.runtime.sendMessage(
        {
          type: 'DISCORD_MESSAGE',
          payload,
        },
        () => {
          try {
            const err = chrome.runtime.lastError;
            if (!err) return;
            const msg = err.message || '';
            if (msg.includes('Extension context invalidated')) return;
            console.warn('[Signal] sendMessage:', msg);
          } catch {
            /* ignore lastError access after invalidation */
          }
        },
      );
    } catch {
      /* Extension context invalidated — reload Discord tab after extension reload */
    }
  }

  function emitMessage(author, text, messageId = null, guildId = null, channelId = null) {
    const cleanAuthor = author || 'Unknown';
    const cleanText = text?.trim?.() || '';
    if (!cleanText || cleanText.length > 8000) return;

    const id = messageId || '';
    const fp = fingerprint(cleanAuthor, cleanText);
    if (id && seenIds.has(id)) return;
    if (!id && seenFingerprints.has(fp)) return;

    if (id) {
      seenIds.add(id);
      prune(seenIds);
    } else {
      seenFingerprints.add(fp);
      prune(seenFingerprints);
    }

    sendDiscordMessageToBackground({
      author: cleanAuthor,
      text: cleanText,
      messageId: id || null,
      guildId: guildId || null,
      channelId: channelId || null,
    });
  }

  window.addEventListener('message', (event) => {
    if (!event.data || event.source !== window) return;

    if (event.data.type === 'LOOPTHRU_MSG') {
      if (!isExtensionContextValid()) return;
      sendDiscordMessageToBackground(event.data.payload);
    }

    if (event.data.type === 'LOOPTHRU_GUILD_DATA') {
      if (!isExtensionContextValid()) return;
      chrome.runtime.sendMessage({ type: 'GUILD_DATA', payload: event.data.payload });
    }
  });
})();
