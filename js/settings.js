import { state } from './state.js?v=2';
import { PROVIDERS } from './config.js?v=2';
import { escHtml } from './ui.js?v=2';

let savedKeys = [];

export function openSettingsModal() { 
  document.getElementById('settings-modal').classList.remove('hidden'); 
}

export function closeSettingsModal() { 
  document.getElementById('settings-modal').classList.add('hidden'); 
}

export async function openSettings() {
  openSettingsModal();
  document.getElementById('settings-alert').innerHTML = '';
  if (state.user) {
    try { 
      const r = await fetch('/api/keys'); 
      const d = await r.json(); 
      savedKeys = d.keys || []; 
    } catch { savedKeys = []; }
  }
  renderSettingsForm();
}

export function renderSettingsForm() {
  const form = document.getElementById('settings-form');
  if (!state.user) { 
    form.innerHTML = '<p class="settings-placeholder">Please sign in to manage API keys.</p>'; 
    return; 
  }
  form.innerHTML = PROVIDERS.map(p => {
    const saved = savedKeys.find(k => k.provider === p.id);
    return `<div class="form-group">
      <label class="form-label">${p.label}</label>
      <div class="form-row">
        <input class="form-input" type="password" id="key-${p.id}" placeholder="${saved ? saved.keyMasked : p.placeholder}">
        <button class="btn-primary" onclick="saveKey('${p.id}')">Save</button>
      </div>
      ${saved ? `<div class="form-hint"><span>✓ Key saved</span><button class="btn-text btn-danger" onclick="deleteKey('${saved.id}')">Remove</button></div>` : ''}
    </div>`;
  }).join('');
}

export async function saveKey(provider) {
  const input = document.getElementById(`key-${provider}`); 
  const key = input.value.trim();
  if (!key) return;
  try {
    const res = await fetch('/api/keys', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider, key }) });
    if (!res.ok) { const err = await res.json(); throw new Error(err.error || 'Failed to save'); }
    input.value = '';
    showSettingsAlert('success', `${provider} key saved`);
    const r = await fetch('/api/keys'); const d = await r.json(); savedKeys = d.keys || [];
    renderSettingsForm();
  } catch (err) { showSettingsAlert('error', err.message); }
}

export async function deleteKey(id) {
  try {
    await fetch(`/api/keys?id=${id}`, { method: 'DELETE' });
    savedKeys = savedKeys.filter(k => k.id !== id);
    renderSettingsForm(); showSettingsAlert('success', 'Key deleted');
  } catch { showSettingsAlert('error', 'Failed to delete key'); }
}

export function showSettingsAlert(type, text) {
  const cls = type === 'success' ? 'alert alert-success' : 'alert alert-error';
  document.getElementById('settings-alert').innerHTML = `<div class="${cls}">${type === 'success' ? '✓' : '⚠️'} ${escHtml(text)}</div>`;
  setTimeout(() => { document.getElementById('settings-alert').innerHTML = ''; }, 4000);
}
