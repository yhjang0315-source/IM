/**
 * 상가(상권)정보 스냅샷 읽기 — build-market.js 와 build-dataset.js 가 함께 쓴다.
 *
 * zip 안의 CSV는 시도별로 쪼개져 있고(…_대구_202506.csv) 파일명은 짧은 지역명을 쓰는데,
 * 데이터 안의 시도명 값은 정식 명칭("대구광역시")이다. 여기서 그 둘을 한 이름으로 맞춘다.
 */
const fs = require("fs");
const path = require("path");
const yauzl = require("yauzl");

const REGION = process.env.REGION || "대구광역시";

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
  lon:   ["경도"],
  lat:   ["위도"],
  floor: ["층정보"],
};
const OPTIONAL = new Set(["dong", "lon", "lat", "floor"]);

const clean = (h) => String(h).replace(/^﻿/, "").replace(/[\s"']/g, "");

function resolveHeader(header) {
  const idx = {};
  for (const [key, names] of Object.entries(COLS)) {
    const i = header.findIndex((h) => names.includes(clean(h)));
    if (i < 0 && !OPTIONAL.has(key)) {
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

/**
 * 스냅샷 한 개의 각 행을 콜백으로 흘려보낸다. 대구 행만 넘긴다.
 * 반환: 읽은 전체 행 수, 지역 행 수, 인코딩, 내부 파일명
 */
async function eachRow(file, onRow) {
  const { stream, inner, regionFile, close } = await openSnapshot(file);
  let idx = null, n = 0, kept = 0, enc = null;
  try {
    for await (const { line, encoding } of linesOf(stream)) {
      if (!line.trim()) continue;
      enc = enc || encoding;
      const cells = splitCsvLine(line);
      if (!idx) { idx = resolveHeader(cells); continue; }
      n++;
      if (!sameRegion(cells[idx.sido])) continue;
      kept++;
      onRow(cells, idx);
    }
  } finally { close(); }
  return { total: n, kept, encoding: enc, inner, regionFile };
}

function listSnapshots(rawDir) {
  if (!fs.existsSync(rawDir)) return [];
  return fs.readdirSync(rawDir)
    .filter((f) => /\.(csv|zip)$/i.test(f))
    .map((f) => ({ file: f, date: snapshotDate(f) }))
    .filter((x) => x.date)
    .sort((a, b) => a.date.localeCompare(b.date));
}

module.exports = {
  REGION, RKEY, regionKey, sameRegion,
  splitCsvLine, COLS, clean, resolveHeader, snapshotDate,
  sniffEncoding, linesOf, openZipCsv, openSnapshot, eachRow, listSnapshots,
};
