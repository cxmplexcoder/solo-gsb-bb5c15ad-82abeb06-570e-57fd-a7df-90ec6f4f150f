'use strict';

const { PDFDocument, degrees } = require('pdf-lib');

/**
 * 骑马钉（saddle-stitch）拼版核心逻辑。
 *
 * 每张纸正反两页（两个 output PDF page），每排放两个原始页，即每张纸容纳 4 页：
 *   - 正面（front）：末页(左) | 首页(右)
 *   - 背面（back） ：第 2 页(左) | 倒数第 2 页(右)
 *   其余纸张按同样方式逐层向内递进。
 * 页数不是 4 的倍数时，在文档末尾补空白页。
 *
 * 混合尺寸适配：
 *   上传的 PDF 各页尺寸或旋转方向可能不一致。拼版前先按各页「旋转后」的宽高
 *   取全部页面宽/高的最大值作为统一面板（panel）尺寸；每个页面保持 1:1 居中
 *   放入对应半区，空余区域留白（PDF 背景天然透明，不作任何填充）。
 *   输出每张纸仍为横向：宽 = 2 × 面板宽，高 = 面板高。
 *   页序与末尾补白规则不受影响。
 */

const PT_PER_INCH = 72;
const MM_PER_INCH = 25.4;
const PT_PER_MM = PT_PER_INCH / MM_PER_INCH;

/**
 * 根据原始页数返回需要补的空白页数（0~3）。
 * @param {number} sourceCount
 * @returns {number}
 */
function blanksForCount(sourceCount) {
  return (4 - (sourceCount % 4)) % 4;
}

/**
 * 生成拼版页序方案。
 *
 * 返回的每张纸：
 *   { sheet: 1, front: { left: 页码|null, right: 页码|null },
 *                   back:  { left: 页码|null, right: 页码|null } }
 * 页码从 1 开始；null 表示补齐的空白页（页码标识为 padded: true）。
 *
 * @param {number} sourceCount 原始 PDF 页数
 * @returns {{ sheets: Array, sourceCount: number, paddedCount: number, totalCount: number, blanks: number }}
 */
function buildImpositionPlan(sourceCount) {
  if (!Number.isInteger(sourceCount) || sourceCount < 1) {
    throw new Error('PDF 至少需要包含 1 页');
  }

  const blanks = blanksForCount(sourceCount);
  const totalCount = sourceCount + blanks;
  const sheetsPerSheet = totalCount / 4;

  const sheets = [];
  for (let i = 0; i < sheetsPerSheet; i += 1) {
    // 正面：从尾部取左页、从头部取右页
    const frontLeft = totalCount - 2 * i;       // 末页、倒数第 4、倒数第 8 ...
    const frontRight = 2 * i + 1;               // 首页、第 3 页、第 5 页 ...
    // 背面：从头部取左页、从尾部取右页
    const backLeft = 2 * i + 2;                 // 第 2 页、第 6 页、第 10 页 ...
    const backRight = totalCount - 2 * i - 1;   // 倒数第 2、倒数第 6 ...

    sheets.push({
      sheet: i + 1,
      front: {
        left: pageSlot(frontLeft, sourceCount),
        right: pageSlot(frontRight, sourceCount),
      },
      back: {
        left: pageSlot(backLeft, sourceCount),
        right: pageSlot(backRight, sourceCount),
      },
    });
  }

  return {
    sheets,
    sourceCount,
    paddedCount: blanks,
    totalCount,
    blanks,
  };
}

function pageSlot(position, sourceCount) {
  if (position <= sourceCount) {
    return { page: position, blank: false };
  }
  return { page: null, blank: true };
}

/**
 * 将页面旋转角归一化到 0/90/180/270（度）。
 * PDF 规范中 /Rotate 必须是 90 的整数倍（含负值、超过 360 的值，且可沿页树继承）。
 * @param {number} angle
 * @returns {number}
 */
function normalizeRotation(angle) {
  const mod = ((Number(angle) || 0) % 360 + 360) % 360;
  if (mod % 90 !== 0) {
    // 非 90 整数倍属于非规范值，无法按正交旋转处理，保守地按 0 处理
    return 0;
  }
  return mod;
}

