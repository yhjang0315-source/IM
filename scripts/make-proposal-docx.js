#!/usr/bin/env node
/**
 * 제안요약서(붙임4) 워드판.
 *
 *   node scripts/make-proposal-docx.js
 *
 * 원고는 docs/proposal.json 이고 PDF 판(make-proposal-pdf.py)과 같은 파일을 읽는다.
 * 제출 직전에 워드와 PDF 의 내용이 조용히 달라지는 사고를 막으려는 것이다.
 * 문장을 고칠 일이 있으면 이 파일이 아니라 JSON 을 고친다.
 *
 * 제출은 PDF 로 하는 편이 안전하다 — 워드는 여는 PC 의 글꼴에 따라 쪽수가 달라진다.
 * 이 파일은 서식이 워드(.docx) 제출을 요구할 때를 위한 것이다.
 */
const fs = require("fs");
const path = require("path");
const {
  AlignmentType, BorderStyle, Document, HeadingLevel, ImageRun, Packer,
  Paragraph, ShadingType, Table, TableCell, TableRow, TextRun, WidthType,
} = require("docx");

const ROOT = path.join(__dirname, "..");
const SRC = path.join(ROOT, "docs", "proposal.json");
const OUT = path.join(ROOT, "dist", "제출", "제안요약서.docx");

const FONT = "맑은 고딕";
const WIDTH = 9638;               // A4(11906) - 좌우 여백 2cm씩
const GRAY = "595959";
const RULE = "BFBFBF";

/** **굵게** 와 `코드` 만 해석한다. 원고에서 실제로 쓰는 표기가 이 둘뿐이다. */
function runs(text, base = {}) {
  const out = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let last = 0, m;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(new TextRun({ ...base, text: text.slice(last, m.index) }));
    const tok = m[0];
    if (tok.startsWith("**")) out.push(new TextRun({ ...base, text: tok.slice(2, -2), bold: true }));
    else {
      // Consolas 에는 한글이 없다. 한글이 섞인 코드는 본문 글꼴로 쓴다.
      const body = tok.slice(1, -1);
      const ascii = /^[\x00-\x7F]*$/.test(body);
      out.push(new TextRun({ ...base, text: body, font: ascii ? "Consolas" : FONT, size: 17 }));
    }
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(new TextRun({ ...base, text: text.slice(last) }));
  return out;
}

const P = (text) => new Paragraph({
  children: runs(text), spacing: { after: 100, line: 264 },
});

const H1 = (text) => new Paragraph({
  children: [new TextRun({ text, bold: true, size: 26, font: FONT })],
  spacing: { before: 320, after: 140 },
  border: { bottom: { style: BorderStyle.SINGLE, size: 8, color: RULE, space: 4 } },
  heading: HeadingLevel.HEADING_1,
});

const H2 = (text) => new Paragraph({
  children: [new TextRun({ text, bold: true, size: 22, font: FONT })],
  spacing: { before: 220, after: 90 },
  heading: HeadingLevel.HEADING_2,
});

const BULLET = (text) => new Paragraph({
  children: runs(text), bullet: { level: 0 }, spacing: { after: 60, line: 264 },
});

const FORMULA = (text) => new Paragraph({
  children: [new TextRun({ text, font: "Consolas", size: 21, bold: true })],
  alignment: AlignmentType.CENTER,
  spacing: { before: 100, after: 140 },
});

const cell = (text, w, opts = {}) => new TableCell({
  width: { size: w, type: WidthType.DXA },
  shading: opts.head ? { type: ShadingType.CLEAR, fill: "F2F2F2" } : undefined,
  margins: { top: 60, bottom: 60, left: 110, right: 110 },
  children: [new Paragraph({
    children: runs(text, opts.head ? { bold: true } : {}),
    spacing: { after: 0, line: 252 },
    alignment: opts.center ? AlignmentType.CENTER : undefined,
  })],
});

function TBL(b) {
  const cols = b.w.map((f) => Math.round(f * WIDTH));
  const center = new Set(b.center || []);
  return new Table({
    columnWidths: cols,
    width: { size: WIDTH, type: WidthType.DXA },
    rows: [
      new TableRow({
        tableHeader: true,
        children: b.head.map((h, i) => cell(h, cols[i], { head: true, center: true })),
      }),
      ...b.rows.map((r) => new TableRow({
        children: r.map((c, i) => cell(c, cols[i], { center: center.has(i) })),
      })),
    ],
  });
}

const SPACER = () => new Paragraph({ text: "", spacing: { after: 80 } });

/** 과제요약처럼 눈에 띄어야 하는 문단을 옅은 상자에 넣는다. */
const BOX = (text) => new Table({
  columnWidths: [WIDTH],
  width: { size: WIDTH, type: WidthType.DXA },
  rows: [new TableRow({
    children: [new TableCell({
      width: { size: WIDTH, type: WidthType.DXA },
      shading: { type: ShadingType.CLEAR, fill: "F7F7F7" },
      margins: { top: 160, bottom: 160, left: 200, right: 200 },
      children: [new Paragraph({ children: runs(text), spacing: { after: 0, line: 288 } })],
    })],
  })],
});

function IMAGE(b) {
  // 본문 폭 9638 DXA = 6.69in = 96dpi 기준 642px
  const w = Math.round(642 * (b.w || 1));
  return new Paragraph({
    children: [new ImageRun({
      type: "png",
      data: fs.readFileSync(path.join(ROOT, b.src.replace(/\//g, path.sep))),
      transformation: { width: w, height: Math.round(w * b.ratio) },
    })],
    alignment: AlignmentType.CENTER,
    spacing: { before: 60, after: 160 },
  });
}

// ─────────────────────────────────────────────────────────────────────────────

const src = JSON.parse(fs.readFileSync(SRC, "utf8"));
const body = [
  new Paragraph({
    children: [new TextRun({ text: src.title, bold: true, size: 36, font: FONT })],
    spacing: { after: 60 },
  }),
  new Paragraph({
    children: [new TextRun({ text: src.subtitle, size: 24, color: GRAY, font: FONT })],
    spacing: { after: 200 },
    border: { bottom: { style: BorderStyle.SINGLE, size: 12, color: "404040", space: 8 } },
  }),
];

for (const b of src.blocks) {
  switch (b.t) {
    case "h1": body.push(H1(b.text)); break;
    case "h2": body.push(H2(b.text)); break;
    case "p": body.push(P(b.text)); break;
    case "bullet": body.push(BULLET(b.text)); break;
    case "formula": body.push(FORMULA(b.text)); break;
    case "box": body.push(BOX(b.text), SPACER()); break;
    case "table": body.push(TBL(b), SPACER()); break;
    case "image": body.push(IMAGE(b)); break;
    default: throw new Error(`모르는 블록 종류: ${b.t}`);
  }
}

const doc = new Document({
  styles: {
    default: {
      document: { run: { font: FONT, size: 20 }, paragraph: { spacing: { line: 264 } } },
    },
  },
  sections: [{
    properties: { page: { margin: { top: 1134, bottom: 1134, left: 1134, right: 1134 } } },
    children: body,
  }],
});

Packer.toBuffer(doc).then((buf) => {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, buf);
  console.log(`  → ${path.relative(ROOT, OUT)}  ${Math.round(buf.length / 1024)}KB`);
});
