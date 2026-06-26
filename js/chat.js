import { state, nextId, activeStream, setActiveStream } from './state.js';
import { syncGenerating, renderMessages, renderSessions, renderFilePreview, showInputError, updateSendBtn, adjustHeight, updateMessageContent, cancelPendingRender, injectUsageBadge, renderMarkdown, appendMessage, showTypingIndicator, removeTypingIndicator, showChatError } from './ui.js';

/* ── Message Construction ─────────────────────────────────── */

function buildUserMessage(text, files) {
  let userContent = text;
  if (files.length > 0) {
    const sections = files.map(f => {
      if (f.type === 'application/pdf') return `📄 **${f.name}** (PDF):\n${f.content}`;
      if (f.type.startsWith('image/')) return `🖼 **${f.name}** (image, base64): ${f.content}`;
      return `📎 **${f.name}**:\n${f.content}`;
    });
    userContent = [text, ...sections].filter(Boolean).join('\n\n---\n\n');
  }
  return {
    id: nextId(), role: 'user',
    content: userContent,
    displayContent: text || `[Sent ${files.length} file(s)]`,
    files: files.map(f => ({ name: f.name, type: f.type })),
  };
}

/* ── SSE Stream Parsing ───────────────────────────────────── */

async function parseSSEStream(reader, assistantMsg) {
  const decoder = new TextDecoder();
  let sseBuffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    sseBuffer += decoder.decode(value, { stream: true });
    const sseEvents = sseBuffer.split(/\r?\n\r?\n/);
    sseBuffer = sseEvents.pop();
    if (sseBuffer.length > 1024 * 1024) throw new Error('Stream buffer exceeded safety limit');
    for (const eventStr of sseEvents) {
      if (!eventStr.trim()) continue;
      const lines = eventStr.split(/\r?\n/);
      let eventType = '', eventData = '';
      for (const line of lines) {
        if (line.startsWith('event: ')) eventType = line.slice(7).trim();
        if (line.startsWith('data: ')) eventData = line.slice(6);
      }
      if (eventType === 'text' && eventData) {
        assistantMsg.content += JSON.parse(eventData);
        removeTypingIndicator();
        updateMessageContent(assistantMsg);
      } else if (eventType === 'usage' && eventData) {
        assistantMsg.usage = JSON.parse(eventData);
        injectUsageBadge(assistantMsg);
      }
    }
  }
}

/* ── Message Finalization ─────────────────────────────────── */

function finalizeMessage(assistantMsg, input) {
  cancelPendingRender(assistantMsg);
  if (assistantMsg.content && !state.error) {
    assistantMsg.renderedHtml = renderMarkdown(assistantMsg.content);
    const cd = document.getElementById(`content-${assistantMsg.id}`);
    if (cd) cd.innerHTML = assistantMsg.renderedHtml;
    if (assistantMsg.usage) injectUsageBadge(assistantMsg);
  }
  if (state.error) showChatError(state.error);
  if (!assistantMsg.content && !state.error) {
    const cd = document.getElementById(`content-${assistantMsg.id}`);
    if (cd) cd.innerHTML = '<span class="placeholder-text">…</span>';
  }
  input.focus();
}

/* ── Main Send Handler ────────────────────────────────────── */

export async function handleSend() {
  if (state.isGenerating) return;
  const input = document.getElementById('msg-input');
  const text = input.value.trim();
  if (!text && state.files.length === 0) return;
  if (!state.user) { showInputError('Please sign in to send messages.'); return; }

  const isFirstMessage = state.messages.length === 0;
  const userMsg = buildUserMessage(text, state.files);
  state.messages.push(userMsg);
  const assistantMsg = { id: nextId(), role: 'assistant', content: '' };
  state.messages.push(assistantMsg);

  input.value = ''; state.files = [];
  renderFilePreview(); adjustHeight();
  syncGenerating(true); state.error = null;

  // Incremental: append just the two new messages + typing indicator
  appendMessage(userMsg);
  appendMessage(assistantMsg);
  showTypingIndicator();
  updateSendBtn();

  try {
    await ensureSession();
    const res = await fetch('/api/chat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: state.currentModel.provider, model: state.currentModel.model,
        messages: state.messages.filter(m => m.content && m !== assistantMsg)
          .map(m => ({ role: m.role, content: m.content })),
        sessionId: state.currentSessionId,
      }),
    });
    if (!res.ok) { const err = await res.json(); throw new Error(err.error || `HTTP ${res.status}`); }

    const reader = res.body.getReader();
    setActiveStream({ reader, assistantMsg });
    await parseSSEStream(reader, assistantMsg);
  } catch (err) {
    if (err.name === 'AbortError') {
      if (!assistantMsg.content) assistantMsg.content = '[Generation stopped]';
    } else if (!state.error) { state.error = err.message || 'Failed to send message'; }
    cancelPendingRender(assistantMsg);
  } finally {
    setActiveStream(null); syncGenerating(false);
    removeTypingIndicator();
    finalizeMessage(assistantMsg, input);
  }
}

export function stopGenerating() {
  if (activeStream) {
    activeStream.reader.cancel();
    activeStream.assistantMsg._stopDisplay = true;
    setActiveStream(null);
  }
}

export function clearChat() {
  stopGenerating();
  state.currentSessionId = null; localStorage.removeItem('currentSessionId');
  state.messages = []; state.error = null; state.files = [];
  syncGenerating(false);
  renderMessages();
  renderSessions();
}

async function ensureSession() {
  if (!state.currentSessionId) {
    const res = await fetch('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'New Chat', model: state.currentModel.model })
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `Failed to create session (HTTP ${res.status})`);
    }
    const data = await res.json();
    if (!data.session?.id) throw new Error('Invalid session response from server');
    state.currentSessionId = data.session.id;
    localStorage.setItem('currentSessionId', state.currentSessionId);
    state.sessions.unshift(data.session);
    renderSessions();
  }
}
