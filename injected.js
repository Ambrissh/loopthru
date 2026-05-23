(() => {
  if (window.__LOOPTHRU_WS_PATCHED__) return;
  window.__LOOPTHRU_WS_PATCHED__ = true;

  const LOOPTHRU_EVENT_MARKER = '__loopthruMessageProcessed';
  const originalDispatchEvent = WebSocket.prototype.dispatchEvent;
  const originalAddEventListener = EventTarget.prototype.addEventListener;
  const originalRemoveEventListener = EventTarget.prototype.removeEventListener;
  const originalSend = WebSocket.prototype.send;
  const originalOnMessageDescriptor = Object.getOwnPropertyDescriptor(WebSocket.prototype, 'onmessage');
  const listenerMap = new WeakMap();
  const onMessageMap = new WeakMap();
  let compressedWriter = null;
  let compressedWriteChain = Promise.resolve();
  let decompressedBuffer = '';

  function postGuildData(guild) {
    if (!guild || !guild.id) return;
    window.postMessage(
      {
        type: 'LOOPTHRU_GUILD_DATA',
        payload: {
          guildId: guild.id,
          guildName: guild.name,
          channels: guild.channels,
        },
      },
      window.location.origin,
    );
  }

  function postGatewayMetadata(data) {
    const eventName = data?.t;
    const d = data?.d;
    if (!d) return;

    if (eventName === 'READY' && Array.isArray(d.guilds)) {
      for (const guild of d.guilds) {
        postGuildData(guild);
      }
    } else if (eventName === 'GUILD_CREATE') {
      postGuildData(d);
    }
  }

  function postMessageCreate(data) {
    const eventName = data?.t;
    const message = data?.d;
    if (eventName !== 'MESSAGE_CREATE' || !message) return;

    const text = typeof message.content === 'string' ? message.content.trim() : '';
    if (!text) return;

    const author = message.author?.username?.trim() || 'Unknown';
    window.postMessage(
      {
        type: 'LOOPTHRU_MSG',
        payload: {
          author,
          text,
          messageId: message.id || null,
          guildId: message.guild_id || null,
          channelId: message.channel_id || null,
        },
      },
      window.location.origin,
    );
  }

  function parseGatewayPayload(raw) {
    if (typeof raw !== 'string' || !raw) return;
    try {
      const parsed = JSON.parse(raw);
      postGatewayMetadata(parsed);
      postMessageCreate(parsed);
    } catch {
      /* Non-JSON gateway frames are not Discord dispatch payloads. */
    }
  }

  function consumeDecompressedText(text) {
    decompressedBuffer += text;

    for (;;) {
      const start = decompressedBuffer.indexOf('{');
      if (start === -1) {
        decompressedBuffer = '';
        return;
      }

      if (start > 0) {
        decompressedBuffer = decompressedBuffer.slice(start);
      }

      let depth = 0;
      let inString = false;
      let escaped = false;
      let end = -1;

      for (let i = 0; i < decompressedBuffer.length; i += 1) {
        const ch = decompressedBuffer[i];

        if (inString) {
          if (escaped) {
            escaped = false;
          } else if (ch === '\\') {
            escaped = true;
          } else if (ch === '"') {
            inString = false;
          }
          continue;
        }

        if (ch === '"') {
          inString = true;
        } else if (ch === '{') {
          depth += 1;
        } else if (ch === '}') {
          depth -= 1;
          if (depth === 0) {
            end = i + 1;
            break;
          }
        }
      }

      if (end === -1) return;

      parseGatewayPayload(decompressedBuffer.slice(0, end));
      decompressedBuffer = decompressedBuffer.slice(end);
    }
  }

  function ensureCompressedStream() {
    if (compressedWriter) return compressedWriter;
    if (typeof DecompressionStream !== 'function') return null;

    try {
      const input = new TransformStream();
      const decompressed = input.readable
        .pipeThrough(new DecompressionStream('deflate'))
        .pipeThrough(new TextDecoderStream());
      const reader = decompressed.getReader();
      compressedWriter = input.writable.getWriter();

      (async () => {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) return;
          consumeDecompressedText(value);
        }
      })().catch(() => {
        // Stream died — reset so next frame reinits
        compressedWriter = null;
        decompressedBuffer = '';
      });
    } catch {
      compressedWriter = null;
    }

    return compressedWriter;
  }

  function writeCompressedChunk(chunk) {
    const writer = ensureCompressedStream();
    if (!writer) return;

    compressedWriteChain = compressedWriteChain
      .then(() => writer.write(chunk))
      .catch(() => {
        compressedWriter = null;
        decompressedBuffer = '';
      });
  }

  function processMessageData(data) {
    if (typeof data === 'string') {
      parseGatewayPayload(data);
      return;
    }

    if (data instanceof ArrayBuffer) {
      writeCompressedChunk(new Uint8Array(data));
      return;
    }

    if (data instanceof Blob) {
      data.arrayBuffer()
        .then((buffer) => writeCompressedChunk(new Uint8Array(buffer)))
        .catch(() => {});
    }
  }

  function processMessageEvent(event) {
    if (!event || event.type !== 'message') return;
    if (event[LOOPTHRU_EVENT_MARKER]) return;

    try {
      Object.defineProperty(event, LOOPTHRU_EVENT_MARKER, {
        value: true,
      });
    } catch {
      event[LOOPTHRU_EVENT_MARKER] = true;
    }

    processMessageData(event.data);
  }

  WebSocket.prototype.send = function patchedSend(...args) {
    return originalSend.apply(this, args);
  };

  WebSocket.prototype.dispatchEvent = function patchedDispatchEvent(event) {
    processMessageEvent(event);
    return originalDispatchEvent.call(this, event);
  };

  function wrapListener(listener, socket) {
    let wrappedByListener = listenerMap.get(listener);
    if (!wrappedByListener) {
      wrappedByListener = new WeakMap();
      listenerMap.set(listener, wrappedByListener);
    }

    let wrapped = wrappedByListener.get(socket);
    if (!wrapped) {
      wrapped = function loopThruMessageListener(event) {
        processMessageEvent(event);
        if (typeof listener === 'function') {
          return listener.call(this, event);
        }
        return listener.handleEvent.call(listener, event);
      };
      wrappedByListener.set(socket, wrapped);
    }

    return wrapped;
  }

  EventTarget.prototype.addEventListener = function patchedAddEventListener(type, listener, options) {
    if (this instanceof WebSocket && type === 'message' && listener) {
      return originalAddEventListener.call(this, type, wrapListener(listener, this), options);
    }

    return originalAddEventListener.call(this, type, listener, options);
  };

  EventTarget.prototype.removeEventListener = function patchedRemoveEventListener(type, listener, options) {
    if (this instanceof WebSocket && type === 'message' && listener) {
      const wrapped = listenerMap.get(listener)?.get(this) || listener;
      return originalRemoveEventListener.call(this, type, wrapped, options);
    }

    return originalRemoveEventListener.call(this, type, listener, options);
  };

  if (originalOnMessageDescriptor?.configurable) {
    Object.defineProperty(WebSocket.prototype, 'onmessage', {
      configurable: true,
      enumerable: originalOnMessageDescriptor.enumerable,
      get() {
        return onMessageMap.get(this)?.original || originalOnMessageDescriptor.get?.call(this) || null;
      },
      set(listener) {
        if (!listener) {
          onMessageMap.delete(this);
          originalOnMessageDescriptor.set?.call(this, listener);
          return;
        }

        const wrapped = wrapListener(listener, this);
        onMessageMap.set(this, { original: listener, wrapped });
        originalOnMessageDescriptor.set?.call(this, wrapped);
      },
    });
  }
})();