/**
 * 收集源文档每页按 /Rotate 旋转后的宽高（pt）及归一化旋转角。
 * pdf-lib 的 embedPdf 不应用 /Rotate（嵌入的 XObject 保持 MediaBox 方向），
 * 因此旋转信息必须在绘制时自行处理。
 * @param {PDFDocument} srcDoc
 * @returns {{ width: number, height: number, rotation: number }[]}
 */
function describeSourcePages(srcDoc) {
  const count = srcDoc.getPageCount();
  const pages = new Array(count);
  for (let i = 0; i < count; i += 1) {
    const page = srcDoc.getPage(i);
    const rotation = normalizeRotation(page.getRotation().angle);
    const rawWidth = page.getWidth();
    const rawHeight = page.getHeight();
    // 90°/270° 旋转后宽高互换；180° 旋转宽高不变
    const swapped = rotation === 90 || rotation === 270;
    pages[i] = {
      width: swapped ? rawHeight : rawWidth,
      height: swapped ? rawWidth : rawHeight,
      rotation,
    };
  }
  return pages;
}

/**
 * 根据各页旋转后的宽高计算统一面板尺寸（取全部页面宽、高的最大值）。
 * @param {{ width: number, height: number }[]} pageInfos
 * @returns {{ panelWidth: number, panelHeight: number, mixedSize: boolean }}
 */
function buildPanelLayout(pageInfos) {
  if (!Array.isArray(pageInfos) || pageInfos.length === 0) {
    throw new Error('PDF 不包含任何页面');
  }
  let panelWidth = 0;
  let panelHeight = 0;
  let mixedSize = false;
  for (const info of pageInfos) {
    if (info.width !== pageInfos[0].width || info.height !== pageInfos[0].height) {
      mixedSize = true;
    }
    panelWidth = Math.max(panelWidth, info.width);
    panelHeight = Math.max(panelHeight, info.height);
  }
  return { panelWidth, panelHeight, mixedSize };
}

/**
 * 依据宽高比判定页面方向。
 * @param {number} width
 * @param {number} height
 * @returns {'portrait'|'landscape'|'square'}
 */
function orientationOf(width, height) {
  const eps = 1e-6;
  if (Math.abs(width - height) <= eps) return 'square';
  return width > height ? 'landscape' : 'portrait';
}

/** pt → mm（保留 1 位小数，仅用于界面展示） */
function ptToMm(value) {
  return Math.round((value / PT_PER_MM) * 10) / 10;
}

/**
 * 执行拼版并返回新 PDF 的字节数据。
 *
 * 输出每张纸为横向（landscape）尺寸：宽 = 2 × 面板宽，高 = 面板高。
 * 面板尺寸取所有源页面「旋转后」宽高的最大值。每个原始页按原始尺寸
 * （1:1，不缩放）绘制到自己的半区并居中；尺寸不足的页面四周留白
 * （不绘制任何底色，保持透明）。带 /Rotate 的页面会先转正再放置。
 * 补的空白页不绘制任何内容。
 *
 * @param {Buffer|Uint8Array} sourceBytes 原始 PDF 字节
 * @returns {Promise<{ pdfBytes: Uint8Array, plan: object }>}
 */
