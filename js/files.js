import { state } from './state.js';
import { renderFilePreview, updateSendBtn, showInputError } from './ui.js';

export async function handleFileSelect(event) {
  const fileInput = document.getElementById('file-input');
  if (event.target.files?.length) await processFiles(event.target.files);
  fileInput.value = '';
}

// Keep encoded images comfortably under provider per-image limits (~5 MB).
const MAX_IMAGE_BASE64 = 3_500_000;

export async function processFiles(rawFiles) {
  for (const file of Array.from(rawFiles)) {
    // One unreadable file (e.g. HEIC the browser can't decode) must not abort the rest.
    try {
      if (file.type.startsWith('image/')) {
        const { data, mediaType } = await resizeImage(file, 1600, 0.8);
        state.files.push({ name: file.name, type: mediaType, data, isImage: true });
      } else if (file.type === 'application/pdf') {
        try { state.files.push({ name: file.name, type: file.type, content: await extractPDFText(file) }); }
        catch { state.files.push({ name: file.name, type: file.type, content: '[PDF text extraction failed]' }); }
      } else if (file.type.startsWith('text/')) {
        state.files.push({ name: file.name, type: file.type, content: await file.text() });
      } else {
        showInputError(`File type not supported: ${file.name}`);
      }
    } catch {
      showInputError(`Could not read ${file.name}`);
    }
  }
  renderFilePreview(); updateSendBtn();
}

/** Downscale and re-encode an image. Resolves { data: base64 (no header), mediaType }. */
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
      const ctx = canvas.getContext('2d');
      const encode = (mediaType) => {
        ctx.clearRect(0, 0, width, height);
        // JPEG has no alpha channel: paint transparent areas white instead of black.
        if (mediaType === 'image/jpeg') { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, width, height); }
        ctx.drawImage(img, 0, 0, width, height);
        return canvas.toDataURL(mediaType, quality).split(',')[1];
      };
      // PNG keeps screenshots/text sharp; everything else (and oversized PNGs) becomes JPEG.
      // The returned mediaType always matches the bytes actually produced.
      let mediaType = file.type === 'image/png' ? 'image/png' : 'image/jpeg';
      let data = encode(mediaType);
      if (mediaType === 'image/png' && data.length > MAX_IMAGE_BASE64) {
        mediaType = 'image/jpeg';
        data = encode(mediaType);
      }
      resolve({ data, mediaType });
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
  const numPagesToExtract = Math.min(pdf.numPages, 20);
  if (pdf.numPages > 20) {
    showInputError(`PDF has ${pdf.numPages} pages. Only the first 20 will be processed.`);
  }
  for (let i = 1; i <= numPagesToExtract; i++) {
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
  
  appEl.addEventListener('dragenter', e => {
    e.preventDefault(); appEl.classList.add('drop-active');
  });
  appEl.addEventListener('dragleave', e => {
    e.preventDefault(); 
    if (!appEl.contains(e.relatedTarget)) {
      appEl.classList.remove('drop-active');
    }
  });
  appEl.addEventListener('dragover', e => e.preventDefault());
  appEl.addEventListener('drop', e => {
    e.preventDefault(); appEl.classList.remove('drop-active');
    if (e.dataTransfer.files?.length) processFiles(e.dataTransfer.files);
  });
}
