import { state, nextId } from './state.js';
import { syncGenerating, renderMessages, renderSessions, renderFilePreview, showInputError, updateSendBtn, adjustHeight, appendStreamingToken, cancelPendingRender, injectUsageBadge, renderMarkdown, appendMessage, showTypingIndicator, removeTypingIndicator, showChatError } from './ui.js';
import { generateSessionTitle, parseSSE, loadSessions } from './api.js';

// The in-flight request: { controller: AbortController, assistantMsg }
let activeStream = null;

const MAX_HISTORY = 50;

/* ── Message Construction ─────────────────────────────────── */

function buildUserMessage(text, files) {
  let userContent = text;
  if (files.length > 0) {
    const sections = files.map(f => {
      // Images travel as real image attachments (see `images` below); the text
      // only notes them, so no base64 ends up in the prompt or the database.
      if (f.isImage) return `🖼 **${f.name}** (image attached)`;
      if (f.type === 'application/pdf') return `📄 **${f.name}** (PDF):\n${f.content}`;
      return `📎 **${f.name}**:\n${f.content}`;
    });
    userContent = [text, ...sections].filter(Boolean).join('\n\n---\n\n');
  }
  const images = files.filter(f => f.isImage).map(f => ({ mediaType: f.type, data: f.data }));
  return {
    id: nextId(), role: 'user',
    content: userContent,
    displayContent: text || `[Sent ${files.length} file(s)]`,
    files: files.map(f => ({ name: f.name, type: f.type })),
    ...(images.length ? { images } : {}),
  };
}

const stripThinking = (text) => text.replace(/<think>[\s\S]*?(?:<\/think>|$)/g, '').trim();

/** The conversation as sent to the model. */
function buildHistory(messages) {
  const history = [];
  for (const m of messages) {
    // Earlier reasoning isn't part of the answer; resending it wastes tokens.
    const content = m.role === 'assistant' ? stripThinking(m.content || '') : m.content;
    if (!content) continue;
    history.push({ role: m.role, content, ...(m.images ? { images: m.images } : {}) });
  }
  const recent = history.slice(-MAX_HISTORY);
  // Claude and Gemini reject a conversation that starts with an assistant turn,
  // which the cut above produces whenever it lands on an assistant message.
  while (recent.length && recent[0].role !== 'user') recent.shift();
  return recent;
}

/* ── SSE Stream Parsing ───────────────────────────────────── */

async function parseSSEStream(reader, assistantMsg, isActive) {
  for await (const chunk of parseSSE(reader)) {
    if (chunk.type === 'text' || chunk.type === 'refusal') {
      if (chunk.type === 'refusal') assistantMsg.refused = true;
      if (isActive()) removeTypingIndicator();
      appendStreamingToken(assistantMsg, chunk.data);
    } else if (chunk.type === 'usage') {
      assistantMsg.usage = chunk.data;
      injectUsageBadge(assistantMsg);
    } else if (chunk.type === 'error') {
      throw new Error(chunk.data);
    }
  }
}

/* ── Message Finalization ─────────────────────────────────── */

function finalizeMessage(assistantMsg, input) {
  assistantMsg._isStreaming = false;
  cancelPendingRender(assistantMsg);
  const cd = document.getElementById(`content-${assistantMsg.id}`);
  if (assistantMsg.content) {
    assistantMsg.renderedHtml = renderMarkdown(assistantMsg.content);
    if (cd) cd.innerHTML = assistantMsg.renderedHtml;
    if (assistantMsg.usage) injectUsageBadge(assistantMsg);
  } else if (cd) {
    cd.innerHTML = '<span class="placeholder-text">…</span>';
  }
  if (state.error) showChatError(state.error);
  input.focus();

  const session = state.sessions.find(s => s.id === state.currentSessionId);
  const needsTitle = session && (!session.title || session.title === 'New Chat');
  if (needsTitle && assistantMsg.content && !state.error && !assistantMsg.refused) {
    const userMsg = state.messages.find(m => m.role === 'user');
    // Messages loaded from the server only have displayContent when files were attached.
    const prompt = userMsg?.displayContent || userMsg?.content || 'Chat with files';
    generateSessionTitle(prompt).catch(err => console.error('Failed to generate session title:', err));
  }
}

