'use strict';

const assert = require('assert');
const zlib = require('zlib');
const { PDFDocument, rgb, StandardFonts, degrees } = require('pdf-lib');
const fs = require('fs');
const {
  buildImpositionPlan,
  blanksForCount,
  imposePdf,
  buildPanelLayout,
  computeSlotPlacement,
  normalizeRotation,
  orientationOf,
  ptToMm,
} = require('../lib/impose');

// ---------- 1. 页序算法单测 ----------
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

// ---------- 2. 混合尺寸适配：纯几何单测 ----------
// 旋转角归一化
assert.strictEqual(normalizeRotation(0), 0);
assert.strictEqual(normalizeRotation(90), 90);
assert.strictEqual(normalizeRotation(270), 270);
assert.strictEqual(normalizeRotation(450), 90);
assert.strictEqual(normalizeRotation(-90), 270);
assert.strictEqual(normalizeRotation(-180), 180);
assert.strictEqual(normalizeRotation(undefined), 0);
assert.strictEqual(normalizeRotation(45), 0); // 非 90 的倍数：保守按 0 处理

// 统一面板取全部页面旋转后宽高的最大值
const mixedInfos = [
  { width: 300, height: 500, rotation: 0 },
  { width: 400, height: 600, rotation: 90 },  // 原始 600x400 旋转 90°
  { width: 200, height: 200, rotation: 0 },
];
const panel = buildPanelLayout(mixedInfos);
assert.strictEqual(panel.panelWidth, 400);
assert.strictEqual(panel.panelHeight, 600);
assert.strictEqual(panel.mixedSize, true);
const uniform = buildPanelLayout([
  { width: 300, height: 500 },
  { width: 300, height: 500 },
]);
assert.strictEqual(uniform.mixedSize, false);

// 方向判定
assert.strictEqual(orientationOf(300, 500), 'portrait');
assert.strictEqual(orientationOf(500, 300), 'landscape');
assert.strictEqual(orientationOf(300, 300), 'square');

// pt → mm（A4: 595.28x841.89 pt ≈ 210x297 mm）
assert.ok(Math.abs(ptToMm(595.28) - 210) < 0.2);
assert.ok(Math.abs(ptToMm(841.89) - 297) < 0.2);

// 1:1 居中：小页面在大面板中四周等距留白
{
  const info = { width: 200, height: 300, rotation: 0 };
  // 左半区（originX=0），面板 400x600
  const left = computeSlotPlacement(info, 200, 300, 0, 400, 600);
  assert.strictEqual(left.x, 100);
  assert.strictEqual(left.y, 150);
  assert.strictEqual(left.rotation, 0);
  // 右半区（originX=400）
  const right = computeSlotPlacement(info, 200, 300, 400, 400, 600);
  assert.strictEqual(right.x, 500);
  assert.strictEqual(right.y, 150);
}

// 旋转 90°：原始 400x600 → 旋转后 600x400；放置点需偏移 (srcHeight, 0)
{
  const info = { width: 600, height: 400, rotation: 90 };
  const p = computeSlotPlacement(info, 400, 600, 0, 700, 900);
  // 旋转后包围盒居中：baseX=(700-600)/2=50, baseY=(900-400)/2=250
  // drawX = baseX + srcHeight(600) = 650, drawY = 250
  assert.strictEqual(p.x, 650);
  assert.strictEqual(p.y, 250);
  assert.strictEqual(p.rotation, 90);
}

// 旋转 180°：宽高不变；放置点偏移 (srcWidth, srcHeight)
{
  const info = { width: 300, height: 500, rotation: 180 };
  const p = computeSlotPlacement(info, 300, 500, 400, 400, 600);
  // baseX=400+50=450, baseY=50 → drawX=750, drawY=550
  assert.strictEqual(p.x, 750);
  assert.strictEqual(p.y, 550);
  assert.strictEqual(p.rotation, 180);
}

// 旋转 270°：原始 600x400 → 旋转后 400x600；放置点偏移 (0, srcWidth)
{
  const info = { width: 400, height: 600, rotation: 270 };
  const p = computeSlotPlacement(info, 600, 400, 0, 500, 700);
  // baseX=50, baseY=50 → drawX=50, drawY=50+600=650
  assert.strictEqual(p.x, 50);
  assert.strictEqual(p.y, 650);
  assert.strictEqual(p.rotation, 270);
}

console.log('✅ 混合尺寸/旋转几何测试通过（统一面板 + 1:1 居中 + 旋转补偿）');

