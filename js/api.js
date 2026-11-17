import { state, nextId } from './state.js';
import { findModel } from './config.js';
// Removed ui.js import to avoid DOM leakage

export async function checkAuth() {
  try {
    const res = await fetch('/api/auth/me');
    const data = await res.json();
    state.user = data.user;
    if (state.user) {
      await loadSessions();
      const savedId = localStorage.getItem('currentSessionId');
      if (savedId && state.sessions.find(s => s.id === savedId)) {
        await loadSession(savedId);
      }
    }
  } catch {
    state.user = null;
  }
  document.dispatchEvent(new CustomEvent('renderAuth'));
}

export function login() { 
  window.location.href = '/api/auth/login'; 
}

export async function logout() {
  await fetch('/api/auth/logout', { method: 'POST' });
  state.user = null; 
  state.sessions = []; 
  state.currentSessionId = null;
  state.messages = []; 
  state.error = null;
  localStorage.removeItem('currentSessionId');
  document.dispatchEvent(new CustomEvent('renderAuth')); 
  document.dispatchEvent(new CustomEvent('renderMessages')); 
  document.dispatchEvent(new CustomEvent('renderSessions'));
}

// Request counters: only the latest call may apply its result, so a slow
// response can't overwrite a newer one (fast typing / fast session switching).
let sessionsSeq = 0;
let sessionLoadSeq = 0;

export async function loadSessions(query = '') {
  const seq = ++sessionsSeq;
  try {
    const res = await fetch(`/api/sessions${query ? `?q=${encodeURIComponent(query)}` : ''}`);
    const data = await res.json();
    if (seq !== sessionsSeq) return;
    if (data.sessions) {
      state.sessions = data.sessions; 
      state.lastSearchQuery = query;
      document.dispatchEvent(new CustomEvent('renderSessions')); 
    }
  } catch (err) { 
    console.error('Failed to load sessions:', err); 
  }
}

export async function loadSession(id) {
  const seq = ++sessionLoadSeq;
  state.error = null;
  state.currentSessionId = id; 
  localStorage.setItem('currentSessionId', id);
  state.messages = []; 
  document.dispatchEvent(new CustomEvent('renderMessages'));
  document.dispatchEvent(new CustomEvent('syncGenerating', { detail: false }));
  // Restore the model this chat uses (ids from the old model list map to their successor).
  const session = state.sessions.find(s => s.id === id);
  const model = session?.model_id ? findModel(session.model_id) : undefined;
  if (model) {
    state.currentModel = model;
    document.dispatchEvent(new CustomEvent('updateModelLabel', { detail: model.label }));
  }
  document.dispatchEvent(new CustomEvent('renderSessions'));
  // Superseded by a newer load, or the user started a new chat meanwhile.
  const stale = () => seq !== sessionLoadSeq || state.currentSessionId !== id;
  try {
    const res = await fetch(`/api/sessions/${encodeURIComponent(id)}`);
    if (stale()) return;
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (stale()) return;
    if (data.messages) {
      state.messages = data.messages.map(m => parseMessage({ id: nextId(), role: m.role, content: m.content }));
      document.dispatchEvent(new CustomEvent('renderMessages'));
    }
  } catch (err) { 
    console.error('Failed to load session:', err); 
  }
}

/** Record the model a chat uses, so reopening the chat restores it. */
export async function saveSessionModel(sessionId, modelId) {
  const session = state.sessions.find(s => s.id === sessionId);
  if (session) session.model_id = modelId;
  try {
    const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model_id: modelId }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (err) {
    console.error('Failed to save the chat model:', err);
  }
}

