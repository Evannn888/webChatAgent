import { state } from './state.js';
import { TOKEN_PRICING, MODEL_OPTIONS } from './config.js';
import { login, logout } from './api.js';

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
  badge.className = 'msg-usage ml-3 mt-1 text-[0.7rem] opacity-70';
  badge.style.color = 'var(--muted)';
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
    area.innerHTML = '<button id="btn-login" class="px-4 py-2 rounded-lg bg-gradient-to-br from-indigo-600 to-purple-400 text-white font-medium cursor-pointer border-0 hover:opacity-90 transition-all">Sign in</button>';
    document.getElementById('btn-login').onclick = login;
  } else {
    area.innerHTML = `<div class="flex items-center gap-2">
      ${state.user.image ? `<img src="${escHtml(state.user.image)}" alt="" class="w-7 h-7 rounded-full">` : ''}
      ${state.user.name ? `<span class="max-sm:hidden text-sm font-medium" style="color:var(--text)">${escHtml(state.user.name)}</span>` : ''}
      <button id="btn-logout" class="max-sm:hidden px-3 py-2 rounded-lg bg-transparent border-0 cursor-pointer text-sm" style="color:var(--text)">Logout</button>
    </div>`;
    document.getElementById('btn-logout').onclick = logout;
  }
}

export function renderSessions() {
  const list = document.getElementById('session-list');
  if (state.sessions.length === 0) {
    list.innerHTML = '<div class="p-4 text-sm text-center" style="color:var(--muted)">No recent chats</div>';
    return;
  }
  list.innerHTML = state.sessions.map(s => `
    <div class="session-item flex items-center justify-between px-4 py-3 border-b cursor-pointer whitespace-nowrap overflow-hidden text-ellipsis text-sm transition-colors ${s.id === state.currentSessionId ? 'bg-indigo-600/15 !text-white border-l-[3px] border-l-indigo-600' : ''}" style="color:var(--text2)" data-id="${s.id}">
      <div class="flex-1 overflow-hidden text-ellipsis pointer-events-none">${escHtml(s.title || 'New Chat')}</div>
      <button class="session-del p-1 bg-transparent border-0 cursor-pointer" style="color:var(--muted)" title="Delete Chat" data-id="${s.id}">✕</button>
    </div>`).join('');
}

