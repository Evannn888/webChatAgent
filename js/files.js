import { state } from './state.js';
import { renderFilePreview, updateSendBtn, showInputError } from './ui.js';

export async function handleFileSelect(event) {
  const fileInput = document.getElementById('file-input');
  if (event.target.files?.length) await processFiles(event.target.files);
  fileInput.value = '';
}

export async function processFiles(rawFiles) {
  for (const file of Array.from(rawFiles)) {
    if (file.type.startsWith('image/')) {
      const resized = await resizeImage(file, 1600, 0.8);
      state.files.push({ name: file.name, type: file.type, content: resized });
    } else if (file.type === 'application/pdf') {
      try { state.files.push({ name: file.name, type: file.type, content: await extractPDFText(file) }); }
      catch { state.files.push({ name: file.name, type: file.type, content: '[PDF text extraction failed]' }); }
    } else if (file.type.startsWith('text/')) {
      state.files.push({ name: file.name, type: file.type, content: await file.text() });
    } else {
      showInputError(`File type not supported: ${file.name}`);
    }
  }
  renderFilePreview(); updateSendBtn();
}

function resizeImage(file, maxDim, quality) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const objectUrl = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(objectUrl);
      let { width, height } = img;
      if (width > maxDim || height > maxDim) {
        const ratio = Math.min(maxDim / width, maxDim / height);
        width = Math.round(width * ratio); height = Math.round(height * ratio);
      }
      const canvas = document.createElement('canvas');
      canvas.width = width; canvas.height = height;
      canvas.getContext('2d').drawImage(img, 0, 0, width, height);
      resolve(canvas.toDataURL('image/jpeg', quality).split(',')[1]); // Base64 without header
    };
    img.onerror = () => { URL.revokeObjectURL(objectUrl); reject(new Error('Failed to load image')); };
    img.src = objectUrl;
  });
}

async function extractPDFText(file) {
  const pdfjsLib = await import('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.4.168/pdf.min.mjs');
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.4.168/pdf.worker.min.mjs';
  const pdf = await pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
  const pages = [];
  for (let i = 1; i <= Math.min(pdf.numPages, 20); i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    pages.push(`[Page ${i}]\n${content.items.map(it => it.str).join(' ')}`);
    page.cleanup(); 
  }
  await pdf.destroy(); 
  return pages.join('\n\n');
}

export function initDragDrop() {
  const area = document.getElementById('input-area');
  const appEl = document.getElementById('app');
  if (!area) return;
  
  let dragCounter = 0;
  appEl.addEventListener('dragenter', e => {
    e.preventDefault(); dragCounter++; appEl.classList.add('drop-active');
  });
  appEl.addEventListener('dragleave', e => {
    e.preventDefault(); 
    dragCounter = Math.max(0, dragCounter - 1);
    if (dragCounter === 0) appEl.classList.remove('drop-active');
  });
  appEl.addEventListener('dragover', e => e.preventDefault());
  appEl.addEventListener('drop', e => {
    e.preventDefault(); dragCounter = 0; appEl.classList.remove('drop-active');
    if (e.dataTransfer.files?.length) processFiles(e.dataTransfer.files);
  });
}
