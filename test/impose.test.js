'use strict';

const assert = require('assert');
const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');
const fs = require('fs');
const { buildImpositionPlan, blanksForCount, imposePdf } = require('../lib/impose');

// ---------- 1. 页序算法单测 ----------
function planToArray(plan) {
  return plan.sheets.flatMap((s) => [
    ['F', s.front.left.page, s.front.right.page],
    ['B', s.back.left.page, s.back.right.page],
  ]);
}

assert.strictEqual(blanksForCount(1), 3);
assert.strictEqual(blanksForCount(4), 0);
assert.strictEqual(blanksForCount(5), 3);
assert.strictEqual(blanksForCount(10), 2);
assert.strictEqual(blanksForCount(12), 0);

// 8 页：F[8|1] B[2|7], F[6|3] B[4|5]
const p8 = buildImpositionPlan(8);
assert.deepStrictEqual(p8.sheets[0].front.left, { page: 8, blank: false });
assert.deepStrictEqual(p8.sheets[0].front.right, { page: 1, blank: false });
assert.deepStrictEqual(p8.sheets[0].back.left, { page: 2, blank: false });
assert.deepStrictEqual(p8.sheets[0].back.right, { page: 7, blank: false });
assert.deepStrictEqual(p8.sheets[1].front.left, { page: 6, blank: false });
assert.deepStrictEqual(p8.sheets[1].front.right, { page: 3, blank: false });
assert.deepStrictEqual(p8.sheets[1].back.left, { page: 4, blank: false });
assert.deepStrictEqual(p8.sheets[1].back.right, { page: 5, blank: false });
assert.strictEqual(p8.paddedCount, 0);

// 5 页 -> 补 3 空白（位置 6,7,8 为空白）
const p5 = buildImpositionPlan(5);
assert.strictEqual(p5.paddedCount, 3);
assert.strictEqual(p5.sheets[0].front.left.blank, true);   // 8 = blank
assert.strictEqual(p5.sheets[0].front.right.page, 1);
assert.strictEqual(p5.sheets[0].back.left.page, 2);
assert.strictEqual(p5.sheets[0].back.right.blank, true);   // 7 = blank
assert.strictEqual(p5.sheets[1].front.left.blank, true);   // 6 = blank
assert.strictEqual(p5.sheets[1].back.left.page, 4);
assert.strictEqual(p5.sheets[1].back.right.page, 5);

// 所有槽位覆盖：每张纸 4 页，非空白页恰好 1..N
function coverage(n) {
  const plan = buildImpositionPlan(n);
  assert.strictEqual(plan.totalCount % 4, 0);
  const pages = [];
  for (const s of plan.sheets) {
    for (const side of ['front', 'back']) {
      for (const pos of ['left', 'right']) {
        const slot = s[side][pos];
        if (!slot.blank) pages.push(slot.page);
      }
    }
  }
  assert.strictEqual(pages.length, n, `n=${n} coverage count`);
  assert.deepStrictEqual([...pages].sort((a, b) => a - b), [...Array(n).keys()].map((i) => i + 1));
}
for (let n = 1; n <= 40; n++) coverage(n);

console.log('✅ 页序算法测试通过 (1..40 页全覆盖)');

// ---------- 2. 端到端：生成 10 页 PDF，拼版后校验 ----------
(async () => {
  const src = await PDFDocument.create();
  const font = await src.embedFont(StandardFonts.Helvetica);
  const PAGE_W = 595.28; // A4 竖版 (pt)
  const PAGE_H = 841.89;
  for (let i = 1; i <= 10; i++) {
    const page = src.addPage([PAGE_W, PAGE_H]);
    page.drawText(`PAGE ${i}`, { x: 200, y: 400, size: 40, font, color: rgb(0, 0, 0) });
  }
  const srcBytes = await src.save();

  const { pdfBytes, plan } = await imposePdf(srcBytes);
  const out = await PDFDocument.load(pdfBytes);

  // 10 页 -> 12 面板 -> 3 张纸 -> 6 个输出页面
  assert.strictEqual(out.getPageCount(), 6, '输出页数应为 2 × 张数');
  assert.strictEqual(plan.sheets.length, 3);
  assert.strictEqual(plan.paddedCount, 2);

  // 输出页面为横向 A3：宽 = 2×A4宽，高 = A4高
  const outPage = out.getPage(0);
  assert.ok(Math.abs(outPage.getWidth() - PAGE_W * 2) < 0.5, `宽度 ${outPage.getWidth()}`);
  assert.ok(Math.abs(outPage.getHeight() - PAGE_H) < 0.5, `高度 ${outPage.getHeight()}`);

  fs.writeFileSync('/tmp/out-10pages.pdf', pdfBytes);
  console.log('✅ 端到端拼版通过：10 页 -> 3 张纸(6 面)，输出横向尺寸正确');
  console.log('   页序预览：');
  for (const s of plan.sheets) {
    const f = (p) => (p.blank ? '空白' : `${p.page}`);
    console.log(`   第${s.sheet}张 正面 [${f(s.front.left)} | ${f(s.front.right)}]  背面 [${f(s.back.left)} | ${f(s.back.right)}]`);
  }
})();
