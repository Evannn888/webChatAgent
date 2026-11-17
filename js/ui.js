import { state } from './state.js';
import { TOKEN_PRICING, MODEL_OPTIONS } from './config.js';

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

// Safe for both text and attribute contexts (quotes are escaped too).
export function escHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}

// Price with the model that produced the message, not whichever model is selected now.
export function formatUsage(usage, modelId = state.currentModel.model) {
  const input = usage.input || 0;
  const output = usage.output || 0;
  const pricing = TOKEN_PRICING[modelId];
  let costStr = '';
  if (pricing) {
    const cost = (input * pricing.input + output * pricing.output) / 1_000_000;
    costStr = ` · $${cost < 0.01 ? cost.toFixed(4) : cost.toFixed(3)}`;
  }
  return `🪙 ${input}+${output} = ${input + output} tokens${costStr}`;
}

export function injectUsageBadge(msg) {
  const el = document.getElementById(msg.id);
  if (!el || !msg.usage) return;
  const existing = el.querySelector('.msg-usage');
  if (existing) existing.remove();
  const badge = document.createElement('div');
  badge.className = 'msg-usage';
  badge.textContent = formatUsage(msg.usage, msg.model);
  el.appendChild(badge);
}

const MARKED_OPTIONS = { gfm: true, breaks: false };

