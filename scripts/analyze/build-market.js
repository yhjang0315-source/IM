#!/usr/bin/env node
/**
 * 소상공인시장진흥공단 상가(상권)정보 분기 스냅샷을 비교해
 * 대구 상권·업종별 소멸률과 권장 연동률을 산출한다.
 *
 *   node scripts/analyze/build-market.js
 *
 * 입력  data/raw/*.csv 또는 *.zip  (파일명에 YYYYMMDD 기준일이 들어 있어야 한다)
 *        공공데이터포털에서 받은 zip을 풀지 않고 그대로 넣어도 된다.
 * 출력  web/public/market.json
 *
 * 주의: 이 데이터에는 공식 폐업 플래그가 없다. "직전 스냅샷에 있던 상가업소번호가
 *       다음 스냅샷에서 사라졌다"를 소멸로 **추정**할 뿐이며, 실제로는 이전·상호변경·
 *       휴업일 수도 있다. 제안요약서에 이 한계를 반드시 명시할 것.
 */
const fs = require("fs");
const path = require("path");
const yauzl = require("yauzl");

const ROOT = path.join(__dirname, "..", "..");
const RAW = path.join(ROOT, "data", "raw");
const OUT = path.join(ROOT, "web", "public", "market.json");

const REGION = process.env.REGION || "대구광역시";
const MIN_COUNT = Number(process.env.MIN_COUNT || 30); // 표본이 적으면 비율이 튄다
// 상권x업종 조합은 표본이 이보다 적으면 다음 분기에 재현되지 않는다(상관 0.29).
// scripts/analyze/train_risk.py 의 시점 분리 검증에서 나온 값이다.
const RELIABLE_DISTRICT = Number(process.env.RELIABLE_DISTRICT || 100);

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
const clean = (h) => String(h).replace(/^\uFEFF/, "").replace(/[\s"']/g, "");
function resolveHeader(header) {
  const idx = {};
  for (const [key, names] of Object.entries(COLS)) {
    const i = header.findIndex((h) => names.includes(clean(h)));
    if (i < 0 && key !== "dong") {
      throw new Error(`컬럼을 찾지 못했습니다: ${key} (${names.join("/")})\n실제 헤더: ${header.map(clean).join(" | ")}`);
    }
    idx[key] = i;
  }
  return idx;
}

function snapshotDate(filename) {
  const m = filename.match(/(20\d{6})/);
  return m ? m[1] : null;
}

// ---------- 인코딩: 공공데이터 CSV는 UTF-8일 때도, CP949(euc-kr)일 때도 있다 ----------
function sniffEncoding(head) {
  const utf8 = new TextDecoder("utf-8", { fatal: false }).decode(head);
  if (utf8.includes("상가업소번호")) return "utf-8";
  const euckr = new TextDecoder("euc-kr", { fatal: false }).decode(head);
  if (euckr.includes("상가업소번호")) return "euc-kr";
  return null;
}

/** 바이트 스트림을 인코딩 자동판별해 한 줄씩 흘려보낸다 */
async function* linesOf(stream) {
  const SNIFF = 64 * 1024;
  let head = [], headLen = 0, decoder = null, rest = "", encoding = null;
  for await (const chunk of stream) {
    if (!decoder) {
      head.push(chunk); headLen += chunk.length;
      if (headLen < SNIFF) continue;
      const buf = Buffer.concat(head);
      encoding = sniffEncoding(buf);
      if (!encoding) throw new Error("헤더에서 '상가업소번호'를 찾지 못했습니다. 상가(상권)정보 파일이 맞는지 확인하세요.");
      decoder = new TextDecoder(encoding);
      rest += decoder.decode(buf, { stream: true });
      head = null;
    } else {
      rest += decoder.decode(chunk, { stream: true });
    }
    let nl;
    while ((nl = rest.indexOf("\n")) >= 0) {
      yield { line: rest.slice(0, nl).replace(/\r$/, ""), encoding };
      rest = rest.slice(nl + 1);
    }
  }
  if (!decoder && head) {                       // 파일이 64KB보다 작은 경우
    const buf = Buffer.concat(head);
    encoding = sniffEncoding(buf);
    if (!encoding) throw new Error("헤더에서 '상가업소번호'를 찾지 못했습니다.");
    rest += new TextDecoder(encoding).decode(buf);
  } else if (decoder) {
    rest += decoder.decode();
  }
  for (const l of rest.split("\n")) if (l) yield { line: l.replace(/\r$/, ""), encoding };
}

// zip 안의 CSV는 시도별로 쪼개져 있고(…_대구_202506.csv) 파일명은 짧은 지역명을 쓴다.
// 반면 데이터 안의 시도명 값은 정식 명칭("대구광역시")이다. 양쪽을 한 이름으로 맞춘다.
const SHORT_NAME = {
  "서울특별시": "서울", "부산광역시": "부산", "대구광역시": "대구", "인천광역시": "인천",
  "광주광역시": "광주", "대전광역시": "대전", "울산광역시": "울산", "세종특별자치시": "세종",
  "경기도": "경기", "강원특별자치도": "강원", "강원도": "강원",
  "충청북도": "충북", "충청남도": "충남",
  "전북특별자치도": "전북", "전라북도": "전북", "전라남도": "전남",
  "경상북도": "경북", "경상남도": "경남",
  "제주특별자치도": "제주", "제주도": "제주",
};
const regionKey = (v) => {
  const t = String(v || "").trim();
  return SHORT_NAME[t] || t.replace(/(특별자치시|특별자치도|특별시|광역시|자치시|자치도|시|도)$/, "");
};
const RKEY = regionKey(REGION);
// REGION 을 "대구"로 주든 "대구광역시"로 주든 같게 취급한다.
const sameRegion = (v) => regionKey(v) === RKEY;

/** zip 안에서 REGION 에 해당하는 .csv 를 연다. 시도별로 안 쪼개져 있으면 가장 큰 .csv. */
function openZipCsv(file) {
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true, autoClose: false }, (err, zip) => {
      if (err) return reject(err);
      const entries = [];
      zip.on("entry", (e) => { if (/\.csv$/i.test(e.fileName)) entries.push(e); zip.readEntry(); });
      zip.on("end", () => {
        if (!entries.length) return reject(new Error(`${path.basename(file)} 안에 .csv 가 없습니다.`));
        const hit = entries.filter((e) => e.fileName.includes(RKEY));
        const pick = (hit.length ? hit : entries).sort((a, b) => b.uncompressedSize - a.uncompressedSize)[0];
        zip.openReadStream(pick, (e2, rs) =>
          e2 ? reject(e2) : resolve({ stream: rs, name: pick.fileName, zip, regionFile: hit.length > 0 }));
      });
      zip.on("error", reject);
      zip.readEntry();
    });
  });
}

