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
  // Lazy-import chat.js to avoid circular dependency — api.js is data layer,
  // chat.js is interaction layer. The old direct import caused tight coupling.
  const { stopGenerating } = await import('./chat.js');
  stopGenerating();
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

export async function deleteSession(id, event) {
  event.stopPropagation();
  if (!confirm('Are you sure you want to delete this chat?')) return;
  try {
    await fetch(`/api/sessions/${id}`, { method: 'DELETE' });
    state.sessions = state.sessions.filter(s => s.id !== id);
    if (state.currentSessionId === id) {
      // Instead of importing clearChat, inline the state reset here.
      // This keeps api.js (data layer) independent of chat.js (interaction layer).
      state.currentSessionId = null;
      localStorage.removeItem('currentSessionId');
      state.messages = []; state.error = null; state.files = [];
      syncGenerating(false);
      renderMessages();
      renderSessions();
    } else {
      renderSessions();
    }
  } catch (err) { 
    console.error('Failed to delete session:', err); 
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

export async function generateSessionTitle(prompt) {
  if (!state.currentSessionId || !state.currentModel || !prompt) return;

  try {
    const sysPrompt = "You are a helpful assistant. Summarize the following message into a short chat session title (max 5 words). Do not include quotes or punctuation in the title. Return ONLY the title text.";
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: state.currentModel.provider,
        model: state.currentModel.model,
        messages: [
          { role: 'system', content: sysPrompt },
          { role: 'user', content: prompt }
        ]
        // Omit sessionId so this meta-request isn't saved to the DB
      })
    });

    if (!res.ok) return;

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let title = '';
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const events = buffer.split(/\r?\n\r?\n/);
      buffer = events.pop();
      for (const ev of events) {
        if (!ev.trim()) continue;
        const lines = ev.split(/\r?\n/);
        let evType = '', evData = '';
        for (const line of lines) {
          if (line.startsWith('event: ')) evType = line.slice(7).trim();
          if (line.startsWith('data: ')) evData = line.slice(6);
        }
        if (evType === 'text' && evData) {
          title += JSON.parse(evData);
        }
      }
    }

    title = title.replace(/["']/g, '').trim();
    if (!title) return;

    // Save to DB
    await fetch(`/api/sessions/${state.currentSessionId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title })
    });

    // Update local state
    const session = state.sessions.find(s => s.id === state.currentSessionId);
    if (session) {
      session.title = title;
      renderSessions();
    }
  } catch (err) {
    console.error('Failed to generate session title:', err);
  }
}
