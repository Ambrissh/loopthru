(function () {
  "use strict";

  const STORAGE_KEYS = {
    apiKey: "loopnote_groq_key",
    history: "loopnote_history",
    notes: "loopnote_notes",
    width: "loopnote_width",
    height: "loopnote_height",
    x: "loopnote_x",
    y: "loopnote_y"
  };
  const ROOT_ID = "loopnote-root";
  const MESSAGE_SOURCE = "loopnote-sidebar";
  const BRIDGE_SOURCE = "loopnote-content";
  const GROQ_MODEL = "llama-3.1-8b-instant";
  const MAX_HISTORY = 100;
  const MAX_CONVERSATION_MESSAGES = 20;
  const DEFAULT_WIDTH = 420;
  const DEFAULT_HEIGHT = 520;
  const MIN_WIDTH = 320;
  const MIN_HEIGHT = 320;
  const MAX_WIDTH = 700;
  const VIEWPORT_MARGIN = 12;
  const SYSTEM_PROMPT = "You are a fast concise study assistant.\n\nThe user is currently inside a long ChatGPT conversation.\n\nYour job is to answer side questions,\nclarifications,\nand quick learning questions.\n\nBe brief.\n\nBe direct.\n\nAvoid long introductions.";

  class LoopNote {
    constructor() {
      this.root = null;
      this.chatEl = null;
      this.inputEl = null;
      this.sendButton = null;
      this.panelEl = null;
      this.statusEl = null;
      this.apiKey = "";
      this.history = [];
      this.notes = [];
      this.conversation = [];
      this.activeHistoryId = null;
      this.isRequesting = false;
      this.isCollapsed = false;
      this.width = DEFAULT_WIDTH;
      this.height = DEFAULT_HEIGHT;
      this.x = null;
      this.y = 80;
      this.dragState = null;
      this.resizeState = null;
      this.frameRequest = 0;
      this.pendingBridge = new Map();
      this.activeTab = "questions";
      this.boundMessageHandler = this.handleBridgeMessage.bind(this);
      this.boundResizeViewport = this.keepInViewport.bind(this);
    }

    async init() {
      if (document.getElementById(ROOT_ID)) return;
      window.addEventListener("message", this.boundMessageHandler);
      window.addEventListener("resize", this.boundResizeViewport);
      await this.loadState();
      this.render();
      this.keepInViewport();
    }

    handleBridgeMessage(event) {
      if (event.source !== window || event.origin !== window.location.origin) return;
      const data = event.data;
      if (!data || data.source !== BRIDGE_SOURCE || !data.id) return;
      const pending = this.pendingBridge.get(data.id);
      if (!pending) return;
      this.pendingBridge.delete(data.id);
      if (data.ok) {
        pending.resolve(data.payload);
      } else {
        pending.reject(new Error(data.payload && data.payload.message ? data.payload.message : "LoopNote storage failed."));
      }
    }

    bridge(type, payload) {
      return new Promise((resolve, reject) => {
        const id = crypto.randomUUID();
        this.pendingBridge.set(id, { resolve, reject });
        window.postMessage(
          {
            source: MESSAGE_SOURCE,
            id,
            type,
            ...payload
          },
          window.location.origin
        );

        window.setTimeout(() => {
          if (!this.pendingBridge.has(id)) return;
          this.pendingBridge.delete(id);
          reject(new Error("LoopNote storage request timed out."));
        }, type === "groq:request" ? 35000 : 5000);
      });
    }

    async storageGet(keys) {
      try {
        return await this.bridge("storage:get", { keys });
      } catch (error) {
        this.showStatus(error.message || "Could not read local storage.");
        return {};
      }
    }

    async storageSet(items) {
      try {
        await this.bridge("storage:set", { items });
        return true;
      } catch (error) {
        this.showStatus(error.message || "Could not save locally.");
        return false;
      }
    }

    async loadState() {
      const data = await this.storageGet([
        STORAGE_KEYS.apiKey,
        STORAGE_KEYS.history,
        STORAGE_KEYS.notes,
        STORAGE_KEYS.width,
        STORAGE_KEYS.height,
        STORAGE_KEYS.x,
        STORAGE_KEYS.y
      ]);
      this.apiKey = typeof data[STORAGE_KEYS.apiKey] === "string" ? data[STORAGE_KEYS.apiKey] : "";
      this.history = Array.isArray(data[STORAGE_KEYS.history]) ? data[STORAGE_KEYS.history] : [];
      this.notes = Array.isArray(data[STORAGE_KEYS.notes]) ? data[STORAGE_KEYS.notes] : [];
      this.width = this.clampWidth(Number(data[STORAGE_KEYS.width]) || DEFAULT_WIDTH);
      this.height = this.clampHeight(Number(data[STORAGE_KEYS.height]) || DEFAULT_HEIGHT);
      this.x = Number.isFinite(Number(data[STORAGE_KEYS.x])) ? Number(data[STORAGE_KEYS.x]) : null;
      this.y = Number.isFinite(Number(data[STORAGE_KEYS.y])) ? Number(data[STORAGE_KEYS.y]) : 80;
    }

    render() {
      this.root = document.createElement("aside");
      this.root.id = ROOT_ID;
      this.root.style.setProperty("--loopnote-width", `${this.width}px`);
      this.root.style.setProperty("--loopnote-height", `${this.height}px`);
      this.applyGeometryStyles();

      const shell = document.createElement("div");
      shell.className = "loopnote-shell";

      this.root.appendChild(this.createLauncher());
      shell.appendChild(this.createHeader());
      if (this.apiKey) {
        shell.appendChild(this.createGreeting());
        this.chatEl = document.createElement("div");
        this.chatEl.className = "loopnote-chat";
        shell.appendChild(this.chatEl);
        shell.appendChild(this.createComposer());
      } else {
        shell.appendChild(this.createSetup());
      }

      this.root.appendChild(shell);
      this.createResizeHandles().forEach((handle) => this.root.appendChild(handle));
      document.body.appendChild(this.root);
      this.renderConversation();
    }

    createHeader() {
      const header = document.createElement("header");
      header.className = "loopnote-header";
      header.addEventListener("pointerdown", (event) => this.startDrag(event));

      const brand = document.createElement("div");
      brand.className = "loopnote-brand";
      const logo = document.createElement("span");
      logo.className = "loopnote-logo";
      logo.appendChild(this.createLogoSvg());

      const copy = document.createElement("span");
      copy.className = "loopnote-brand-copy";
      const name = document.createElement("span");
      name.className = "loopnote-brand-name";
      name.textContent = "LoopNote";
      const subtitle = document.createElement("span");
      subtitle.className = "loopnote-brand-subtitle";
      subtitle.textContent = "Your parallel thinking space";
      copy.append(name, subtitle);
      brand.append(logo, copy);

      const actions = document.createElement("div");
      actions.className = "loopnote-actions";

      const download = this.iconButton("↓", "Download");
      download.addEventListener("click", () => this.downloadConversation());

      const questions = this.iconButton("☰", "Questions");
      questions.addEventListener("click", () => this.togglePanel());

      const collapse = this.iconButton("", "Collapse");
      collapse.appendChild(this.createLogoSvg());
      collapse.addEventListener("click", () => this.toggleSidebar());

      actions.append(download, questions, collapse);
      header.append(brand, actions);
      return header;
    }

    createLauncher() {
      const launcher = document.createElement("button");
      launcher.className = "loopnote-launcher";
      launcher.type = "button";
      launcher.title = "Open LoopNote";
      launcher.setAttribute("aria-label", "Open LoopNote");
      launcher.appendChild(this.createLogoSvg());
      launcher.addEventListener("click", () => {
        if (this.isCollapsed) this.toggleSidebar();
      });
      return launcher;
    }

    createLogoSvg() {
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("viewBox", "0 0 32 32");
      svg.setAttribute("aria-hidden", "true");
      svg.setAttribute("focusable", "false");

      const back = document.createElementNS("http://www.w3.org/2000/svg", "rect");
      back.setAttribute("x", "10");
      back.setAttribute("y", "5");
      back.setAttribute("width", "15");
      back.setAttribute("height", "20");
      back.setAttribute("rx", "3");
      back.setAttribute("fill", "none");
      back.setAttribute("stroke", "currentColor");
      back.setAttribute("stroke-width", "2");
      back.setAttribute("opacity", "0.55");

      const front = document.createElementNS("http://www.w3.org/2000/svg", "rect");
      front.setAttribute("x", "6");
      front.setAttribute("y", "9");
      front.setAttribute("width", "15");
      front.setAttribute("height", "20");
      front.setAttribute("rx", "3");
      front.setAttribute("fill", "none");
      front.setAttribute("stroke", "currentColor");
      front.setAttribute("stroke-width", "2.2");

      const lineOne = document.createElementNS("http://www.w3.org/2000/svg", "path");
      lineOne.setAttribute("d", "M10 15h7");
      lineOne.setAttribute("stroke", "currentColor");
      lineOne.setAttribute("stroke-width", "1.8");
      lineOne.setAttribute("stroke-linecap", "round");

      const lineTwo = document.createElementNS("http://www.w3.org/2000/svg", "path");
      lineTwo.setAttribute("d", "M10 20h6");
      lineTwo.setAttribute("stroke", "currentColor");
      lineTwo.setAttribute("stroke-width", "1.8");
      lineTwo.setAttribute("stroke-linecap", "round");

      svg.append(back, front, lineOne, lineTwo);
      return svg;
    }

    createResizeHandles() {
      return ["left", "right", "bottom", "corner"].map((edge) => {
        const handle = document.createElement("div");
        handle.className = `loopnote-resize-handle ${edge}`;
        handle.setAttribute("aria-hidden", "true");
        handle.addEventListener("pointerdown", (event) => this.startResize(event, edge));
        return handle;
      });
    }

    iconButton(label, title) {
      const button = document.createElement("button");
      button.className = "loopnote-icon-button";
      button.type = "button";
      button.title = title;
      button.setAttribute("aria-label", title);
      button.textContent = label;
      return button;
    }

    createGreeting() {
      const greeting = document.createElement("div");
      greeting.className = "loopnote-greeting";
      greeting.textContent = "Enjoy Your Accelerated Workflow";
      return greeting;
    }

    createSetup() {
      const setup = document.createElement("section");
      setup.className = "loopnote-setup";

      const card = document.createElement("div");
      card.className = "loopnote-setup-card";

      const title = document.createElement("h1");
      title.className = "loopnote-setup-title";
      title.textContent = "Welcome to LoopNote";

      const text = document.createElement("p");
      text.className = "loopnote-setup-text";
      text.textContent = "LoopNote runs entirely inside your browser.\n\nYour API key stays on your device and is only sent\ndirectly to Groq.";

      const link = document.createElement("a");
      link.className = "loopnote-setup-link";
      link.href = "https://console.groq.com";
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = "Get a free API key";

      const input = document.createElement("input");
      input.className = "loopnote-key-input";
      input.type = "password";
      input.autocomplete = "off";
      input.spellcheck = false;
      input.placeholder = "Paste your Groq API key";

      const save = document.createElement("button");
      save.className = "loopnote-key-save";
      save.type = "button";
      save.textContent = "Save key";

      this.statusEl = document.createElement("div");
      this.statusEl.className = "loopnote-status";

      save.addEventListener("click", async () => {
        const key = input.value.trim();
        if (!key) {
          this.showStatus("Enter your Groq API key to continue.");
          return;
        }
        save.disabled = true;
        const saved = await this.storageSet({ [STORAGE_KEYS.apiKey]: key });
        save.disabled = false;
        if (!saved) return;
        this.apiKey = key;
        this.remount();
      });

      input.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          save.click();
        }
      });

      card.append(title, text, link, input, save, this.statusEl);
      setup.appendChild(card);
      return setup;
    }

    createComposer() {
      const composer = document.createElement("div");
      composer.className = "loopnote-composer";

      const wrap = document.createElement("div");
      wrap.className = "loopnote-input-wrap";

      this.inputEl = document.createElement("textarea");
      this.inputEl.className = "loopnote-input";
      this.inputEl.rows = 1;
      this.inputEl.placeholder = "ask a quick question...";
      this.inputEl.spellcheck = true;

      this.sendButton = document.createElement("button");
      this.sendButton.className = "loopnote-send";
      this.sendButton.type = "button";
      this.sendButton.title = "Send";
      this.sendButton.setAttribute("aria-label", "Send");
      this.sendButton.textContent = "→";

      this.inputEl.addEventListener("input", () => this.autoResizeInput());
      this.inputEl.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" || event.shiftKey) return;
        event.preventDefault();
        this.sendMessage();
      });
      this.sendButton.addEventListener("click", () => this.sendMessage());

      wrap.append(this.inputEl, this.sendButton);
      composer.appendChild(wrap);
      return composer;
    }

    remount() {
      if (this.root) this.root.remove();
      this.root = null;
      this.chatEl = null;
      this.inputEl = null;
      this.sendButton = null;
      this.panelEl = null;
      this.statusEl = null;
      this.render();
      this.keepInViewport();
    }

    renderConversation() {
      if (!this.chatEl) return;
      this.chatEl.replaceChildren();

      if (!this.conversation.length) {
        const empty = document.createElement("div");
        empty.className = "loopnote-empty";
        empty.textContent = "ask anything...";
        this.chatEl.appendChild(empty);
        return;
      }

      for (const message of this.conversation) {
        if (message.role === "system") continue;
        this.chatEl.appendChild(this.createMessageRow(message));
      }
      this.scrollToBottom();
    }

    createMessageRow(message) {
      const row = document.createElement("div");
      row.className = `loopnote-message-row ${message.role === "user" ? "user" : message.role === "error" ? "error" : "assistant"}`;

      const bubble = document.createElement("div");
      bubble.className = `loopnote-message ${message.role === "user" ? "user" : message.role === "error" ? "error" : "assistant"}`;
      const content = document.createElement("div");
      content.textContent = message.content || "";
      bubble.appendChild(content);

      if (message.role === "assistant") {
        const save = document.createElement("button");
        save.className = "loopnote-save-insight";
        save.type = "button";
        save.textContent = "Save Insight";
        save.addEventListener("click", async () => {
          await this.saveInsight(message.content || "");
          save.textContent = "Saved";
          save.disabled = true;
        });
        bubble.appendChild(save);
      }

      row.appendChild(bubble);
      return row;
    }

    renderLoading() {
      if (!this.chatEl) return null;
      const row = document.createElement("div");
      row.className = "loopnote-message-row assistant";
      row.setAttribute("data-loopnote-loading", "true");

      const dots = document.createElement("div");
      dots.className = "loopnote-dots";
      for (let i = 0; i < 3; i += 1) {
        const dot = document.createElement("span");
        dot.className = "loopnote-dot";
        dots.appendChild(dot);
      }
      row.appendChild(dots);
      this.chatEl.appendChild(row);
      this.scrollToBottom();
      return row;
    }

    async sendMessage() {
      if (this.isRequesting || !this.inputEl || !this.sendButton) return;
      const question = this.inputEl.value.trim();
      if (!question) return;

      this.isRequesting = true;
      this.inputEl.disabled = true;
      this.sendButton.disabled = true;
      this.inputEl.value = "";
      this.autoResizeInput();

      this.conversation.push({ role: "user", content: question });
      this.renderConversation();
      const loading = this.renderLoading();

      let assistantText = "";
      try {
        assistantText = await this.fetchCompletion(question);
        this.conversation.push({ role: "assistant", content: assistantText });
        await this.saveHistory(question, assistantText);
      } catch (error) {
        this.conversation.push({
          role: "error",
          content: error && error.message ? error.message : "Something went wrong. Please try again."
        });
      } finally {
        if (loading) loading.remove();
        this.isRequesting = false;
        this.inputEl.disabled = false;
        this.sendButton.disabled = false;
        this.renderConversation();
        this.inputEl.focus();
      }
    }

    async fetchCompletion(question) {
      const messages = [
        { role: "system", content: SYSTEM_PROMPT },
        ...this.conversation
          .filter((message) => message.role === "user" || message.role === "assistant")
          .slice(-MAX_CONVERSATION_MESSAGES)
      ];

      try {
        const result = await this.bridge("groq:request", {
          payload: {
            apiKey: this.apiKey,
            body: {
            model: GROQ_MODEL,
            messages,
            temperature: 0.35,
            max_tokens: 550
            }
          }
        });

        if (!result.ok) {
          throw new Error(result.message || "Groq request failed. Please try again.");
        }

        const data = result.data;
        const content = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
        return typeof content === "string" && content.trim() ? content.trim() : "No response returned. Please try again.";
      } catch (error) {
        throw new Error(error && error.message ? error.message : "Network error. Please try again.");
      }
    }

    async saveHistory(question, answer) {
      const entry = {
        id: this.activeHistoryId || crypto.randomUUID(),
        question,
        timestamp: new Date().toISOString(),
        preview: answer.slice(0, 180),
        conversation: this.conversation
          .filter((message) => message.role === "user" || message.role === "assistant")
          .slice(-MAX_CONVERSATION_MESSAGES)
      };

      const next = this.history.filter((item) => item.id !== entry.id);
      next.unshift(entry);
      this.history = next.slice(0, MAX_HISTORY);
      this.activeHistoryId = entry.id;
      await this.storageSet({ [STORAGE_KEYS.history]: this.history });
    }

    async saveInsight(content) {
      if (!content.trim()) return;
      await this.saveNote(content, "assistant");
    }

    async saveNote(content, source) {
      const note = {
        id: crypto.randomUUID(),
        content: content.trim(),
        timestamp: new Date().toISOString(),
        source: source || "manual"
      };
      this.notes.unshift(note);
      await this.storageSet({ [STORAGE_KEYS.notes]: this.notes });
      if (this.panelEl && this.activeTab === "notes") this.renderNotes();
    }

    downloadConversation() {
      if (!this.conversation.length) return;
      const now = new Date();
      const stamp = this.formatFilenameDate(now);
      const lines = ["# LoopNote Conversation", "", `_Exported: ${now.toLocaleString()}_`, ""];

      for (const message of this.conversation) {
        if (message.role === "user") {
          lines.push("**You:**", this.escapeMarkdown(message.content), "");
        } else if (message.role === "assistant") {
          lines.push("**LoopNote:**", this.escapeMarkdown(message.content), "", "---", "");
        }
      }

      const blob = new Blob([lines.join("\n")], { type: "text/markdown;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `loopnote-${stamp}.md`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    toggleSidebar() {
      this.isCollapsed = !this.isCollapsed;
      if (this.root) this.root.classList.toggle("loopnote-collapsed", this.isCollapsed);
      if (!this.isCollapsed) this.keepInViewport();
      this.syncLayout();
    }

    togglePanel() {
      if (this.panelEl) {
        this.panelEl.remove();
        this.panelEl = null;
        return;
      }
      this.panelEl = this.createPanel();
      this.root.appendChild(this.panelEl);
      if (this.activeTab === "questions") {
        this.renderQuestions();
      } else {
        this.renderNotes();
      }
    }

    createPanel() {
      const panel = document.createElement("section");
      panel.className = "loopnote-panel";

      const head = document.createElement("div");
      head.className = "loopnote-panel-head";

      const tabs = document.createElement("div");
      tabs.className = "loopnote-tabs";

      const questions = document.createElement("button");
      questions.className = "loopnote-tab";
      questions.type = "button";
      questions.textContent = "Questions";
      questions.addEventListener("click", () => {
        this.activeTab = "questions";
        this.renderQuestions();
      });

      const notes = document.createElement("button");
      notes.className = "loopnote-tab";
      notes.type = "button";
      notes.textContent = "Notes";
      notes.addEventListener("click", () => {
        this.activeTab = "notes";
        this.renderNotes();
      });

      const close = this.iconButton("✕", "Close");
      close.addEventListener("click", () => this.togglePanel());

      tabs.append(questions, notes);
      head.append(tabs, close);

      const list = document.createElement("div");
      list.className = "loopnote-list";

      panel.append(head, list);
      return panel;
    }

    renderQuestions() {
      if (!this.panelEl) return;
      this.activeTab = "questions";
      this.updateTabs();
      const list = this.panelEl.querySelector(".loopnote-list");
      list.replaceChildren();

      if (!this.history.length) {
        list.appendChild(this.emptyList("No questions yet."));
        return;
      }

      for (const item of this.history) {
        list.appendChild(this.createListItem(item.question, item.timestamp, () => {
          this.conversation = Array.isArray(item.conversation) ? item.conversation.slice() : [];
          this.activeHistoryId = item.id;
          this.togglePanel();
          this.renderConversation();
        }, async () => {
          this.history = this.history.filter((entry) => entry.id !== item.id);
          if (this.activeHistoryId === item.id) this.activeHistoryId = null;
          await this.storageSet({ [STORAGE_KEYS.history]: this.history });
          this.renderQuestions();
        }));
      }
    }

    renderNotes() {
      if (!this.panelEl) return;
      this.activeTab = "notes";
      this.updateTabs();
      const list = this.panelEl.querySelector(".loopnote-list");
      list.replaceChildren();

      if (!this.notes.length) {
        list.appendChild(this.emptyList("No notes saved yet."));
      } else {
        for (const note of this.notes) {
          const title = `${note.source === "assistant" ? "Insight" : "Note"}: ${note.content}`;
          list.appendChild(this.createListItem(title, note.timestamp, () => {
            this.conversation.push({ role: "assistant", content: note.content });
            this.togglePanel();
            this.renderConversation();
          }, async () => {
            this.notes = this.notes.filter((entry) => entry.id !== note.id);
            await this.storageSet({ [STORAGE_KEYS.notes]: this.notes });
            this.renderNotes();
          }));
        }
      }

      const form = document.createElement("div");
      form.className = "loopnote-note-form";

      const textarea = document.createElement("textarea");
      textarea.className = "loopnote-note-input";
      textarea.placeholder = "Write a note...";

      const save = document.createElement("button");
      save.className = "loopnote-note-save";
      save.type = "button";
      save.textContent = "Save note";
      save.addEventListener("click", async () => {
        const content = textarea.value.trim();
        if (!content) return;
        save.disabled = true;
        await this.saveNote(content, "manual");
        textarea.value = "";
        save.disabled = false;
      });

      form.append(textarea, save);
      this.panelEl.appendChild(form);
    }

    updateTabs() {
      const tabs = this.panelEl ? this.panelEl.querySelectorAll(".loopnote-tab") : [];
      tabs.forEach((tab) => {
        tab.classList.toggle("active", tab.textContent.toLowerCase() === this.activeTab);
      });
      const oldForm = this.panelEl ? this.panelEl.querySelector(".loopnote-note-form") : null;
      if (oldForm) oldForm.remove();
    }

    createListItem(titleText, timestamp, onOpen, onDelete) {
      const item = document.createElement("div");
      item.className = "loopnote-item";

      const button = document.createElement("button");
      button.type = "button";
      button.style.display = "block";
      button.style.width = "100%";
      button.style.textAlign = "left";
      button.addEventListener("click", onOpen);

      const title = document.createElement("div");
      title.className = "loopnote-item-title";
      title.textContent = titleText || "Untitled";

      const meta = document.createElement("div");
      meta.className = "loopnote-item-meta";
      meta.textContent = this.formatDate(timestamp);

      const del = document.createElement("button");
      del.className = "loopnote-delete";
      del.type = "button";
      del.title = "Delete";
      del.setAttribute("aria-label", "Delete");
      del.textContent = "✕";
      del.addEventListener("click", (event) => {
        event.stopPropagation();
        onDelete();
      });

      button.append(title, meta);
      item.append(button, del);
      return item;
    }

    emptyList(text) {
      const empty = document.createElement("div");
      empty.className = "loopnote-list-empty";
      empty.textContent = text;
      return empty;
    }

    autoResizeInput() {
      if (!this.inputEl) return;
      this.inputEl.style.height = "auto";
      this.inputEl.style.height = `${Math.min(this.inputEl.scrollHeight, 88)}px`;
    }

    scrollToBottom() {
      if (!this.chatEl) return;
      requestAnimationFrame(() => {
        this.chatEl.scrollTop = this.chatEl.scrollHeight;
      });
    }

    syncLayout() {
      this.bridge("layout", { width: 0, isOpen: false }).catch(() => {});
    }

    startDrag(event) {
      if (this.isCollapsed || event.button !== 0 || event.target.closest("button, input, textarea, a")) return;
      const rect = this.root.getBoundingClientRect();
      this.x = rect.left;
      this.y = rect.top;
      this.dragState = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        x: this.x,
        y: this.y
      };
      this.root.classList.add("loopnote-dragging");
      this.capturePointer(event.pointerId);
      window.addEventListener("pointermove", this.handleDragMove);
      window.addEventListener("pointerup", this.finishDrag);
      window.addEventListener("pointercancel", this.finishDrag);
    }

    handleDragMove = (event) => {
      if (!this.dragState || event.pointerId !== this.dragState.pointerId) return;
      const nextX = this.dragState.x + event.clientX - this.dragState.startX;
      const nextY = this.dragState.y + event.clientY - this.dragState.startY;
      this.scheduleGeometryUpdate(() => {
        this.x = this.clampX(nextX, this.width);
        this.y = this.clampY(nextY, this.height);
        this.applyGeometryStyles();
      });
    };

    finishDrag = async (event) => {
      if (!this.dragState || event.pointerId !== this.dragState.pointerId) return;
      this.releasePointer(event.pointerId);
      this.root.classList.remove("loopnote-dragging");
      window.removeEventListener("pointermove", this.handleDragMove);
      window.removeEventListener("pointerup", this.finishDrag);
      window.removeEventListener("pointercancel", this.finishDrag);
      this.dragState = null;
      await this.persistGeometry();
    };

    startResize(event, edge) {
      if (this.isCollapsed || event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      const rect = this.root.getBoundingClientRect();
      this.x = rect.left;
      this.y = rect.top;
      this.resizeState = {
        edge,
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        x: rect.left,
        y: rect.top,
        width: rect.width,
        height: rect.height
      };
      this.root.classList.add("loopnote-resizing");
      this.capturePointer(event.pointerId);
      window.addEventListener("pointermove", this.handleResizeMove);
      window.addEventListener("pointerup", this.finishResize);
      window.addEventListener("pointercancel", this.finishResize);
    }

    handleResizeMove = (event) => {
      if (!this.resizeState || event.pointerId !== this.resizeState.pointerId) return;
      const state = this.resizeState;
      const deltaX = event.clientX - state.startX;
      const deltaY = event.clientY - state.startY;

      this.scheduleGeometryUpdate(() => {
        let nextX = state.x;
        let nextY = state.y;
        let nextWidth = state.width;
        let nextHeight = state.height;

        if (state.edge === "right" || state.edge === "corner") {
          nextWidth = state.width + deltaX;
        }

        if (state.edge === "left") {
          nextWidth = state.width - deltaX;
          nextX = state.x + deltaX;
        }

        if (state.edge === "bottom" || state.edge === "corner") {
          nextHeight = state.height + deltaY;
        }

        nextWidth = this.clampWidth(nextWidth);
        nextHeight = this.clampHeight(nextHeight);

        if (state.edge === "left") {
          nextX = state.x + state.width - nextWidth;
        }

        this.width = nextWidth;
        this.height = nextHeight;
        this.x = this.clampX(nextX, nextWidth);
        this.y = this.clampY(nextY, nextHeight);
        this.applyGeometryStyles();
      });
    };

    finishResize = async (event) => {
      if (!this.resizeState || event.pointerId !== this.resizeState.pointerId) return;
      this.releasePointer(event.pointerId);
      this.root.classList.remove("loopnote-resizing");
      window.removeEventListener("pointermove", this.handleResizeMove);
      window.removeEventListener("pointerup", this.finishResize);
      window.removeEventListener("pointercancel", this.finishResize);
      this.resizeState = null;
      await this.persistGeometry();
    };

    capturePointer(pointerId) {
      try {
        this.root.setPointerCapture(pointerId);
      } catch (error) {
        return false;
      }
      return true;
    }

    releasePointer(pointerId) {
      try {
        this.root.releasePointerCapture(pointerId);
      } catch (error) {
        return false;
      }
      return true;
    }

    scheduleGeometryUpdate(update) {
      if (this.frameRequest) cancelAnimationFrame(this.frameRequest);
      this.frameRequest = requestAnimationFrame(() => {
        this.frameRequest = 0;
        update();
      });
    }

    async persistGeometry() {
      await this.storageSet({
        [STORAGE_KEYS.width]: Math.round(this.width),
        [STORAGE_KEYS.height]: Math.round(this.height),
        [STORAGE_KEYS.x]: Math.round(this.x),
        [STORAGE_KEYS.y]: Math.round(this.y)
      });
    }

    keepInViewport() {
      if (!this.root || this.isCollapsed) return;
      const rect = this.root.getBoundingClientRect();
      this.width = this.clampWidth(this.width || rect.width);
      this.height = this.clampHeight(this.height || rect.height);
      if (this.x === null) {
        this.x = window.innerWidth - this.width - 24;
      }
      this.x = this.clampX(this.x, this.width);
      this.y = this.clampY(this.y, this.height);
      this.applyGeometryStyles();
    }

    applyGeometryStyles() {
      if (!this.root) return;
      this.root.style.setProperty("--loopnote-width", `${Math.round(this.width)}px`);
      this.root.style.setProperty("--loopnote-height", `${Math.round(this.height)}px`);
      if (this.x !== null) {
        this.root.style.left = `${Math.round(this.x)}px`;
        this.root.style.right = "auto";
      }
      this.root.style.top = `${Math.round(this.y)}px`;
      this.root.style.bottom = "auto";
    }

    clampWidth(width) {
      const viewportMax = Math.max(MIN_WIDTH, window.innerWidth - VIEWPORT_MARGIN * 2);
      return Math.min(Math.max(width, MIN_WIDTH), Math.min(MAX_WIDTH, viewportMax));
    }

    clampHeight(height) {
      const viewportMax = Math.max(MIN_HEIGHT, Math.floor(window.innerHeight * 0.8));
      return Math.min(Math.max(height, MIN_HEIGHT), viewportMax);
    }

    clampX(x, width) {
      const maxX = Math.max(VIEWPORT_MARGIN, window.innerWidth - width - VIEWPORT_MARGIN);
      return Math.min(Math.max(x, VIEWPORT_MARGIN), maxX);
    }

    clampY(y, height) {
      const maxY = Math.max(VIEWPORT_MARGIN, window.innerHeight - height - VIEWPORT_MARGIN);
      return Math.min(Math.max(y, VIEWPORT_MARGIN), maxY);
    }

    showStatus(message) {
      if (this.statusEl) this.statusEl.textContent = message;
    }

    formatDate(value) {
      const date = value ? new Date(value) : new Date();
      return date.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
    }

    formatFilenameDate(date) {
      const pad = (number) => String(number).padStart(2, "0");
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`;
    }

    escapeMarkdown(text) {
      return String(text || "").replace(/[\\`*_{}\[\]()#+\-.!|>]/g, "\\$&");
    }
  }

  const app = new LoopNote();
  app.init();
})();
