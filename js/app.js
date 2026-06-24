import { checkAuth } from './api.js';
import { handleSend, clearChat, stopGenerating } from './chat.js';
import { 
  toggleSidebar, toggleTheme, toggleModelMenu, closeModelMenu, selectModel, 
  handleInputKeydown, adjustHeight 
} from './ui.js';
import { openSettings, closeSettingsModal, saveKey } from './settings.js';
import { handleFileSelect, initDragDrop } from './files.js';

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

  document.addEventListener('click', (e) => {
    const dd = document.getElementById('model-dropdown');
    if (dd && !dd.classList.contains('hidden')) {
      const wrapper = dd.parentElement;
      if (!wrapper.contains(e.target)) closeModelMenu();
    }
    if (window.innerWidth <= 639) {
      const sidebar = document.getElementById('sidebar');
      const toggleBtn = document.querySelector('button[title="Toggle Sidebar"]');
      if (sidebar && !sidebar.classList.contains('sidebar-hidden') && !sidebar.contains(e.target) && toggleBtn && !toggleBtn.contains(e.target)) {
        toggleSidebar();
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
