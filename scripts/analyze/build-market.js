#!/usr/bin/env node
/**
 * 소상공인시장진흥공단 상가(상권)정보 분기 스냅샷을 비교해
 * 대구 상권·업종별 소멸률과 권장 연동률을 산출한다.
 *
 *   node scripts/analyze/build-market.js
 *
 * 입력  data/raw/*.csv  (파일명에 YYYYMMDD 기준일이 들어 있어야 한다)
 * 출력  web/public/market.json
 *
 * 주의: 이 데이터에는 공식 폐업 플래그가 없다. "직전 스냅샷에 있던 상가업소번호가
 *       다음 스냅샷에서 사라졌다"를 소멸로 **추정**할 뿐이며, 실제로는 이전·상호변경·
 *       휴업일 수도 있다. 제안요약서에 이 한계를 반드시 명시할 것.
 */
const fs = require("fs");
const path = require("path");
const readline = require("readline");

const ROOT = path.join(__dirname, "..", "..");
const RAW = path.join(ROOT, "data", "raw");
const OUT = path.join(ROOT, "web", "public", "market.json");

const REGION = process.env.REGION || "대구광역시";
const MIN_COUNT = Number(process.env.MIN_COUNT || 30); // 표본이 적으면 비율이 튄다

// ---------- CSV: 따옴표 안의 쉼표를 지키는 최소 파서 ----------
function splitCsvLine(line) {
  const out = [];
  let cur = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; }
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ",") { out.push(cur); cur = ""; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

// 컬럼명이 판올림마다 조금씩 달라진다. 후보를 두고 찾는다.
const COLS = {
  id:    ["상가업소번호"],
  sido:  ["시도명", "시도_명"],
  sgg:   ["시군구명", "시군구_명"],
  dong:  ["행정동명", "행정동_명", "법정동명"],
  big:   ["상권업종대분류명"],
  mid:   ["상권업종중분류명"],
  small: ["상권업종소분류명"],
};
function resolveHeader(header) {
  const idx = {};
  for (const [key, names] of Object.entries(COLS)) {
    const i = header.findIndex((h) => names.includes(h.trim()));
    if (i < 0 && key !== "dong") throw new Error(`컬럼을 찾지 못했습니다: ${key} (${names.join("/")})\n헤더: ${header.slice(0, 20).join(", ")}`);
    idx[key] = i;
  }
  return idx;
}

function snapshotDate(filename) {
  const m = filename.match(/(20\d{6})/);
  return m ? m[1] : null;
}

/** 한 스냅샷을 읽어 { sectorKey -> Set(상가업소번호) } 로 만든다 */
async function readSnapshot(file) {
  const rl = readline.createInterface({ input: fs.createReadStream(file, "utf8"), crlfDelay: Infinity });
  let idx = null, n = 0, kept = 0;
  const bySector = new Map();
  const byDistrict = new Map();
  for await (const rawLine of rl) {
    if (!rawLine.trim()) continue;
    const cells = splitCsvLine(rawLine);
    if (!idx) { idx = resolveHeader(cells); continue; }
    n++;
    if (cells[idx.sido] !== REGION) continue;
    kept++;
    const id = cells[idx.id];
    const sector = [cells[idx.big], cells[idx.mid], cells[idx.small]].join(" > ");
    const district = `${cells[idx.sgg]}${idx.dong >= 0 ? " " + cells[idx.dong] : ""}`;
    if (!bySector.has(sector)) bySector.set(sector, new Set());
    bySector.get(sector).add(id);
    const dkey = `${district}||${cells[idx.small]}`;
    if (!byDistrict.has(dkey)) byDistrict.set(dkey, new Set());
    byDistrict.get(dkey).add(id);
  }
  return { bySector, byDistrict, total: n, kept };
}

/**
 * 권장 연동률.
 * 생존율이 높을수록 기본료 비중을 올리고, 낮을수록 매출 연동 비중을 올린다.
 * 임차인의 하방 위험이 큰 업종일수록 고정비를 줄여주는 방향이다.
 */
function recommend(annualSurvival) {
  const s = Math.max(0, Math.min(1, annualSurvival));
  // 실제 업종 연 잔존율은 대개 0.60~0.95 구간에 몰린다.
  // 그 구간을 기본료 비중 0.25~0.65 로 펴서 업종 간 차이가 드러나게 한다.
  const LO = 0.60, HI = 0.95;
  const t = Math.max(0, Math.min(1, (s - LO) / (HI - LO)));
  const baseShare = 0.25 + 0.40 * t;
  return {
    baseShare: Number(baseShare.toFixed(3)),          // 시세 임대료 중 기본료가 차지할 비중
    linkedShare: Number((1 - baseShare).toFixed(3)),  // 나머지를 매출 연동분으로
    note: s >= 0.90 ? "안정 업종 — 기본료 비중을 높게"
        : s >= 0.80 ? "보통"
        : "변동 큰 업종 — 기본료를 낮추고 연동분을 높게",
  };
}

function rate(prevSet, nextSet) {
  let gone = 0;
  for (const id of prevSet) if (!nextSet.has(id)) gone++;
  return { prev: prevSet.size, gone, disappearRate: prevSet.size ? gone / prevSet.size : null };
}

(async () => {
  if (!fs.existsSync(RAW)) { console.error(`${RAW} 가 없습니다.`); process.exit(1); }
  const files = fs.readdirSync(RAW).filter((f) => f.toLowerCase().endsWith(".csv")).sort();
  if (files.length < 2) {
    console.error(`data/raw/ 에 CSV가 ${files.length}개뿐입니다. 서로 다른 분기 2개 이상이 필요합니다.`);
    console.error(`받는 곳: https://www.data.go.kr/data/15083033/fileData.do (하단 "주기성 과거 데이터" 탭)`);
    process.exit(1);
  }

  const snaps = [];
  for (const f of files) {
    const date = snapshotDate(f);
    if (!date) { console.warn(`기준일을 못 읽어 건너뜁니다: ${f}`); continue; }
    process.stdout.write(`  읽는 중 ${f} … `);
    const s = await readSnapshot(path.join(RAW, f));
    console.log(`전국 ${s.total.toLocaleString()}행 중 ${REGION} ${s.kept.toLocaleString()}행`);
    snaps.push({ date, ...s });
  }
  snaps.sort((a, b) => a.date.localeCompare(b.date));
  if (snaps.length < 2) { console.error("유효한 스냅샷이 2개 미만입니다."); process.exit(1); }

  const first = snaps[0], last = snaps[snaps.length - 1];
  const months = (Number(last.date.slice(0, 4)) - Number(first.date.slice(0, 4))) * 12
               + (Number(last.date.slice(4, 6)) - Number(first.date.slice(4, 6)));
  if (months <= 0) { console.error("스냅샷 기간이 0개월입니다."); process.exit(1); }

  const sectors = [];
  for (const [sector, prevSet] of first.bySector) {
    if (prevSet.size < MIN_COUNT) continue;
    const nextSet = last.bySector.get(sector) || new Set();
    const r = rate(prevSet, nextSet);
    const survivalOverPeriod = 1 - r.disappearRate;
    const annualSurvival = Math.pow(survivalOverPeriod, 12 / months);
    sectors.push({
      sector,
      countFirst: r.prev,
      countLast: nextSet.size,
      disappeared: r.gone,
      disappearRate: Number(r.disappearRate.toFixed(4)),
      annualSurvival: Number(annualSurvival.toFixed(4)),
      recommended: recommend(annualSurvival),
    });
  }
  sectors.sort((a, b) => b.disappearRate - a.disappearRate);

  const districts = [];
  for (const [dkey, prevSet] of first.byDistrict) {
    if (prevSet.size < MIN_COUNT) continue;
    const nextSet = last.byDistrict.get(dkey) || new Set();
    const r = rate(prevSet, nextSet);
    const [district, small] = dkey.split("||");
    const annualSurvival = Math.pow(1 - r.disappearRate, 12 / months);
    districts.push({
      district, sector: small,
      countFirst: r.prev, countLast: nextSet.size,
      disappearRate: Number(r.disappearRate.toFixed(4)),
      annualSurvival: Number(annualSurvival.toFixed(4)),
      recommended: recommend(annualSurvival),
    });
  }
  districts.sort((a, b) => b.disappearRate - a.disappearRate);

  const out = {
    generatedAt: new Date().toISOString(),
    region: REGION,
    snapshots: snaps.map((s) => s.date),
    periodMonths: months,
    minCount: MIN_COUNT,
    caveat: "공식 폐업 플래그가 없어, 직전 스냅샷의 상가업소번호가 사라진 것을 소멸로 추정했다. 이전·상호변경·휴업이 섞여 있을 수 있다.",
    sectors,
    districts,
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2), "utf8");

  console.log(`\n  기간 ${first.date} → ${last.date} (${months}개월)`);
  console.log(`  업종 ${sectors.length}종 · 상권x업종 ${districts.length}조합 (표본 ${MIN_COUNT}개 이상만)`);
  console.log(`  → ${path.relative(ROOT, OUT)}\n`);
  console.log("  소멸률 상위 10개 업종");
  for (const s of sectors.slice(0, 10)) {
    console.log(`    ${(s.disappearRate * 100).toFixed(1).padStart(5)}%  연 잔존 ${(s.annualSurvival * 100).toFixed(1).padStart(5)}%  n=${String(s.countFirst).padStart(5)}  ${s.sector}`);
  }
})();
