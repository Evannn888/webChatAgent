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

    // Settings Event Delegation
    const settingsForm = document.getElementById('settings-form');
    if (settingsForm && settingsForm.contains(e.target)) {
      const saveBtn = e.target.closest('[data-save-key]');
      if (saveBtn) {
        e.stopPropagation();
        saveKey(saveBtn.getAttribute('data-save-key'));
        return;
      }
      const delBtn = e.target.closest('[data-delete-key]');
      if (delBtn) {
        e.stopPropagation();
        deleteKey(delBtn.getAttribute('data-delete-key'));
        return;
      }
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

export function confirmDeleteSession() {
  return new Promise(resolve => {
    const modal = document.getElementById('confirm-modal');
    const cancelBtn = document.getElementById('confirm-cancel-btn');
    const deleteBtn = document.getElementById('confirm-delete-btn');
    
    if (!modal || !cancelBtn || !deleteBtn) {
      resolve(confirm('Are you sure you want to delete this chat?'));
      return;
    }

    modal.classList.remove('hidden');

    const cleanup = () => {
      modal.classList.add('hidden');
      cancelBtn.removeEventListener('click', onCancel);
      deleteBtn.removeEventListener('click', onDelete);
      modal.removeEventListener('click', onBackdrop);
      document.removeEventListener('keydown', onKeydown);
    };

    const onCancel = () => { cleanup(); resolve(false); };
    const onDelete = () => { cleanup(); resolve(true); };
    const onBackdrop = (e) => {
      if (e.target === modal) { cleanup(); resolve(false); }
    };
    const onKeydown = (e) => {
      if (e.key === 'Escape') { cleanup(); resolve(false); }
    };

    cancelBtn.addEventListener('click', onCancel);
    deleteBtn.addEventListener('click', onDelete);
    modal.addEventListener('click', onBackdrop);
    document.addEventListener('keydown', onKeydown);
  });
}