export function renderMessages() {
  const container = document.getElementById('chat-container');
  const empty = document.getElementById('empty-state');

  if (state.messages.length === 0) {
    container.classList.add('hidden'); empty.classList.remove('hidden'); return;
  }
  empty.classList.add('hidden'); container.classList.remove('hidden');

  container.innerHTML = state.messages.map(msg => {
    const isUser = msg.role === 'user';
    const align = isUser ? 'items-end' : 'items-start';
    const label = isUser ? 'You' : 'Assistant';
    const labelColor = isUser ? 'mr-3' : 'ml-3';
    const labelStyle = isUser ? 'color:#a29bfe' : 'color:var(--muted)';
    const bubble = isUser
      ? 'bg-gradient-to-br from-indigo-600 to-purple-400 text-white rounded-[18px_18px_4px_18px] px-[18px] py-[10px]'
      : 'rounded-[18px_18px_18px_4px] px-5 py-[14px]';
    const filesHtml = msg.files?.length
      ? `<div class="flex gap-1.5 flex-wrap mb-2 opacity-80 text-xs">${msg.files.map(f => `<span class="px-2 py-0.5 bg-white/10 rounded">📎 ${escHtml(f.name)}</span>`).join('')}</div>`
      : '';
    const cleanContent = (msg.displayContent || msg.content) ? (msg.displayContent || msg.content).replace(/<\|usage:[^|]+\|>/g, '') : '';
    const content = cleanContent
      ? (isUser ? escHtml(cleanContent) : (msg.renderedHtml || renderMarkdown(cleanContent)))
      : (isUser ? '' : '<span class="opacity-40">…</span>');
    const usageHtml = msg.usage && msg.usage.input > 0
      ? `<div class="msg-usage ml-3 mt-1 text-[0.7rem] opacity-70" style="color:var(--muted)">${formatUsage(msg.usage)}</div>`
      : '';

    return `<div class="flex flex-col mb-4 animate-slide-up ${align}" id="${msg.id}">
      <div class="text-[0.7rem] font-semibold uppercase tracking-wider mb-1 ${labelColor}" style="${labelStyle}">${label}</div>
      <div class="max-w-[75%] max-sm:max-w-[88%] text-[0.925rem] break-words ${bubble} ${isUser ? '' : 'bubble-assistant'}">
        ${filesHtml}
        <div class="${isUser ? '' : 'md-content'}" id="content-${msg.id}">${content}</div>
      </div>
      ${usageHtml}
    </div>`;
  }).join('');

  if (state.isGenerating) {
    container.insertAdjacentHTML('beforeend', `
      <div class="flex flex-col items-start mb-4 animate-fade-in" id="typing-indicator">
        <div class="text-[0.7rem] font-semibold uppercase tracking-wider mb-1 ml-3" style="color:var(--muted)">ASSISTANT</div>
        <div class="inline-flex items-center gap-2 px-5 py-[14px] backdrop-blur-lg rounded-[18px_18px_18px_4px] opacity-85 bubble-assistant">
          <span class="text-[0.85em] font-semibold" style="color:var(--text)">🤔 Thinking</span>
          <span class="inline-flex items-center gap-1">
            <span class="inline-block w-1.5 h-1.5 rounded-full animate-pulse-dot" style="background:var(--muted);animation-delay:0s"></span>
            <span class="inline-block w-1.5 h-1.5 rounded-full animate-pulse-dot" style="background:var(--muted);animation-delay:0.2s"></span>
            <span class="inline-block w-1.5 h-1.5 rounded-full animate-pulse-dot" style="background:var(--muted);animation-delay:0.4s"></span>
          </span>
        </div>
      </div>`);
  }

  if (state.error) {
    container.insertAdjacentHTML('beforeend', `<div class="px-4 py-3 rounded-xl border text-sm mb-4 animate-fade-in" style="background:var(--error-bg);border-color:var(--error-border);color:#ef4444">⚠️ ${escHtml(state.error)}</div>`);
  }

  container.scrollTo({ top: container.scrollHeight, behavior: 'smooth' });
}

export function startProgressiveDisplay(msg) {
  const contentDiv = document.getElementById(`content-${msg.id}`);
  if (!contentDiv) return;
  
  if (msg._renderFrameRequested) return;

  const now = performance.now();
  if (msg._lastRenderTime && now - msg._lastRenderTime < 50) {
    if (!msg._renderTimer) {
      msg._renderTimer = setTimeout(() => {
        msg._renderTimer = null;
        startProgressiveDisplay(msg);
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
    <div class="flex items-center gap-1.5 pl-2 pr-1 py-1 rounded bg-black/10 border text-xs">
      <span class="truncate max-w-[120px] pointer-events-none">${escHtml(f.name)}</span>
      <button class="hover:text-red-400 p-0.5" data-idx="${i}">✕</button>
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
      btn.className = 'flex w-full items-center px-3 py-2 rounded-md border-0 text-sm cursor-pointer';
      btn.style.color = 'var(--text)';
      btn.style.background = isSelected ? 'var(--accent-light)' : 'transparent';
      btn.onmouseover = function() { if (!isSelected) this.style.background = 'var(--hover-bg)'; };
      btn.onmouseout = function() { this.style.background = isSelected ? 'var(--accent-light)' : 'transparent'; };
      btn.onclick = function(e) { 
        e.stopPropagation(); 
        selectModel(m.model); 
      };
      const label = document.createElement('span');
      label.className = 'font-medium';
      label.textContent = m.label;
      const provider = document.createElement('span');
      provider.className = 'text-[0.7rem] ml-auto';
      provider.style.color = 'var(--muted)';
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

// Ensure marked is setup once UI loads
if (typeof marked !== 'undefined') {
  marked.setOptions({
    gfm: true, breaks: false,
    highlight(code, lang) {
      if (lang && hljs.getLanguage(lang)) return hljs.highlight(code, { language: lang }).value;
      return hljs.highlightAuto(code).value;
    },
  });
}