// ---------- 3. 端到端：生成 10 页同尺寸 PDF，拼版后校验 ----------
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

  // 同尺寸文档：面板即 A4 竖版，mixedSize=false
  assert.ok(Math.abs(plan.panel.width - PAGE_W) < 0.01);
  assert.ok(Math.abs(plan.panel.height - PAGE_H) < 0.01);
  assert.strictEqual(plan.panel.orientation, 'portrait');
  assert.strictEqual(plan.panel.mixedSize, false);
  assert.ok(Math.abs(plan.panel.widthMm - 210) < 0.3, `面板宽 mm ${plan.panel.widthMm}`);

  fs.writeFileSync('/tmp/out-10pages.pdf', pdfBytes);
  console.log('✅ 端到端拼版通过：10 页同尺寸 -> 3 张纸(6 面)，输出横向尺寸正确');
  console.log('   页序预览：');
  for (const s of plan.sheets) {
    const f = (p) => (p.blank ? '空白' : `${p.page}`);
    console.log(`   第${s.sheet}张 正面 [${f(s.front.left)} | ${f(s.front.right)}]  背面 [${f(s.back.left)} | ${f(s.back.right)}]`);
  }

// ---------- 4. 端到端：混合尺寸 + 混合旋转方向 ----------
  // 8 页（无需补白），各页尺寸/旋转均不同：
  const specs = [
    { w: 300, h: 500, r: 0 },    // 1: 竖 300x500
    { w: 600, h: 400, r: 90 },   // 2: 横页带 90° → 旋转后 400x600
    { w: 200, h: 700, r: 0 },    // 3: 窄长 200x700
    { w: 700, h: 500, r: 270 },  // 4: 带 270° → 旋转后 500x700
    { w: 400, h: 400, r: 0 },    // 5: 方形
    { w: 500, h: 300, r: 180 },  // 6: 横页 180° → 旋转后 500x300
    { w: 500, h: 650, r: 0 },    // 7
    { w: 600, h: 450, r: 0 },    // 8
  ];
  const mixed = await PDFDocument.create();
  for (let i = 0; i < specs.length; i++) {
    const s = specs[i];
    const page = mixed.addPage([s.w, s.h]);
    page.drawText(`MIXED ${i + 1}`, { x: 20, y: 20, size: 24, font, color: rgb(0, 0, 0) });
    if (s.r) page.setRotation(degrees(s.r));
  }
  const mixedBytes = await mixed.save();
  const mixedResult = await imposePdf(mixedBytes);
  const mixedOut = await PDFDocument.load(mixedResult.pdfBytes);
  const mixedPlan = mixedResult.plan;

  // 旋转后：最大宽 600（页2 旋转后），最大高 700（页3/页4 旋转后）
  const PANEL_W = 600;
  const PANEL_H = 700;
  assert.ok(Math.abs(mixedPlan.panel.width - PANEL_W) < 0.01, `面板宽 ${mixedPlan.panel.width}`);
  assert.ok(Math.abs(mixedPlan.panel.height - PANEL_H) < 0.01, `面板高 ${mixedPlan.panel.height}`);
  assert.strictEqual(mixedPlan.panel.orientation, 'portrait');
  assert.strictEqual(mixedPlan.panel.mixedSize, true);
  assert.strictEqual(mixedPlan.sheets.length, 2);
  assert.strictEqual(mixedOut.getPageCount(), 4);

  // 每张纸：宽 = 2 × 面板宽，高 = 面板高
  for (let i = 0; i < 4; i++) {
    const p = mixedOut.getPage(i);
    assert.ok(Math.abs(p.getWidth() - PANEL_W * 2) < 0.5, `第${i + 1}面宽 ${p.getWidth()}`);
    assert.ok(Math.abs(p.getHeight() - PANEL_H) < 0.5, `第${i + 1}面高 ${p.getHeight()}`);
  }

  // 解析第 1 张纸正面的内容流，校验各页 1:1 居中放置 + 旋转补偿。
  // 该面槽位：左 = 第8页(600x450,r0)，右 = 第1页(300x500,r0)
  const frontStream = decodeContent(mixedOut.getPage(0));
  // 第 8 页（左半区）：旋转后 600x450 → baseX=0, baseY=125，无旋转
  assert.match(frontStream, /1 0 0 1 0 125 cm/);
  // 第 1 页（右半区）：旋转后 300x500 → baseX=600+150=750, baseY=100，无旋转
  assert.match(frontStream, /1 0 0 1 750 100 cm/);

  // 第 1 张纸背面槽位：左 = 第2页（原始 600x400, r90 → 旋转后 400x600）
  const backStream = decodeContent(mixedOut.getPage(1));
  // baseX=(600-400)/2=100, baseY=(700-600)/2=50；90° 放置点 = (100+400, 50) = (500, 50)
  assert.match(backStream, /1 0 0 1 500 50 cm/);
  // 紧随其后的旋转矩阵（90° → cos≈0, sin=1）
  assert.match(backStream, /[-\d.e]+ 1 -1 [-\d.e]+ 0 0 cm/);
  // 缩放保持 1:1（xScale=yScale=1），随后绘制嵌入页
  assert.match(backStream, /1 0 0 1 0 0 cm\r?\n\/EmbeddedPdfPage[-\d]* Do/);
  // 右槽 = 第7页（500x650,r0）：baseX=600+(600-500)/2=650, baseY=25
  assert.match(backStream, /1 0 0 1 650 25 cm/);

  // 第 2 张纸正面左槽 = 第6页（原始 500x300, r180 → 旋转后 500x300）
  const sheet2Front = decodeContent(mixedOut.getPage(2));
  // baseX=(600-500)/2=50, baseY=(700-300)/2=200；180° 放置点 = (50+500, 200+300) = (550, 500)
  assert.match(sheet2Front, /1 0 0 1 550 500 cm/);
  // 180° 旋转矩阵（-1 ±0 ±0 -1）
  assert.match(sheet2Front, /-1 [-\d.e]+ [-\d.e]+ -1 0 0 cm/);

  // 右槽 = 第3页（200x700,r0）：baseX=600+(600-200)/2=800, baseY=0
  assert.match(sheet2Front, /1 0 0 1 800 0 cm/);

  // 第 2 张纸背面左槽 = 第4页（原始 700x500, r270 → 旋转后 500x700）
  const sheet2Back = decodeContent(mixedOut.getPage(3));
  // baseX=(600-500)/2=50, baseY=0；270° 放置点 = (50, 0+700) = (50, 700)
  assert.match(sheet2Back, /1 0 0 1 50 700 cm/);
  // 270° 旋转矩阵（cos≈0, sin=-1）
  assert.match(sheet2Back, /[-\d.e]+ -1 1 [-\d.e]+ 0 0 cm/);
  // 右槽 = 第5页（400x400 方形）：baseX=600+100=700, baseY=150
  assert.match(sheet2Back, /1 0 0 1 700 150 cm/);

  fs.writeFileSync('/tmp/out-mixed.pdf', mixedResult.pdfBytes);
  console.log(`✅ 端到端混合尺寸拼版通过：统一面板 ${PANEL_W}x${PANEL_H} pt`
    + `（${mixedPlan.panel.widthMm}×${mixedPlan.panel.heightMm} mm，${mixedPlan.panel.orientation}）`);
  console.log('   8 页（尺寸/旋转混合）-> 2 张纸(4 面)，各页 1:1 居中、旋转补偿正确');

  console.log('\n全部测试通过 🎉');
})().catch((err) => {
  console.error('❌ 测试失败：', err);
  process.exit(1);
});

