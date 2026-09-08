#!/usr/bin/env node
/**
 * 폐업(소멸) 위험 예측 모델의 학습 데이터셋을 만든다.
 *
 *   node scripts/analyze/build-dataset.js
 *
 * 입력  data/raw/*.zip  (분기 스냅샷 3개 이상 권장)
 * 출력  data/processed/stores.csv
 *
 * 한 행 = 점포 하나 × 관측 구간 하나.
 * 레이블 gone = 다음 스냅샷에서 그 상가업소번호가 사라졌는가.
 *
 * 주의: 공식 폐업 플래그가 없어 "사라짐"을 소멸로 추정한다.
 *       이전·상호변경·휴업이 섞여 있으므로 모델도 그 혼합을 학습한다.
 *       제안요약서와 화면에 이 한계를 명시할 것.
 */
const fs = require("fs");
const path = require("path");
const { eachRow, listSnapshots, REGION, splitCsvLine } = require("./lib/snapshot");

const ROOT = path.join(__dirname, "..", "..");
const RAW = path.join(ROOT, "data", "raw");
const OUT_DIR = path.join(ROOT, "data", "processed");
const OUT = path.join(OUT_DIR, "stores.csv");
// 대구 시내버스 정류소 위치정보 (공공데이터포털 15050946). 저장소에 함께 둔다.
const BUS = path.join(ROOT, "data", "external", "daegu_bus_stops.csv");

// 경쟁 밀도를 셀 반경(m). 도보 상권 규모를 감안한 값.
const RADIUS_M = 200;
// 위경도를 대략적인 격자로 바꿀 때 쓰는 셀 크기. 반경보다 크게 잡아 이웃 셀만 훑는다.
const CELL_DEG_LAT = 0.0027;                    // 약 300m
const CELL_DEG_LON = 0.0034;                    // 대구 위도에서 약 300m

const num = (v) => { const n = Number(String(v ?? "").trim()); return Number.isFinite(n) ? n : null; };

/**
 * 버스 정류소를 읽어 격자에 담는다.
 * 대구에는 개방된 유동인구 데이터가 없다. 정류장 밀도와 경유노선수가
 * 지금 구할 수 있는 유일한 대중교통 유동량 대리변수다.
 */
function loadBusStops() {
  if (!fs.existsSync(BUS)) {
    console.warn(`  ! ${path.relative(ROOT, BUS)} 가 없어 대중교통 피처를 건너뜁니다.`);
    return null;
  }
  const text = fs.readFileSync(BUS, "utf8").replace(/^﻿/, "");
  const lines = text.split(new RegExp("\r?\n")).filter((l) => l.trim());
  const head = splitCsvLine(lines[0]).map((h) => h.trim());
  const iLat = head.indexOf("위도"), iLon = head.indexOf("경도"), iRoutes = head.indexOf("경유노선수");
  if (iLat < 0 || iLon < 0) { console.warn("  ! 정류소 파일에 위도/경도가 없습니다."); return null; }

  const grid = new Map();
  let n = 0;
  for (const line of lines.slice(1)) {
    const c = splitCsvLine(line);
    const lat = num(c[iLat]), lon = num(c[iLon]);
    if (lat === null || lon === null) continue;
    const routes = iRoutes >= 0 ? (num(c[iRoutes]) ?? 0) : 0;
    const k = cellKey(lat, lon);
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push({ lat, lon, routes });
    n++;
  }
  console.log(`  버스 정류소 ${n.toLocaleString()}곳 적재`);
  return grid;
}

/** 점포 반경 안의 정류장 수·경유노선 합계와 최근접 정류장 거리 */
function busFeatures(grid, lat, lon) {
  if (!grid || lat === null || lon === null) return { stops: null, routes: null, nearest: null };
  const ci = Math.floor(lat / CELL_DEG_LAT), cj = Math.floor(lon / CELL_DEG_LON);
  let stops = 0, routes = 0, nearest = Infinity;
  for (let di = -1; di <= 1; di++) {
    for (let dj = -1; dj <= 1; dj++) {
      const bucket = grid.get(`${ci + di}:${cj + dj}`);
      if (!bucket) continue;
      for (const b of bucket) {
        const d = distM(lat, lon, b.lat, b.lon);
        if (d < nearest) nearest = d;
        if (d <= RADIUS_M) { stops++; routes += b.routes; }
      }
    }
  }
  // 이웃 셀(±300m)까지만 훑으므로 그 밖은 거리 미상으로 둔다
  return { stops, routes, nearest: Number.isFinite(nearest) ? Math.round(nearest) : null };
}

/** 층정보에서 지상 층수를 뽑는다. "1", "B1", "지하1", "" 등이 섞여 있다. */
function floorOf(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return { floor: null, basement: 0 };
  if (/^(B|지하)/i.test(s)) return { floor: null, basement: 1 };
  const n = Number(s.replace(/[^0-9-]/g, ""));
  if (!Number.isFinite(n) || n === 0) return { floor: null, basement: 0 };
  return { floor: n < 0 ? null : n, basement: n < 0 ? 1 : 0 };
}

