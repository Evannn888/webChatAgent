import { state } from './state.js?v=2';
import { TOKEN_PRICING, MODEL_OPTIONS } from './config.js?v=2';
import { login, logout } from './api.js?v=2';

export function escHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

export function formatUsage(usage) {
  const total = (usage.input || 0) + (usage.output || 0);
  const pricing = TOKEN_PRICING[state.currentModel.model];
  let costStr = '';
  if (pricing) {
    const cost = (usage.input * pricing.input + (usage.output || 0) * pricing.output) / 1_000_000;
    costStr = ` · $${cost < 0.01 ? cost.toFixed(4) : cost.toFixed(3)}`;
  }
  return `🪙 ${usage.input}+${usage.output || 0} = ${total} tokens${costStr}`;
}

export function injectUsageBadge(msg) {
  const el = document.getElementById(msg.id);
  if (!el || !msg.usage) return;
  const existing = el.querySelector('.msg-usage');
  if (existing) existing.remove();
  const badge = document.createElement('div');
  badge.className = 'msg-usage';
  badge.textContent = formatUsage(msg.usage);
  el.appendChild(badge);
}

export function renderMarkdown(text) {
  try {
    let result = '', remaining = text;
    while (remaining.length > 0) {
      const openIdx = remaining.indexOf('<think>');
      if (openIdx === -1) { result += marked.parse(remaining); break; }
      if (openIdx > 0) result += marked.parse(remaining.slice(0, openIdx));
      const closeIdx = remaining.indexOf('</think>', openIdx + 7);
      const thinkContent = closeIdx === -1 ? remaining.slice(openIdx + 7) : remaining.slice(openIdx + 7, closeIdx);
      let rendered = '';
      if (thinkContent.trim()) {
        try { rendered = marked.parse(thinkContent.trim()); } catch { rendered = escHtml(thinkContent.trim()); }
      }
      result += '<details class="think-block" open><summary>Thinking Process</summary><div class="think-content">' + rendered + '</div></details>';
      if (closeIdx === -1) break;
      remaining = remaining.slice(closeIdx + 8);
    }
    return result;
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
    area.innerHTML = '<button id="btn-login" class="btn-primary">Sign in</button>';
    document.getElementById('btn-login').onclick = login;
  } else {
    area.innerHTML = `<div class="auth-user">
      ${state.user.image ? `<img src="${escHtml(state.user.image)}" alt="" class="avatar">` : ''}
      ${state.user.name ? `<span class="user-name">${escHtml(state.user.name)}</span>` : ''}
      <button id="btn-logout" class="btn-text logout-btn">Logout</button>
    </div>`;
    document.getElementById('btn-logout').onclick = logout;
  }
}

export function renderSessions() {
  const list = document.getElementById('session-list');
  if (state.sessions.length === 0) {
    list.innerHTML = '<div class="session-empty">No recent chats</div>';
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
    usage.textContent = formatUsage(msg.usage);
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

export function updateMessageContent(msg) {
  const contentDiv = document.getElementById(`content-${msg.id}`);
  if (!contentDiv) return;

  if (msg._renderFrameRequested) return;

  const now = performance.now();
  if (msg._lastRenderTime && now - msg._lastRenderTime < 50) {
    if (!msg._renderTimer) {
      msg._renderTimer = setTimeout(() => {
        msg._renderTimer = null;
        updateMessageContent(msg);
      }, 50 - (now - msg._lastRenderTime));
    }
    return;
  }

  msg._renderFrameRequested = true;
  requestAnimationFrame(() => {
    msg._renderFrameRequested = false;
    msg._lastRenderTime = performance.now();
    if (contentDiv.isConnected && msg.content) {
      contentDiv.innerHTML = renderMarkdown(msg.content);
      const c = document.getElementById('chat-container');
      if (c) c.scrollTop = c.scrollHeight;
    }
  });
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
  container.innerHTML = '';

  for (const msg of state.messages) {
    container.appendChild(createMessageEl(msg));
  }

  if (state.isGenerating) {
    showTypingIndicator();
  }

  if (state.error) {
    showChatError(state.error);
  }

  container.scrollTo({ top: container.scrollHeight, behavior: 'smooth' });
}

// Keep old name as alias for progressive display
export function startProgressiveDisplay(msg) {
  updateMessageContent(msg);
}

export function showInputError(msg) {
  const el = document.getElementById('input-error');
  el.textContent = msg;
  el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), 5000);
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
  if (m) {
    state.currentModel = m;
    document.getElementById('model-label').textContent = state.currentModel.label;
  }
  closeModelMenu();
}

export function handleInputKeydown(e) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    import('./chat.js').then(({handleSend}) => handleSend());
  }
}

// Setup marked
if (typeof marked !== 'undefined') {
  marked.setOptions({
    gfm: true, breaks: false,
    highlight(code, lang) {
      if (typeof hljs !== 'undefined' && lang && hljs.getLanguage(lang)) return hljs.highlight(code, { language: lang }).value;
      if (typeof hljs !== 'undefined') return hljs.highlightAuto(code).value;
      return code;
    },
  });
}
