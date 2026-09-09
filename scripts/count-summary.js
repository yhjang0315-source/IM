#!/usr/bin/env node
/**
 * 제안요약서의 과제요약 글자수를 센다. 서식 제한이 500자다.
 *
 *   node scripts/count-summary.js
 *
 * docs/06-제안요약서.md 의 "## 과제요약" 절 본문만 읽는다.
 * 심사 서식이 공백 포함인지 제외인지 명시하지 않아 둘 다 출력한다.
 * 공백 포함 기준으로 맞춰 두면 어느 쪽이든 통과한다.
 */
const fs = require("fs");
const path = require("path");

const LIMIT = 500;
const DOC = path.join(__dirname, "..", "docs", "06-제안요약서.md");

const md = fs.readFileSync(DOC, "utf8");
const m = md.match(/## 과제요약[^\n]*\n([\s\S]*?)\n---/);
if (!m) {
  console.error("docs/06-제안요약서.md 에서 '## 과제요약' 절을 찾지 못했습니다.");
  process.exit(1);
}

const body = m[1].trim();
const withSpace = [...body].length;
const noSpace = [...body.replace(/\s/g, "")].length;

console.log(`\n${body}\n`);
console.log(`  공백 포함 ${withSpace}자 / ${LIMIT}자`);
console.log(`  공백 제외 ${noSpace}자`);

if (withSpace > LIMIT) {
  console.error(`\n  ${withSpace - LIMIT}자 초과입니다. 줄이십시오.`);
  process.exit(1);
}
console.log(`  여유 ${LIMIT - withSpace}자`);