const cellKey = (lat, lon) =>
  `${Math.floor(lat / CELL_DEG_LAT)}:${Math.floor(lon / CELL_DEG_LON)}`;

/** 두 좌표 사이 거리(m). 대구 규모에서는 평면 근사로 충분하다. */
function distM(aLat, aLon, bLat, bLon) {
  const dLat = (aLat - bLat) * 111_000;
  const dLon = (aLon - bLon) * 111_000 * Math.cos((aLat * Math.PI) / 180);
  return Math.hypot(dLat, dLon);
}

async function readSnapshot(file) {
  const stores = new Map();   // id -> row
  const meta = await eachRow(path.join(RAW, file), (c, i) => {
    const lat = num(c[i.lat]), lon = num(c[i.lon]);
    const { floor, basement } = floorOf(i.floor >= 0 ? c[i.floor] : "");
    stores.set(c[i.id], {
      id: c[i.id],
      big: c[i.big], mid: c[i.mid], small: c[i.small],
      sgg: c[i.sgg], dong: i.dong >= 0 ? c[i.dong] : "",
      lat, lon, floor, basement,
    });
  });
  return { stores, meta };
}

/** 각 점포 주변 RADIUS_M 안의 전체 점포 수와 동종업종 수를 센다. */
function densities(stores) {
  const grid = new Map();
  for (const s of stores.values()) {
    if (s.lat === null || s.lon === null) continue;
    const k = cellKey(s.lat, s.lon);
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(s);
  }
  const out = new Map();
  for (const s of stores.values()) {
    if (s.lat === null || s.lon === null) { out.set(s.id, { all: null, same: null }); continue; }
    const ci = Math.floor(s.lat / CELL_DEG_LAT), cj = Math.floor(s.lon / CELL_DEG_LON);
    let all = 0, same = 0;
    for (let di = -1; di <= 1; di++) {
      for (let dj = -1; dj <= 1; dj++) {
        const bucket = grid.get(`${ci + di}:${cj + dj}`);
        if (!bucket) continue;
        for (const t of bucket) {
          if (t.id === s.id) continue;
          if (distM(s.lat, s.lon, t.lat, t.lon) > RADIUS_M) continue;
          all++;
          if (t.small === s.small) same++;
        }
      }
    }
    out.set(s.id, { all, same });
  }
  return out;
}

(async () => {
  const snaps = listSnapshots(RAW);
  if (snaps.length < 2) {
    console.error(`data/raw/ 에 분기 스냅샷이 ${snaps.length}개뿐입니다. 2개 이상 필요합니다.`);
    process.exit(1);
  }

  const loaded = [];
  for (const s of snaps) {
    process.stdout.write(`  읽는 중 ${s.file} … `);
    const { stores, meta } = await readSnapshot(s.file);
    console.log(`${REGION} ${stores.size.toLocaleString()}개 [${meta.encoding}]`);
    loaded.push({ ...s, stores });
  }

  console.log("  주변 점포 밀도 계산 중 …");
  for (const snap of loaded) snap.density = densities(snap.stores);
  const busGrid = loadBusStops();

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const cols = [
    "obs_date", "next_date", "months", "id",
    "big", "mid", "small", "sgg", "dong",
    "floor", "basement", "dens_all", "dens_same",
    "bus_stops", "bus_routes", "bus_nearest",
    "is_new", "gone",
  ];
  const rows = [cols.join(",")];
  const q = (v) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };

  let total = 0, gones = 0;
  for (let i = 0; i < loaded.length - 1; i++) {
    const cur = loaded[i], nxt = loaded[i + 1];
    const prev = i > 0 ? loaded[i - 1] : null;
    const months =
      (Number(nxt.date.slice(0, 4)) - Number(cur.date.slice(0, 4))) * 12 +
      (Number(nxt.date.slice(4, 6)) - Number(cur.date.slice(4, 6)));

    for (const s of cur.stores.values()) {
      const d = cur.density.get(s.id) || { all: null, same: null };
      const bus = busFeatures(busGrid, s.lat, s.lon);
      const gone = nxt.stores.has(s.id) ? 0 : 1;
      // 직전 스냅샷에 없었으면 신규 개업. 첫 스냅샷은 알 수 없어 비운다.
      const isNew = prev ? (prev.stores.has(s.id) ? 0 : 1) : "";
      rows.push([
        cur.date, nxt.date, months, s.id,
        s.big, s.mid, s.small, s.sgg, s.dong,
        s.floor, s.basement, d.all, d.same,
        bus.stops, bus.routes, bus.nearest,
        isNew, gone,
      ].map(q).join(","));
      total++; gones += gone;
    }
  }

  fs.writeFileSync(OUT, rows.join("\n") + "\n", "utf8");
  console.log(`\n  ${total.toLocaleString()}행 · 소멸 ${gones.toLocaleString()}건 (${((gones / total) * 100).toFixed(1)}%)`);
  console.log(`  → ${path.relative(ROOT, OUT)}`);
  console.log(`\n  다음: python scripts/analyze/train_risk.py`);
})();