export function renderMarkdown(text, options = {}) {
  // Model output is untrusted; never render it as HTML without the sanitizer.
  if (typeof marked === 'undefined' || typeof DOMPurify === 'undefined') return escHtml(text);
  try {
    // Hide code (fenced and inline) while splitting on <think> tags so a literal
    // "<think>" inside code isn't treated as a reasoning block. The code is put
    // back before each segment is parsed, so marked still renders it as code.
    const codeBlocks = [];
    const protectedText = text.replace(/```[\s\S]*?(?:```|$)|`[^`\n]+`/g, (match) => {
      codeBlocks.push(match);
      return `\x00CODE_BLOCK_${codeBlocks.length - 1}\x00`;
    });
    const parse = (segment) => marked.parse(
      segment.replace(/\x00CODE_BLOCK_(\d+)\x00/g, (_, idx) => codeBlocks[Number(idx)]),
      MARKED_OPTIONS,
    );

    let html = '';
    let remaining = protectedText;
    while (remaining.length > 0) {
      const openIdx = remaining.indexOf('<think>');
      if (openIdx === -1) { html += parse(remaining); break; }
      if (openIdx > 0) html += parse(remaining.slice(0, openIdx));
      const closeIdx = remaining.indexOf('</think>', openIdx + 7);
      const thinkContent = (closeIdx === -1 ? remaining.slice(openIdx + 7) : remaining.slice(openIdx + 7, closeIdx)).trim();
      html += '<details class="think-block" open><summary>Thinking Process</summary><div class="think-content">'
        + (thinkContent ? parse(thinkContent) : '') + '</div></details>';
      if (closeIdx === -1) break;
      remaining = remaining.slice(closeIdx + 8);
    }

    const container = document.createElement('div');
    container.innerHTML = DOMPurify.sanitize(html);
    // Syntax highlighting only for the final render (too costly on every streaming tick).
    if (!options.isStreaming && typeof hljs !== 'undefined') {
      container.querySelectorAll('pre code').forEach((el) => {
        try { hljs.highlightElement(el); } catch { /* unknown language: leave as plain code */ }
      });
    }
    return container.innerHTML;
  } catch { return escHtml(text); }
}

export function syncGenerating(v) {
  state.isGenerating = v;
  const sendBtn = document.getElementById('send-btn');
  const stopBtn = document.getElementById('stop-btn');
  if (v) {
    if (sendBtn) sendBtn.classList.add('hidden');
    if (stopBtn) stopBtn.classList.remove('hidden');
  } else {
    if (sendBtn) sendBtn.classList.remove('hidden');
    if (stopBtn) stopBtn.classList.add('hidden');
  }
}

export function renderAuth() {
  const area = document.getElementById('auth-area');
  if (!state.user) {
    area.innerHTML = '<button id="btn-login" class="btn btn-primary">Sign in</button>';
    document.getElementById('btn-login').onclick = () => document.dispatchEvent(new CustomEvent('auth-login'));
  } else {
    area.innerHTML = `<div class="auth-user">
      ${state.user.image ? `<img src="${escHtml(state.user.image)}" alt="" class="avatar">` : ''}
      ${state.user.name ? `<span class="user-name">${escHtml(state.user.name)}</span>` : ''}
      <button id="btn-logout" class="btn-text logout-btn">Logout</button>
    </div>`;
    document.getElementById('btn-logout').onclick = () => document.dispatchEvent(new CustomEvent('auth-logout'));
  }
}

export function renderSessions() {
  const list = document.getElementById('session-list');
  if (state.sessions.length === 0) {
    const msg = state.lastSearchQuery ? 'No matching chats' : 'No recent chats';
    list.innerHTML = `<div class="session-empty">${msg}</div>`;
    return;
  }
  list.innerHTML = state.sessions.map(s => `
    <div class="session-item ${s.id === state.currentSessionId ? 'active' : ''}" data-id="${s.id}">
      <div class="session-title">${escHtml(s.title || 'New Chat')}</div>
      <button class="session-del" title="Delete Chat" data-id="${s.id}">✕</button>
    </div>`).join('');
}

// ── Incremental DOM Rendering ──────────────────────────────

function createMessageEl(msg) {
  const isUser = msg.role === 'user';
  const div = document.createElement('div');
  div.className = `msg-row ${isUser ? 'msg-user' : 'msg-assistant'}`;
  div.id = msg.id;

  const label = document.createElement('div');
  label.className = 'msg-label';
  label.textContent = isUser ? 'You' : 'Assistant';
  div.appendChild(label);

  const bubble = document.createElement('div');
  bubble.className = isUser ? 'bubble-user' : 'bubble-assistant';

  // File attachments
  if (msg.files?.length) {
    const filesDiv = document.createElement('div');
    filesDiv.className = 'msg-files';
    filesDiv.innerHTML = msg.files.map(f => `<span class="file-tag">📎 ${escHtml(f.name)}</span>`).join('');
    bubble.appendChild(filesDiv);
  }

  // Content
  const contentDiv = document.createElement('div');
  contentDiv.id = `content-${msg.id}`;
  if (!isUser) contentDiv.className = 'md-content';

  const cleanContent = (msg.displayContent || msg.content) ? (msg.displayContent || msg.content).replace(/<\|usage:[^|]+\|>/g, '') : '';
  if (cleanContent) {
    contentDiv.innerHTML = isUser ? escHtml(cleanContent) : (msg.renderedHtml || renderMarkdown(cleanContent));
  } else if (!isUser) {
    contentDiv.innerHTML = '<span class="placeholder-text">…</span>';
  }
  bubble.appendChild(contentDiv);
  div.appendChild(bubble);

  // Usage badge
  if (msg.usage && msg.usage.input > 0) {
    const usage = document.createElement('div');
    usage.className = 'msg-usage';
    usage.textContent = formatUsage(msg.usage, msg.model);
    div.appendChild(usage);
  }

  return div;
}

export function appendMessage(msg) {
  const container = document.getElementById('chat-container');
  const empty = document.getElementById('empty-state');
  empty.classList.add('hidden');
  container.classList.remove('hidden');
  container.appendChild(createMessageEl(msg));
  container.scrollTo({ top: container.scrollHeight, behavior: 'smooth' });
}

function scheduleStreamRender(msg) {
  if (msg._streamRenderTimer) return;
  msg._streamRenderTimer = setTimeout(() => {
    msg._streamRenderTimer = null;
    if (!msg._isStreaming) return;
    const contentDiv = document.getElementById(`content-${msg.id}`);
    if (!contentDiv || !contentDiv.isConnected) return;
    contentDiv.innerHTML = renderMarkdown(msg.content, { isStreaming: true });
    msg._lastRenderedLength = msg.content.length;
  }, 200);
}

export function appendStreamingToken(msg, token) {
  msg.content = (msg.content || '') + token;
  msg._isStreaming = true;

  const contentDiv = document.getElementById(`content-${msg.id}`);
  if (!contentDiv) return;

  const placeholder = contentDiv.querySelector('.placeholder-text');
  if (placeholder) placeholder.remove();

  const renderedText = msg.content.slice(0, msg._lastRenderedLength || 0);
  const thinkOpen = renderedText.split('<think>').length - 1;
  const thinkClose = renderedText.split('</think>').length - 1;
  let targetContainer = contentDiv;
  
  if (thinkOpen > thinkClose) {
    const thinkContents = contentDiv.querySelectorAll('.think-content');
    if (thinkContents.length > 0) {
      targetContainer = thinkContents[thinkContents.length - 1];
    }
  }

  let existing = contentDiv.querySelector('.stream-text');
  if (existing && existing.parentNode !== targetContainer) {
    existing.remove();
    existing = null;
  }
  if (!existing) {
    existing = document.createElement('span');
    existing.className = 'stream-text';
    targetContainer.appendChild(existing);
  }
  
  // Display all tokens accumulated since the last markdown render
  existing.textContent = msg.content.slice(msg._lastRenderedLength || 0);

  const c = document.getElementById('chat-container');
  if (c) c.scrollTop = c.scrollHeight;

  scheduleStreamRender(msg);
}


export function cancelPendingRender(msg) {
  if (msg._streamRenderTimer) {
    clearTimeout(msg._streamRenderTimer);
    msg._streamRenderTimer = null;
  }
  msg._isStreaming = false;
}

export function showTypingIndicator() {
  removeTypingIndicator();
  const container = document.getElementById('chat-container');
  if (!container) return;
  const div = document.createElement('div');
  div.className = 'msg-row msg-assistant';
  div.id = 'typing-indicator';
  div.innerHTML = `
    <div class="msg-label">Assistant</div>
    <div class="bubble-assistant" style="opacity:0.85">
      <span style="font-size:0.85em;font-weight:600">🤔 Thinking</span>
      <span class="typing-dots">
        <span></span><span></span><span></span>
      </span>
    </div>`;
  container.appendChild(div);
  container.scrollTo({ top: container.scrollHeight, behavior: 'smooth' });
}

export function removeTypingIndicator() {
  const el = document.getElementById('typing-indicator');
  if (el) el.remove();
}

export function showChatError(errorText) {
  const container = document.getElementById('chat-container');
  if (!container) return;
  const div = document.createElement('div');
  div.className = 'msg-error';
  div.textContent = `⚠️ ${errorText}`;
  container.appendChild(div);
}

export function renderMessages() {
  const container = document.getElementById('chat-container');
  const empty = document.getElementById('empty-state');

  if (state.messages.length === 0) {
    container.classList.add('hidden');
    container.innerHTML = '';
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');
  container.classList.remove('hidden');

  // Drop elements for messages that are no longer in state (e.g. after the same
  // chat was reloaded with fresh message ids), otherwise they'd be duplicated.
  const wantedIds = new Set(state.messages.map((m) => m.id));
  const existingIds = new Set();
  for (const child of Array.from(container.children)) {
    if (child.classList.contains('msg-error')) {
      child.remove();
    } else if (child.id === 'typing-indicator') {
      if (!state.isGenerating) child.remove();
    } else if (!wantedIds.has(child.id)) {
      child.remove();
    } else {
      existingIds.add(child.id);
    }
  }

  for (const msg of state.messages) {
    if (!existingIds.has(msg.id)) {
      container.appendChild(createMessageEl(msg));
    }
  }

  if (state.isGenerating) {
    showTypingIndicator();
  }

  if (state.error) {
    showChatError(state.error);
  }

  container.scrollTo({ top: container.scrollHeight, behavior: 'smooth' });
}



let inputErrorTimer = null;
export function showInputError(msg) {
  const el = document.getElementById('input-error');
  el.textContent = msg;
  el.classList.remove('hidden');
  if (inputErrorTimer) clearTimeout(inputErrorTimer);
  inputErrorTimer = setTimeout(() => el.classList.add('hidden'), 5000);
}

export function updateSendBtn() {
  const input = document.getElementById('msg-input');
  const btn = document.getElementById('send-btn');
  btn.disabled = (!input.value.trim() && state.files.length === 0) || state.isGenerating;
}

export function adjustHeight() {
  const input = document.getElementById('msg-input');
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 160) + 'px';
  updateSendBtn();
}

export function renderFilePreview() {
  const preview = document.getElementById('file-preview');
  if (state.files.length === 0) { preview.classList.add('hidden'); return; }
  preview.innerHTML = state.files.map((f, i) => `
    <div class="file-preview-item">
      <span class="file-name">${escHtml(f.name)}</span>
      <button class="file-remove-btn" data-idx="${i}">✕</button>
    </div>
  `).join('');
  preview.classList.remove('hidden');
}

export function toggleSidebar() {
  const sidebar = document.getElementById('sidebar');
  const backdrop = document.getElementById('sidebar-backdrop');
  sidebar.classList.toggle('sidebar-hidden');
  if (backdrop) {
    backdrop.classList.toggle('active', !sidebar.classList.contains('sidebar-hidden'));
  }
}

export function toggleTheme() {
  const isDark = document.documentElement.classList.toggle('dark');
  document.getElementById('theme-btn').textContent = isDark ? '🌙' : '☀️';
  localStorage.setItem('theme', isDark ? 'dark' : 'light');
}

export function toggleModelMenu() {
  const dd = document.getElementById('model-dropdown');
  if (!dd) return;
  const isHidden = dd.classList.contains('hidden');
  if (isHidden) {
    dd.innerHTML = '';
    MODEL_OPTIONS.forEach(m => {
      const isSelected = m.model === state.currentModel.model;
      const btn = document.createElement('button');
      btn.className = `dropdown-item${isSelected ? ' active' : ''}`;
      btn.onclick = function(e) {
        e.stopPropagation();
        selectModel(m.model);
      };
      const label = document.createElement('span');
      label.className = 'dropdown-label';
      label.textContent = m.label;
      const provider = document.createElement('span');
      provider.className = 'dropdown-meta';
      provider.textContent = m.provider;
      if (isSelected) {
        const check = document.createElement('span');
        check.textContent = ' ✓';
        check.style.color = 'var(--accent-text)';
        check.style.fontSize = '0.8rem';
        check.style.marginLeft = '6px';
        provider.appendChild(check);
      }
      btn.appendChild(label);
      btn.appendChild(provider);
      dd.appendChild(btn);
    });
    dd.classList.remove('hidden');
  } else {
    dd.classList.add('hidden');
  }
}

export function closeModelMenu() {
  const dd = document.getElementById('model-dropdown');
  if (dd) dd.classList.add('hidden');
}

export function selectModel(modelId) {
  const m = MODEL_OPTIONS.find(m => m.model === modelId);
  if (m && m.model !== state.currentModel.model) {
    state.currentModel = m;
    document.getElementById('model-label').textContent = state.currentModel.label;
    // app.js saves the choice for the open chat.
    document.dispatchEvent(new CustomEvent('modelSelected', { detail: m.model }));
  }
  closeModelMenu();
}

export function handleInputKeydown(e) {
  // Enter while an IME is composing (Chinese/Japanese/Korean input) only confirms
  // the composition; it must not send the half-typed message.
  if (e.isComposing || e.keyCode === 229) return;
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    import('./chat.js').then(({handleSend}) => handleSend());
  }
}

// marked.setOptions is removed; options are passed to marked.parse()