async function imposePdf(sourceBytes) {
  let srcDoc;
  try {
    srcDoc = await PDFDocument.load(sourceBytes, { ignoreEncryption: false });
    // 触发一次页树读取，损坏/被截断的文件会在此处暴露异常
    srcDoc.getPageCount();
  } catch (err) {
    throw new Error('文件不是有效的 PDF（可能已损坏或被加密）');
  }
  const sourceCount = srcDoc.getPageCount();
  if (sourceCount === 0) {
    throw new Error('PDF 不包含任何页面');
  }

  const plan = buildImpositionPlan(sourceCount);

  // 混合尺寸适配：以全部页面旋转后宽高的最大值作为统一面板基准
  const pageInfos = describeSourcePages(srcDoc);
  const { panelWidth, panelHeight, mixedSize } = buildPanelLayout(pageInfos);
  plan.panel = {
    width: Math.round(panelWidth * 100) / 100,
    height: Math.round(panelHeight * 100) / 100,
    widthMm: ptToMm(panelWidth),
    heightMm: ptToMm(panelHeight),
    orientation: orientationOf(panelWidth, panelHeight),
    mixedSize,
  };

  const outDoc = await PDFDocument.create();
  // 将全部源页作为 XObject 嵌入（保留其字体/图片/批注等资源），再逐页绘制到拼版纸上。
  // drawPage 需要 embedPdf 返回的 PDFEmbeddedPage（copyPages 的页面对象不能直接绘制）。
  // 注意：嵌入的 XObject 不含 /Rotate，页面旋转由 drawSlot 绘制时补偿。
  const indices = Array.from({ length: sourceCount }, (_, i) => i);
  const embeddedPages = await outDoc.embedPdf(srcDoc, indices);

  for (const sheet of plan.sheets) {
    // 正面：左 | 右
    const front = outDoc.addPage([panelWidth * 2, panelHeight]);
    drawSlot(front, sheet.front.left, embeddedPages, pageInfos, 0, panelWidth, panelHeight);
    drawSlot(front, sheet.front.right, embeddedPages, pageInfos, panelWidth, panelWidth, panelHeight);

    // 背面：左 | 右
    const back = outDoc.addPage([panelWidth * 2, panelHeight]);
    drawSlot(back, sheet.back.left, embeddedPages, pageInfos, 0, panelWidth, panelHeight);
    drawSlot(back, sheet.back.right, embeddedPages, pageInfos, panelWidth, panelWidth, panelHeight);
  }

  outDoc.setTitle(`拼版小册子（${sourceCount} 页 / ${plan.sheets.length} 张纸）`);
  outDoc.setProducer('booklet-imposer (pdf-lib)');

  const pdfBytes = await outDoc.save();
  return { pdfBytes, plan };
}

/**
 * 计算一个源页面在面板半区内 1:1 居中放置时的 drawPage 参数。
 *
 * pdf-lib 的绘制变换顺序为 translate(x,y) → rotate(θ) → scale → Do，
 * 旋转绕放置点（嵌入页坐标系原点）进行。因此当旋转 90°/270° 时，需要把放置点
 * 沿 x 或 y 平移一个边的长度，旋转后的包围盒才恰好从 (baseX, baseY) 开始：
 *   θ =  90° → 放置点偏移 (srcHeight, 0)
 *   θ = 180° → 放置点偏移 (srcWidth, srcHeight)
 *   θ = 270° → 放置点偏移 (0, srcWidth)
 *
 * @param {{ width: number, height: number }} info 旋转后宽高 + rotation（pageInfos[i]）
 * @param {number} srcWidth  嵌入 XObject 的原始（未旋转）宽
 * @param {number} srcHeight 嵌入 XObject 的原始（未旋转）高
 * @param {number} originX   半区左上角 x（面板高从纸面底边算起，故 y 无 origin）
 * @param {number} panelWidth
 * @param {number} panelHeight
 * @returns {{ x: number, y: number, rotation: number }}
 */
function computeSlotPlacement(info, srcWidth, srcHeight, originX, panelWidth, panelHeight) {
  // 先按旋转后的包围盒居中
  const baseX = originX + (panelWidth - info.width) / 2;
  const baseY = (panelHeight - info.height) / 2;

  let x = baseX;
  let y = baseY;
  if (info.rotation === 90) {
    x = baseX + srcHeight;
  } else if (info.rotation === 180) {
    x = baseX + srcWidth;
    y = baseY + srcHeight;
  } else if (info.rotation === 270) {
    y = baseY + srcWidth;
  }
  return { x, y, rotation: info.rotation };
}

/**
 * 把一个槽位（原始页或空白页）绘制到目标纸面上。
 * 原始页面按 1:1 原始尺寸居中绘制到自己的半区，不缩放；带 /Rotate 的页面先转正。
 */
function drawSlot(targetSheet, slot, embeddedPages, pageInfos, originX, panelWidth, panelHeight) {
  if (slot.blank) {
    return; // 补的空白页：保持完全空白
  }
  const index = slot.page - 1;
  const embedded = embeddedPages[index];
  const placement = computeSlotPlacement(
    pageInfos[index],
    embedded.width,
    embedded.height,
    originX,
    panelWidth,
    panelHeight,
  );
  targetSheet.drawPage(embedded, {
    x: placement.x,
    y: placement.y,
    rotate: placement.rotation ? degrees(placement.rotation) : undefined,
  });
}

module.exports = {
  blanksForCount,
  buildImpositionPlan,
  buildPanelLayout,
  computeSlotPlacement,
  describeSourcePages,
  normalizeRotation,
  orientationOf,
  ptToMm,
  imposePdf,
};
