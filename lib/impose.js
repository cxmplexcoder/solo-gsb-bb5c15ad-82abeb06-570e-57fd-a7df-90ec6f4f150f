'use strict';

const { PDFDocument } = require('pdf-lib');

/**
 * 骑马钉（saddle-stitch）拼版核心逻辑。
 *
 * 每张纸正反两页（两个 output PDF page），每排放两个原始页，即每张纸容纳 4 页：
 *   - 正面（front）：末页(左) | 首页(右)
 *   - 背面（back） ：第 2 页(左) | 倒数第 2 页(右)
 *   其余纸张按同样方式逐层向内递进。
 * 页数不是 4 的倍数时，在文档末尾补空白页。
 */

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
 * 执行拼版并返回新 PDF 的字节数据。
 *
 * 输出每张纸为横向（landscape）尺寸：宽 = 2 × 原页宽，高 = 原页高。
 * 每个原始页按其原始尺寸（1:1，不缩放）绘制到对应半区，保持原页面尺寸；
 * 尺寸不一致的页面在半区内居中放置。补的空白页不绘制任何内容。
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

  // 以第一页尺寸作为面板基准（小型印刷店的小册子通常页面尺寸统一）
  const firstPage = srcDoc.getPage(0);
  const panelWidth = firstPage.getWidth();
  const panelHeight = firstPage.getHeight();

  const outDoc = await PDFDocument.create();
  // 将全部源页作为 XObject 嵌入（保留其字体/图片/批注等资源），再逐页绘制到拼版纸上。
  // drawPage 需要 embedPdf 返回的 PDFEmbeddedPage（copyPages 的页面对象不能直接绘制）。
  const indices = Array.from({ length: sourceCount }, (_, i) => i);
  const embeddedPages = await outDoc.embedPdf(srcDoc, indices);

  for (const sheet of plan.sheets) {
    // 正面：左 | 右
    const front = outDoc.addPage([panelWidth * 2, panelHeight]);
    drawSlot(front, sheet.front.left, embeddedPages, 0, panelWidth, panelHeight);
    drawSlot(front, sheet.front.right, embeddedPages, panelWidth, panelWidth, panelHeight);

    // 背面：左 | 右
    const back = outDoc.addPage([panelWidth * 2, panelHeight]);
    drawSlot(back, sheet.back.left, embeddedPages, 0, panelWidth, panelHeight);
    drawSlot(back, sheet.back.right, embeddedPages, panelWidth, panelWidth, panelHeight);
  }

  outDoc.setTitle(`拼版小册子（${sourceCount} 页 / ${plan.sheets.length} 张纸）`);
  outDoc.setProducer('booklet-imposer (pdf-lib)');

  const pdfBytes = await outDoc.save();
  return { pdfBytes, plan };
}

/**
 * 把一个槽位（原始页或空白页）绘制到目标纸面上。
 * 原始页面按 1:1 原始尺寸居中绘制到自己的半区，不缩放。
 */
function drawSlot(targetSheet, slot, embeddedPages, originX, panelWidth, panelHeight) {
  if (slot.blank) {
    return; // 补的空白页：保持完全空白
  }
  const embedded = embeddedPages[slot.page - 1];
  const srcWidth = embedded.width;
  const srcHeight = embedded.height;
  const offsetX = originX + (panelWidth - srcWidth) / 2;
  const offsetY = (panelHeight - srcHeight) / 2;
  targetSheet.drawPage(embedded, { x: offsetX, y: offsetY });
}

module.exports = {
  blanksForCount,
  buildImpositionPlan,
  imposePdf,
};
