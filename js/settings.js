import { state } from './state.js';
import { PROVIDERS } from './config.js';
import { escHtml } from './ui.js';

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
    form.innerHTML = '<p class="text-center py-5">Please sign in to manage API keys.</p>'; 
    return; 
  }
  form.innerHTML = PROVIDERS.map(p => {
    const saved = savedKeys.find(k => k.provider === p.id);
    return `<div class="mb-4">
      <label class="block text-sm font-semibold mb-1.5 capitalize">${p.label}</label>
      <div class="flex gap-2">
        <input class="flex-1 px-3 py-2.5 border rounded-lg font-sans text-sm outline-none focus:border-[#a29bfe] transition-colors" style="background:var(--input-bg);border-color:var(--border);color:var(--text)" type="password" id="key-${p.id}" placeholder="${saved ? saved.keyMasked : p.placeholder}">
        <button class="px-4 py-2 rounded-lg bg-gradient-to-br from-indigo-600 to-purple-400 text-white font-medium cursor-pointer border-0 hover:opacity-90 flex-shrink-0" onclick="saveKey('${p.id}')">Save</button>
      </div>
      ${saved ? `<div class="flex items-center justify-between mt-1 text-xs" style="color:var(--muted)"><span>✓ Key saved</span><button class="text-red-400 cursor-pointer bg-transparent border-0 p-0 font-sans hover:underline" onclick="deleteKey('${saved.id}')">Remove</button></div>` : ''}
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
  const cls = type === 'success' ? 'bg-green-500/10 border-green-500/25 text-green-400' : 'bg-red-500/10 border-red-500/25 text-red-400';
  document.getElementById('settings-alert').innerHTML = `<div class="px-3 py-2 rounded-lg border mb-4 text-sm ${cls}">${type === 'success' ? '✓' : '⚠️'} ${escHtml(text)}</div>`;
  setTimeout(() => { document.getElementById('settings-alert').innerHTML = ''; }, 4000);
}
