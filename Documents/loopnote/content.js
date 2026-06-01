(function () {
  "use strict";

  const SIDEBAR_ID = "loopnote-root";
  const SCRIPT_ID = "loopnote-sidebar-script";
  const WIDTH_VAR = "--loopnote-width";
  const OPEN_CLASS = "loopnote-layout-open";
  const READY_FLAG = "data-loopnote-ready";
  const MESSAGE_SOURCE = "loopnote-sidebar";
  const BRIDGE_SOURCE = "loopnote-content";

  let layoutTarget = null;
  let observer = null;

  function findLayoutTarget() {
    return document.querySelector("#__next") || document.querySelector("main") || document.body;
  }

  function applyLayout(width, isOpen) {
    const target = layoutTarget || findLayoutTarget();
    if (!target) return;

    layoutTarget = target;
    target.style.setProperty(WIDTH_VAR, `${Math.max(0, Number(width) || 0)}px`);
    target.classList.toggle(OPEN_CLASS, Boolean(isOpen));
  }

  function injectSidebarScript() {
    if (document.documentElement.getAttribute(READY_FLAG) === "true") return true;
    if (document.getElementById(SIDEBAR_ID)) {
      document.documentElement.setAttribute(READY_FLAG, "true");
      return true;
    }

    const script = document.createElement("script");
    script.id = SCRIPT_ID;
    script.src = chrome.runtime.getURL("sidebar.js");
    script.async = false;
    script.onload = function () {
      script.remove();
    };
    script.onerror = function () {
      script.remove();
      document.documentElement.removeAttribute(READY_FLAG);
    };

    (document.head || document.documentElement).appendChild(script);
    document.documentElement.setAttribute(READY_FLAG, "true");
    return true;
  }

  function respond(id, ok, payload) {
    window.postMessage(
      {
        source: BRIDGE_SOURCE,
        id,
        ok,
        payload
      },
      window.location.origin
    );
  }

  function getStorage(keys) {
    return new Promise((resolve, reject) => {
      try {
        chrome.storage.local.get(keys, resolve);
      } catch (error) {
        reject(error);
      }
    });
  }

  function setStorage(items) {
    return new Promise((resolve, reject) => {
      try {
        chrome.storage.local.set(items, resolve);
      } catch (error) {
        reject(error);
      }
    });
  }

  function removeStorage(keys) {
    return new Promise((resolve, reject) => {
      try {
        chrome.storage.local.remove(keys, resolve);
      } catch (error) {
        reject(error);
      }
    });
  }

  async function requestGroq(payload) {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 30000);

    try {
      const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${payload.apiKey}`
        },
        body: JSON.stringify(payload.body),
        signal: controller.signal
      });

      if (!response.ok) {
        return {
          ok: false,
          status: response.status,
          message: response.status === 401
            ? "Groq rejected the saved API key. Clear this extension's storage and save a valid key."
            : `Groq request failed (${response.status}). Please try again.`
        };
      }

      const data = await response.json();
      return { ok: true, data };
    } catch (error) {
      if (error && error.name === "AbortError") {
        return {
          ok: false,
          status: 408,
          message: "Request timed out.\nPlease try again."
        };
      }

      return {
        ok: false,
        status: 0,
        message: "Network error. Please try again."
      };
    } finally {
      window.clearTimeout(timeout);
    }
  }

  window.addEventListener("message", async (event) => {
    if (event.source !== window || event.origin !== window.location.origin) return;

    const data = event.data;
    if (!data || data.source !== MESSAGE_SOURCE || !data.id || !data.type) return;

    try {
      if (data.type === "storage:get") {
        const value = await getStorage(data.keys);
        respond(data.id, true, value);
        return;
      }

      if (data.type === "storage:set") {
        await setStorage(data.items || {});
        respond(data.id, true, { saved: true });
        return;
      }

      if (data.type === "storage:remove") {
        await removeStorage(data.keys);
        respond(data.id, true, { removed: true });
        return;
      }

      if (data.type === "layout") {
        applyLayout(data.width, data.isOpen);
        respond(data.id, true, { applied: true });
        return;
      }

      if (data.type === "groq:request") {
        const result = await requestGroq(data.payload || {});
        respond(data.id, true, result);
        return;
      }

      respond(data.id, false, { message: "Unsupported LoopNote bridge request." });
    } catch (error) {
      respond(data.id, false, { message: error && error.message ? error.message : "LoopNote bridge failed." });
    }
  });

  function init() {
    if (injectSidebarScript()) {
      if (observer) observer.disconnect();
      observer = null;
    }
  }

  if (document.body) {
    init();
  } else {
    observer = new MutationObserver(() => {
      if (document.body) init();
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }
})();