/**
 * 读取输出页的内容流并解码为字符串。
 * 页面 Contents 为流数组：第 0 个是 "q"、最后一个是 "Q"，中间依次为每页的
 * translate / rotate / scale / Do；save 再 load 后内容多为未压缩 PDFRawStream，
 * 此处统一按是否带 FlateDecode 做一次解压。
 */
function decodeContent(outPage) {
  const contents = outPage.node.normalizedEntries().Contents;
  let text = '';
  for (let i = 0; i < contents.size(); i += 1) {
    const stream = contents.lookup(i);
    if (typeof stream.getUnencodedContents === 'function') {
      text += Buffer.from(stream.getUnencodedContents()).toString('latin1');
      continue;
    }
    const raw = stream.getContents();
    const filter = stream.dict.get('Filter');
    const filterName = filter && filter.encodedName;
    if (filterName === 'FlateDecode') {
      text += zlib.inflateSync(raw).toString('latin1');
    } else if (filterName) {
      throw new Error(`测试辅助暂不支持的内容流过滤器：${filterName}`);
    } else {
      // pdf-lib 保存时可能把页面内容流合并为 zlib 压缩流但不挂 Filter 标记，
      // 先按未压缩读取，失败再尝试 inflate。
      try {
        text += zlib.inflateSync(raw).toString('latin1');
      } catch (_) {
        text += Buffer.from(raw).toString('latin1');
      }
    }
  }
  return text;
}