/* ── Main Send Handler ────────────────────────────────────── */

export async function handleSend() {
  if (state.isGenerating) return;
  state.isGenerating = true; // Guard immediately to prevent double-sends
  const input = document.getElementById('msg-input');
  const text = input.value.trim();
  if (!text && state.files.length === 0) { state.isGenerating = false; return; }
  if (!state.user) { state.isGenerating = false; showInputError('Please sign in to send messages.'); return; }

  // state.messages is replaced whenever the user opens another chat or starts a
  // new one, so this tells us whether the chat this reply belongs to is still on screen.
  const convo = state.messages;
  const isActive = () => state.messages === convo;

  const userMsg = buildUserMessage(text, state.files);
  convo.push(userMsg);
  const assistantMsg = { id: nextId(), role: 'assistant', content: '', model: state.currentModel.model };
  convo.push(assistantMsg);
  const { provider, model } = state.currentModel;

  input.value = ''; state.files = [];
  renderFilePreview(); adjustHeight();
  syncGenerating(true); state.error = null;

  // Incremental: append just the two new messages + typing indicator
  appendMessage(userMsg);
  appendMessage(assistantMsg);
  showTypingIndicator();
  updateSendBtn();

  const controller = new AbortController();
  const stream = { controller, assistantMsg };
  activeStream = stream;

  try {
    const sessionId = await ensureSession(isActive);
    if (controller.signal.aborted) throw new DOMException('Aborted', 'AbortError');
    const res = await fetch('/api/chat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider, model,
        messages: buildHistory(convo.filter(m => m !== assistantMsg)),
        sessionId,
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `HTTP ${res.status}`);
    }

    await parseSSEStream(res.body.getReader(), assistantMsg, isActive);
  } catch (err) {
    if (err.name === 'AbortError') {
      if (!assistantMsg.content) assistantMsg.content = '[Generation stopped]';
    } else if (isActive() && !state.error) {
      state.error = err.message || 'Failed to send message';
    }
    cancelPendingRender(assistantMsg);
  } finally {
    if (activeStream === stream) activeStream = null;
    if (isActive()) {
      syncGenerating(false);
      removeTypingIndicator();
      finalizeMessage(assistantMsg, input);
    } else {
      // The user moved to another chat; leave its UI alone.
      cancelPendingRender(assistantMsg);
    }
  }
}

export function stopGenerating() {
  if (activeStream) {
    // Aborting works both while waiting for the response and while streaming it.
    activeStream.controller.abort();
    activeStream = null;
  }
}

export function clearChat() {
  stopGenerating();
  state.currentSessionId = null; localStorage.removeItem('currentSessionId');
  state.messages = []; state.error = null; state.files = [];
  syncGenerating(false);
  renderMessages();

  const searchInput = document.getElementById('search-input');
  if (searchInput && searchInput.value) {
    searchInput.value = '';
    loadSessions();
  } else {
    renderSessions();
  }
}

/** Returns the session id for this send, creating the session on the first message. */
async function ensureSession(isActive) {
  if (state.currentSessionId) return state.currentSessionId;

  const res = await fetch('/api/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'New Chat', model_id: state.currentModel.model })
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Failed to create session (HTTP ${res.status})`);
  }
  const data = await res.json();
  if (!data.session?.id) throw new Error('Invalid session response from server');
  state.sessions.unshift(data.session);
  // Don't hijack the current chat if the user opened another one meanwhile.
  if (isActive()) {
    state.currentSessionId = data.session.id;
    localStorage.setItem('currentSessionId', state.currentSessionId);
  }
  renderSessions();
  return data.session.id;
}