export async function deleteSession(id) {
  try {
    const res = await fetch(`/api/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    state.sessions = state.sessions.filter(s => s.id !== id);
    document.dispatchEvent(new CustomEvent('renderSessions'));
    return true;
  } catch (err) { 
    console.error('Failed to delete session:', err); 
    return false;
  }
}

export function parseMessage(msg) {
  const m = msg.content?.match(/<\|usage:([^|]+)\|>/);
  if (m) {
    try { msg.usage = JSON.parse(m[1]); } catch {}
    msg.content = msg.content.replace(/<\|usage:[^|]+\|>/, '');
  }
  if (msg.role === 'user' && msg.content?.includes('\n\n---\n\n')) {
    const parts = msg.content.split('\n\n---\n\n');
    const textPart = parts[0];
    const numFiles = parts.length - 1;
    msg.displayContent = textPart || `[Sent ${numFiles} file(s)]`;
  }
  return msg;
}

export async function* parseSSE(reader) {
  const decoder = new TextDecoder();
  let buffer = '';

  const emit = function* (str, isLast) {
    let startIdx = 0;
    while (true) {
      const match = str.substring(startIdx).match(/\r?\n\r?\n/);
      if (!match) break;
      const splitIdx = startIdx + match.index;
      const eventStr = str.substring(startIdx, splitIdx);
      startIdx = splitIdx + match[0].length;
      
      if (!eventStr.trim()) continue;
      const lines = eventStr.split(/\r?\n/);
      let evType = '', evData = '';
      for (const line of lines) {
        if (line.startsWith('event: ')) evType = line.slice(7).trim();
        if (line.startsWith('data: ')) evData = line.slice(6);
      }
      if (evType && evData) {
        try {
          yield { type: evType, data: JSON.parse(evData) };
        } catch (e) {
          if (e.name === 'AbortError') throw e;
          console.warn('SSE JSON parse error:', e);
        }
      }
    }
    buffer = str.substring(startIdx);
    if (isLast && buffer.trim()) {
      // try to parse whatever is left if it looks like an event
      const lines = buffer.split(/\r?\n/);
      let evType = '', evData = '';
      for (const line of lines) {
        if (line.startsWith('event: ')) evType = line.slice(7).trim();
        if (line.startsWith('data: ')) evData = line.slice(6);
      }
      if (evType && evData) {
        try { yield { type: evType, data: JSON.parse(evData) }; } catch (e) {
          if (e.name === 'AbortError') throw e;
        }
      }
      buffer = '';
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (value) {
      buffer += decoder.decode(value, { stream: true });
      yield* emit(buffer, false);
    }
    if (done) {
      buffer += decoder.decode();
      if (buffer) yield* emit(buffer, true);
      break;
    }
  }
}

export async function generateSessionTitle(prompt) {
  const sessionId = state.currentSessionId;
  const model = state.currentModel;
  if (!sessionId || !model || !prompt) return;

  try {
    const sysPrompt = "You are a helpful assistant. Summarize the following message into a short chat session title (max 5 words). Do not include quotes or punctuation in the title. Return ONLY the title text.";
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: model.provider,
        model: model.model,
        messages: [
          { role: 'system', content: sysPrompt },
          { role: 'user', content: prompt }
        ]
      })
    });

    if (!res.ok) return;

    // On a provider error or refusal keep 'New Chat' rather than saving the
    // error/refusal text as the session title.
    const reader = res.body.getReader();
    let title = '';
    try {
      for await (const chunk of parseSSE(reader)) {
        if (chunk.type === 'text') title += chunk.data;
        else if (chunk.type === 'error' || chunk.type === 'refusal') return;
      }
    } finally {
      reader.cancel().catch(() => {});
    }

    // Remove <think>...</think> blocks if the LLM outputted them (even if unclosed)
    title = title.replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, '');

    title = title.replace(/["']/g, '').trim();
    if (!title) title = 'New Chat'; // Fallback if LLM returns empty

    // Save to DB
    const patchRes = await fetch(`/api/sessions/${sessionId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title })
    });
    if (!patchRes.ok) throw new Error('Failed to update title');

    // Update local state if the session still exists in memory
    const session = state.sessions.find(s => s.id === sessionId);
    if (session) {
      session.title = title;
      document.dispatchEvent(new CustomEvent('renderSessions'));
    }
  } catch (err) {
    console.error('Failed to generate session title:', err);
  }
}
