import { state, nextId } from './state.js';
import { MODEL_OPTIONS } from './config.js';
import { renderAuth, renderSessions, renderMessages, syncGenerating } from './ui.js';

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
  renderAuth();
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
  renderAuth(); 
  renderMessages(); 
  renderSessions();
}

export async function loadSessions() {
  try {
    const res = await fetch('/api/sessions');
    const data = await res.json();
    if (data.sessions) { 
      state.sessions = data.sessions; 
      renderSessions(); 
    }
  } catch (err) { 
    console.error('Failed to load sessions:', err); 
  }
}

export async function loadSession(id) {
  state.currentSessionId = id; 
  localStorage.setItem('currentSessionId', id);
  state.messages = []; 
  syncGenerating(false);
  const session = state.sessions.find(s => s.id === id);
  if (session?.model_id) {
    const model = MODEL_OPTIONS.find(m => m.model === session.model_id);
    if (model) { 
      state.currentModel = model; 
      document.getElementById('model-label').textContent = model.label; 
    }
  }
  renderSessions();
  try {
    const res = await fetch(`/api/sessions/${id}`);
    const data = await res.json();
    if (data.messages) {
      state.messages = data.messages.map(m => parseMessage({ id: nextId(), role: m.role, content: m.content }));
      renderMessages();
    }
  } catch (err) { 
    console.error('Failed to load session:', err); 
  }
}

export async function deleteSession(id) {
  try {
    await fetch(`/api/sessions/${id}`, { method: 'DELETE' });
    state.sessions = state.sessions.filter(s => s.id !== id);
    renderSessions();
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
    const events = str.split(/\r?\n\r?\n/);
    if (!isLast) buffer = events.pop();
    else buffer = '';
    
    for (const ev of events) {
      if (!ev.trim()) continue;
      const lines = ev.split(/\r?\n/);
      let evType = '', evData = '';
      for (const line of lines) {
        if (line.startsWith('event: ')) evType = line.slice(7).trim();
        if (line.startsWith('data: ')) evData = line.slice(6);
      }
      if (evType && evData) {
        try { yield { type: evType, data: JSON.parse(evData) }; } catch (e) {}
      }
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

    let title = '';
    for await (const chunk of parseSSE(res.body.getReader())) {
      if (chunk.type === 'text') title += chunk.data;
    }

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
      renderSessions();
    }
  } catch (err) {
    console.error('Failed to generate session title:', err);
  }
}
