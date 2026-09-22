'use strict';

const fileInput = document.getElementById('file-input');
const dropzone = document.getElementById('dropzone');
const fileName = document.getElementById('file-name');
const imposeBtn = document.getElementById('impose-btn');
const statusEl = document.getElementById('status');
const summaryEl = document.getElementById('summary');
const previewEl = document.getElementById('preview');
const sheetsEl = document.getElementById('sheets');
const downloadBtn = document.getElementById('download-btn');

let selectedFile = null;
let resultBlobUrl = null;
let resultBaseName = 'booklet';

function setStatus(text, kind) {
  statusEl.textContent = text || '';
  statusEl.className = kind ? `status ${kind}` : 'status';
}

function clearResult() {
  if (resultBlobUrl) {
    URL.revokeObjectURL(resultBlobUrl);
    resultBlobUrl = null;
  }
  summaryEl.hidden = true;
  previewEl.hidden = true;
  sheetsEl.innerHTML = '';
  sheetsEl.style.removeProperty('--spread-ratio');
}

fileInput.addEventListener('change', () => {
  const file = fileInput.files && fileInput.files[0];
  selectFile(file);
});

['dragenter', 'dragover'].forEach((evt) => {
  dropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    dropzone.classList.add('dragover');
  });
});
['dragleave', 'drop'].forEach((evt) => {
  dropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    dropzone.classList.remove('dragover');
  });
});
dropzone.addEventListener('drop', (e) => {
  const file = e.dataTransfer.files && e.dataTransfer.files[0];
  selectFile(file);
});

function selectFile(file) {
  clearResult();
  if (!file) {
    selectedFile = null;
    fileName.textContent = '';
    imposeBtn.disabled = true;
    return;
  }
  if (file.type && file.type !== 'application/pdf') {
    setStatus('请选择 PDF 文件', 'error');
    return;
  }
  selectedFile = file;
  fileName.textContent = file.name;
  resultBaseName = (file.name || 'booklet').replace(/\.pdf$/i, '');
  imposeBtn.disabled = false;
  setStatus(`已选择：${file.name}（${(file.size / 1024 / 1024).toFixed(2)} MB）`, 'info');
}

imposeBtn.addEventListener('click', async () => {
  if (!selectedFile) return;
  imposeBtn.disabled = true;
  setStatus('正在拼版，请稍候…', 'info');
  clearResult();

  const form = new FormData();
  form.append('pdf', selectedFile);

  try {
    const resp = await fetch('/api/impose', { method: 'POST', body: form });

    if (!resp.ok) {
      let message = `拼版失败（HTTP ${resp.status}）`;
      try {
        const data = await resp.json();
        if (data && data.error) message = data.error;
      } catch (_) { /* 非 JSON 错误响应，使用默认提示 */ }
      throw new Error(message);
    }

    const planHeader = resp.headers.get('X-Imposition-Plan');
    if (!planHeader) throw new Error('响应缺少拼版方案');
    const plan = JSON.parse(decodeURIComponent(planHeader));

    const blob = await resp.blob();
    resultBlobUrl = URL.createObjectURL(blob);

    renderSummary(plan);
    renderPreview(plan);
    setStatus('拼版完成，可预览页序或下载 PDF。', 'info');
  } catch (err) {
    setStatus(err.message || '拼版失败', 'error');
  } finally {
    imposeBtn.disabled = false;
  }
});

downloadBtn.addEventListener('click', () => {
  if (!resultBlobUrl) return;
  const a = document.createElement('a');
  a.href = resultBlobUrl;
  a.download = `${resultBaseName}-拼版.pdf`;
  document.body.appendChild(a);
  a.click();
  a.remove();
});

function renderSummary(plan) {
  document.getElementById('sum-source').textContent = plan.sourceCount;
  document.getElementById('sum-blanks').textContent = plan.paddedCount;
  document.getElementById('sum-sheets').textContent = plan.sheets.length;

  const panel = plan.panel;
  const mixedEl = document.getElementById('sum-mixed');
  if (panel) {
    document.getElementById('sum-panel').textContent =
      `${formatMm(panel.widthMm)} × ${formatMm(panel.heightMm)} mm`
      + `（${Math.round(panel.width)} × ${Math.round(panel.height)} pt）`;
    document.getElementById('sum-orientation').textContent = ORIENTATION_LABELS[panel.orientation] || panel.orientation;
    document.getElementById('sum-sheet-size').textContent =
      `${formatMm(panel.widthMm * 2)} × ${formatMm(panel.heightMm)} mm（横向，每张纸）`;
    mixedEl.hidden = !panel.mixedSize;
  } else {
    document.getElementById('sum-panel').textContent = '-';
    document.getElementById('sum-orientation').textContent = '-';
    document.getElementById('sum-sheet-size').textContent = '-';
    mixedEl.hidden = true;
  }
  summaryEl.hidden = false;
}

const ORIENTATION_LABELS = {
  portrait: '竖向（Portrait）',
  landscape: '横向（Landscape）',
  square: '正方形（Square）',
};

function formatMm(value) {
  return (Math.round(value * 10) / 10).toFixed(1);
}

function renderPreview(plan) {
  const frag = document.createDocumentFragment();

  for (const sheet of plan.sheets) {
    const card = document.createElement('div');
    card.className = 'sheet';

    const title = document.createElement('div');
    title.className = 'sheet-title';
    title.textContent = `第 ${sheet.sheet} 张纸 / 共 ${plan.sheets.length} 张`;
    card.appendChild(title);

    card.appendChild(buildSide('正面', sheet.front, false));
    card.appendChild(buildSide('背面', sheet.back, true));

    frag.appendChild(card);
  }
  // 预览框比例跟随实际纸张（宽 = 2 × 面板宽，高 = 面板高）
  if (plan.panel && plan.panel.height > 0) {
    sheetsEl.style.setProperty(
      '--spread-ratio',
      String((plan.panel.width * 2) / plan.panel.height),
    );
  }
  sheetsEl.appendChild(frag);
  previewEl.hidden = false;
}

function buildSide(labelText, side, isBack) {
  const sideEl = document.createElement('div');
  sideEl.className = 'side';

  const label = document.createElement('span');
  label.className = isBack ? 'side-label back' : 'side-label';
  label.textContent = labelText;
  sideEl.appendChild(label);

  const spread = document.createElement('div');
  spread.className = 'spread';
  spread.appendChild(buildPanel(side.left, 'left'));
  spread.appendChild(buildPanel(side.right, 'right'));

  sideEl.appendChild(spread);
  return sideEl;
}

function buildPanel(slot, position) {
  const panel = document.createElement('div');
  panel.className = slot.blank ? 'panel blank' : 'panel';

  const pos = document.createElement('span');
  pos.className = `pos ${position}`;
  pos.textContent = position === 'left' ? '左' : '右';
  panel.appendChild(pos);

  if (slot.blank) {
    const tag = document.createElement('span');
    tag.className = 'blank-tag';
    tag.textContent = '空白页';
    panel.appendChild(tag);
  } else {
    const num = document.createElement('span');
    num.textContent = `第 ${slot.page} 页`;
    panel.appendChild(num);
  }
  return panel;
}
