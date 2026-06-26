import { checkAuth, loadSession, deleteSession } from './api.js';
import { handleSend, clearChat, stopGenerating } from './chat.js';
import { 
  toggleSidebar, toggleTheme, toggleModelMenu, closeModelMenu, selectModel, 
  handleInputKeydown, adjustHeight, renderFilePreview, updateSendBtn 
} from './ui.js';
import { openSettings, closeSettingsModal, saveKey, deleteKey } from './settings.js';
import { handleFileSelect, initDragDrop } from './files.js';
import { state } from './state.js';

document.addEventListener('DOMContentLoaded', () => {
  window.toggleSidebar = toggleSidebar;
  window.toggleModelMenu = toggleModelMenu;
  window.clearChat = clearChat;
  window.toggleTheme = toggleTheme;
  window.openSettings = openSettings;
  window.handleFileSelect = handleFileSelect;
  window.adjustHeight = adjustHeight;
  window.handleInputKeydown = handleInputKeydown;
  window.handleSend = handleSend;
  window.stopGenerating = stopGenerating;
  window.closeSettingsModal = closeSettingsModal;
  window.saveKey = saveKey;
  window.deleteKey = deleteKey;

  // Close sidebar on backdrop tap (mobile)
  const backdropEl = document.getElementById('sidebar-backdrop');
  if (backdropEl) {
    backdropEl.addEventListener('click', () => toggleSidebar());
  }

  document.addEventListener('click', (e) => {
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
        deleteSession(delBtn.getAttribute('data-id'), e);
        return;
      }
      const item = e.target.closest('.session-item');
      if (item) {
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

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.id?.startsWith('key-')) saveKey(e.target.id.replace('key-', ''));
    if (e.key === 'Escape') { closeSettingsModal(); closeModelMenu(); }
  });
  
  if (localStorage.getItem('theme') === 'light') {
    document.documentElement.classList.remove('dark');
    const tb = document.getElementById('theme-btn');
    if (tb) tb.textContent = '☀️';
  }

  initDragDrop();
  checkAuth();
});