async function openSnapshot(file) {
  if (/\.zip$/i.test(file)) {
    const { stream, name, zip, regionFile } = await openZipCsv(file);
    return { stream, inner: name, regionFile, close: () => zip.close() };
  }
  return { stream: fs.createReadStream(file), inner: null, regionFile: false, close: () => {} };
}

/** 한 스냅샷을 읽어 { sectorKey -> Set(상가업소번호) } 로 만든다 */
async function readSnapshot(file) {
  const { stream, inner, regionFile, close } = await openSnapshot(file);
  let idx = null, n = 0, kept = 0, enc = null;
  const bySector = new Map();
  const byDistrict = new Map();
  try {
    for await (const { line, encoding } of linesOf(stream)) {
      if (!line.trim()) continue;
      enc = enc || encoding;
      const cells = splitCsvLine(line);
      if (!idx) { idx = resolveHeader(cells); continue; }
      n++;
      if (!sameRegion(cells[idx.sido])) continue;
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
  } finally { close(); }
  return { bySector, byDistrict, total: n, kept, encoding: enc, inner, regionFile };
}

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const i = (sorted.length - 1) * p;
  const lo = Math.floor(i), hi = Math.ceil(i);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

/**
 * 권장 연동률.
 * 생존율이 높을수록 기본료 비중을 올리고, 낮을수록 매출 연동 비중을 올린다.
 * 임차인의 하방 위험이 큰 업종일수록 고정비를 줄여주는 방향이다.
 *
 * 눈금은 임의로 정하지 않고 이번 분석의 실제 잔존율 분포에서 가져온다.
 * 하위 5% 업종을 기본료 25%, 상위 5% 업종을 기본료 65%에 놓고 그 사이를 편다.
 * 구간을 고정값으로 박아두면 실제 분포와 어긋나 상·하한에 업종이 뭉친다.
 */
function makeRecommend(lo, hi) {
  return function recommend(annualSurvival) {
    const s = Math.max(0, Math.min(1, annualSurvival));
    const t = hi > lo ? Math.max(0, Math.min(1, (s - lo) / (hi - lo))) : 0.5;
    const baseShare = 0.25 + 0.40 * t;
    return {
      baseShare: Number(baseShare.toFixed(3)),          // 시세 임대료 중 기본료가 차지할 비중
      linkedShare: Number((1 - baseShare).toFixed(3)),  // 나머지를 매출 연동분으로
      percentile: Number(t.toFixed(3)),                 // 같은 지역 업종들 사이에서의 상대 위치
      note: t >= 0.67 ? "안정 업종 — 기본료 비중을 높게"
          : t >= 0.33 ? "보통"
          : "변동 큰 업종 — 기본료를 낮추고 연동분을 높게",
    };
  };
}

function rate(prevSet, nextSet) {
  let gone = 0;
  for (const id of prevSet) if (!nextSet.has(id)) gone++;
  return { prev: prevSet.size, gone, disappearRate: prevSet.size ? gone / prevSet.size : null };
}

/** --inspect: 헤더와 실제 값을 눈으로 확인한다 */
async function inspect(file) {
  const { stream, inner, close } = await openSnapshot(file);
  let idx = null, header = null, n = 0, enc = null;
  const sidoCount = new Map();
  const samples = [];
  try {
    for await (const { line, encoding } of linesOf(stream)) {
      if (!line.trim()) continue;
      enc = enc || encoding;
      const cells = splitCsvLine(line);
      if (!header) {
        header = cells;
        console.log(`\n  파일      ${path.basename(file)}${inner ? "  →  " + inner : ""}`);
        console.log(`  인코딩    ${enc}`);
        console.log(`  컬럼 ${header.length}개:`);
        header.forEach((h, i) => console.log(`    [${String(i).padStart(2)}] ${clean(h)}`));
        try { idx = resolveHeader(cells); console.log(`\n  매칭된 컬럼 위치: ${JSON.stringify(idx)}`); }
        catch (e) { console.log(`\n  ! ${e.message}`); }
        continue;
      }
      n++;
      if (idx && idx.sido >= 0) {
        const v = cells[idx.sido];
        sidoCount.set(v, (sidoCount.get(v) || 0) + 1);
      }
      if (samples.length < 3) samples.push(cells);
      if (n >= 300000) break;               // 앞부분만 봐도 충분하다
    }
  } finally { close(); }

  console.log(`\n  앞 ${n.toLocaleString()}행 기준 시도명 값 분포 (상위 25개)`);
  [...sidoCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25)
    .forEach(([v, c]) => console.log(`    ${String(c).padStart(8)}  "${v}"`));

  console.log(`\n  샘플 행 (앞 12개 컬럼)`);
  samples.forEach((r, i) => console.log(`    ${i + 1}: ${r.slice(0, 12).map((c) => `"${c}"`).join(", ")}`));
  console.log(`\n  현재 REGION 설정값: "${REGION}"`);
  console.log(`  위 분포에 이 값이 없으면 REGION 을 바꿔 실행하세요.`);
  console.log(`    Windows:  set REGION=대구 && npm run market\n`);
}

(async () => {
  if (!fs.existsSync(RAW)) { console.error(`${RAW} 가 없습니다.`); process.exit(1); }
  if (process.argv.includes("--inspect")) {
    const f = fs.readdirSync(RAW).filter((x) => /\.(csv|zip)$/i.test(x)).sort()[0];
    if (!f) { console.error("data/raw/ 가 비어 있습니다."); process.exit(1); }
    await inspect(path.join(RAW, f));
    return;
  }
  const files = fs.readdirSync(RAW).filter((f) => /\.(csv|zip)$/i.test(f)).sort();
  if (files.length < 2) {
    console.error(`data/raw/ 에 CSV/ZIP이 ${files.length}개뿐입니다. 서로 다른 분기 2개 이상이 필요합니다.`);
    console.error(`받는 곳: https://www.data.go.kr/data/15083033/fileData.do (하단 "주기성 과거 데이터" 탭)`);
    process.exit(1);
  }

  const snaps = [];
  for (const f of files) {
    const date = snapshotDate(f);
    if (!date) { console.warn(`기준일을 못 읽어 건너뜁니다: ${f}`); continue; }
    process.stdout.write(`  읽는 중 ${f} … `);
    const s = await readSnapshot(path.join(RAW, f));
    console.log(`${s.regionFile ? RKEY + " 파일" : "전국"} ${s.total.toLocaleString()}행 중 ${REGION} ${s.kept.toLocaleString()}행  [${s.encoding}${s.inner ? " · " + s.inner : ""}]`);
    if (s.kept === 0) {
      console.warn(`    ! ${REGION} 행이 0건입니다.`);
      console.warn(`      node scripts/analyze/build-market.js --inspect  로 실제 시도명 값을 확인하세요.`);
    }
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
    });
  }
  sectors.sort((a, b) => b.disappearRate - a.disappearRate);

  // 눈금을 업종 잔존율 분포에서 잡는다(하위 5% ~ 상위 5%).
  const surv = sectors.map((x) => x.annualSurvival).sort((a, b) => a - b);
  const scaleLo = percentile(surv, 0.05), scaleHi = percentile(surv, 0.95);
  const recommend = makeRecommend(scaleLo, scaleHi);
  for (const x of sectors) x.recommended = recommend(x.annualSurvival);

  const districts = [];
  for (const [dkey, prevSet] of first.byDistrict) {
    if (prevSet.size < MIN_COUNT) continue;
    const nextSet = last.byDistrict.get(dkey) || new Set();
    const r = rate(prevSet, nextSet);
    const [district, small] = dkey.split("||");
    const annualSurvival = Math.pow(1 - r.disappearRate, 12 / months);
    districts.push({
      district, sector: small,
      // 표본이 모자란 조합은 값을 보여주되 근거로 쓰지 않는다
      reliable: r.prev >= RELIABLE_DISTRICT,
      countFirst: r.prev, countLast: nextSet.size,
      disappearRate: Number(r.disappearRate.toFixed(4)),
      annualSurvival: Number(annualSurvival.toFixed(4)),
      recommended: recommend(annualSurvival),   // 업종과 같은 눈금을 써야 서로 비교된다
    });
  }
  districts.sort((a, b) => b.disappearRate - a.disappearRate);

  const out = {
    generatedAt: new Date().toISOString(),
    region: REGION,
    snapshots: snaps.map((s) => s.date),
    periodMonths: months,
    minCount: MIN_COUNT,
    reliableDistrictSample: RELIABLE_DISTRICT,
    scale: {
      basis: "업종별 연 잔존율의 5~95 백분위를 기본료 비중 25~65%로 매핑",
      survivalP5: scaleLo === null ? null : Number(scaleLo.toFixed(4)),
      survivalP95: scaleHi === null ? null : Number(scaleHi.toFixed(4)),
    },
    caveat: "공식 폐업 플래그가 없어, 직전 스냅샷의 상가업소번호가 사라진 것을 소멸로 추정했다. 이전·상호변경·휴업이 섞여 있을 수 있다.",
    sectors,
    districts,
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2), "utf8");

  console.log(`\n  기간 ${first.date} → ${last.date} (${months}개월)`);
  console.log(`  업종 ${sectors.length}종 · 상권x업종 ${districts.length}조합 (표본 ${MIN_COUNT}개 이상만)`);
  console.log(`  → ${path.relative(ROOT, OUT)}\n`);
  const rel = districts.filter((d) => d.reliable).length;
  console.log(`  상권x업종 중 표본 ${RELIABLE_DISTRICT}개 이상(권장값 근거로 쓸 수 있는 것): ${rel}개`);
  console.log("  소멸률 상위 10개 업종");
  for (const s of sectors.slice(0, 10)) {
    console.log(`    ${(s.disappearRate * 100).toFixed(1).padStart(5)}%  연 잔존 ${(s.annualSurvival * 100).toFixed(1).padStart(5)}%  n=${String(s.countFirst).padStart(5)}  ${s.sector}`);
  }
})();
