import { checkAuth, loadSession, deleteSession } from './api.js';
import { handleSend, clearChat, stopGenerating } from './chat.js';
import { 
  toggleSidebar, toggleTheme, toggleModelMenu, closeModelMenu, selectModel, 
  handleInputKeydown, adjustHeight, renderFilePreview, updateSendBtn, confirmDeleteSession 
} from './ui.js';
import { openSettings, closeSettingsModal, saveKey, deleteKey } from './settings.js';
import { handleFileSelect, initDragDrop } from './files.js';
import { state } from './state.js';

document.addEventListener('DOMContentLoaded', () => {
  // These remain on window because settings.js renders onclick="saveKey(...)" / onclick="deleteKey(...)"
  // dynamically in innerHTML. They can be removed once settings.js uses event delegation too.
  window.saveKey = saveKey;
  window.deleteKey = deleteKey;

  // Header buttons
  document.getElementById('sidebar-toggle').addEventListener('click', () => toggleSidebar());
  document.getElementById('model-menu-btn').addEventListener('click', () => toggleModelMenu());
  document.getElementById('new-chat-btn').addEventListener('click', () => clearChat());
  document.getElementById('theme-btn').addEventListener('click', () => toggleTheme());
  document.getElementById('settings-btn').addEventListener('click', () => openSettings());

  // Sidebar
  document.getElementById('sidebar-new-chat').addEventListener('click', () => clearChat());
  const backdropEl = document.getElementById('sidebar-backdrop');
  if (backdropEl) {
    backdropEl.addEventListener('click', () => toggleSidebar());
  }

  // Input area
  document.getElementById('attach-btn').addEventListener('click', () => {
    document.getElementById('file-input').click();
  });
  document.getElementById('file-input').addEventListener('change', (e) => handleFileSelect(e));
  const msgInput = document.getElementById('msg-input');
  msgInput.addEventListener('input', () => adjustHeight());
  msgInput.addEventListener('keydown', (e) => handleInputKeydown(e));

  // Send / Stop
  document.getElementById('send-btn').addEventListener('click', () => handleSend());
  document.getElementById('stop-btn').addEventListener('click', () => stopGenerating());

  // Settings modal — close on backdrop click
  document.getElementById('settings-modal').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeSettingsModal();
  });

  // Global click handlers
  document.addEventListener('click', async (e) => {
    const dd = document.getElementById('model-dropdown');
    if (dd && !dd.classList.contains('hidden')) {
      const wrapper = dd.parentElement;
      if (!wrapper.contains(e.target)) closeModelMenu();
    }

    // Session List Event Delegation
    const sessionList = document.getElementById('session-list');
    if (sessionList && sessionList.contains(e.target)) {
      const delBtn = e.target.closest('.session-del');
      if (delBtn) {
        e.stopPropagation();
        
        const confirmed = await confirmDeleteSession();
        if (!confirmed) return;
        
        const id = delBtn.getAttribute('data-id');
        const deleted = await deleteSession(id);
        if (deleted && state.currentSessionId === id) {
          clearChat();
        }
        return;
      }
      const item = e.target.closest('.session-item');
      if (item) {
        stopGenerating();
        loadSession(item.getAttribute('data-id'));
      }
    }

    // File Preview Event Delegation
    const preview = document.getElementById('file-preview');
    if (preview && preview.contains(e.target)) {
      const btn = e.target.closest('button');
      if (btn && btn.hasAttribute('data-idx')) {
        state.files.splice(parseInt(btn.getAttribute('data-idx')), 1);
        renderFilePreview();
        updateSendBtn();
      }
    }
  });

  // Global keyboard shortcuts
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.id?.startsWith('key-')) saveKey(e.target.id.replace('key-', ''));
    if (e.key === 'Escape') { closeSettingsModal(); closeModelMenu(); }
  });
  
  // Theme persistence
  if (localStorage.getItem('theme') === 'light') {
    document.documentElement.classList.remove('dark');
    const tb = document.getElementById('theme-btn');
    if (tb) tb.textContent = '☀️';
  }

  initDragDrop();
  checkAuth();
});
