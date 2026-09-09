import { ethers } from "ethers";
import cfg from "./deployed.json";

/**
 * 데모용 서명 키. 배포 스크립트가 deployed.json 에 넣는다.
 * 로컬은 하드햇 기본 계정, 공개 테스트넷은 .env 의 데모 전용 계정이다.
 * 실제 서비스에서는 은행 앱 내장 키나 서버 서명으로 대체된다 — 화면이 키를 들고 있으면 안 된다.
 */
const KEYS = cfg.keys;

// cacheTimeout: -1 — 연속 트랜잭션에서 nonce가 캐시된 값으로 굳는 것을 막는다 (자동 채굴 로컬 체인)
export const provider = new ethers.JsonRpcProvider(cfg.rpc, undefined, { cacheTimeout: -1, staticNetwork: true });
export const address = cfg.address;
export const site = cfg.site;
export const roles = cfg.roles;
export const suggested = cfg.suggested;
export const startMonth = cfg.startMonth || "2026-10";
export const chainName = cfg.network || "localhost";
export const explorer = cfg.explorer || null;
export const txLink = (hash) => (explorer ? `${explorer}/tx/${hash}` : null);
export const FIXED_RENT = BigInt(cfg.fixedRentComparison);

export const ROLE_LABEL = { landlord: "임대인", tenant: "임차인", gateway: "게이트웨이(은행)", mediator: "조정인" };
export const ZERO = "0x0000000000000000000000000000000000000000";

const wallets = {};
const signer = (role) => (wallets[role] ||= new ethers.Wallet(KEYS[role], provider));
const as = (role) => new ethers.Contract(cfg.address, cfg.abi, signer(role));
export const read = new ethers.Contract(cfg.address, cfg.abi, provider);

export const won = (v) => Number(v).toLocaleString("ko-KR");

/**
 * 연동률(bp)을 퍼센트 문자열로. 800 → "8", 935 → "9.35".
 * toFixed(1) 을 쓰면 935bp 가 화면마다 9.3% 와 9.35% 로 갈린다.
 * 계약 조건 숫자가 화면마다 다르게 보이면 이 서비스는 신뢰를 잃는다.
 */
export const bpsPct = (bps) => String(Math.round(Number(bps)) / 100);
export const pct = (a, b) => (b === 0n || b === 0 ? 0 : (Number(a) * 100) / Number(b));
export const short = (h) => (h ? `${h.slice(0, 6)}…${h.slice(-4)}` : "");
export const roleOf = (addr) =>
  Object.keys(roles).find((k) => roles[k].toLowerCase() === String(addr).toLowerCase()) || null;

/** 해당 기간의 매출 게시 예정일 = 그 달이 끝난 다음 달 5일. 결제망 집계 마감을 가정한 값이다. */
export function monthDue(period) {
  const [y, m] = startMonth.split("-").map(Number);
  const idx = (m - 1) + Number(period); // 다음 달
  return new Date(y + Math.floor(idx / 12), idx % 12, 5);
}

/** 기간 번호(1부터) → "2026년 12월" */
export function monthLabel(period) {
  const [y, m] = startMonth.split("-").map(Number);
  const idx = (m - 1) + (Number(period) - 1);
  return `${y + Math.floor(idx / 12)}년 ${(idx % 12) + 1}월`;
}

/** 컨트랙트 상태와 조건. Draft(0)이면 terms는 null. */
export async function loadLease() {
  // 기한 판단은 체인 시각으로 해야 한다. 브라우저 시계를 쓰면 로컬 체인에서 시간을 돌렸을 때 어긋난다.
  const [st, t, med, dep, blk, siteText] = await Promise.all([
    read.state(), read.terms(), read.mediator(), read.depositPaid(), provider.getBlock("latest"),
    read.site().catch(() => ""),
  ]);
  const chainNow = Number(blk.timestamp) * 1000;
  const state = Number(st); // 0 Draft 1 Active 2 Ended
  const terms = state === 0 ? null : {
    baseRent: t.baseRent, pctBps: Number(t.pctBps),
    floorRent: t.floorRent, capRent: t.capRent, totalPeriods: Number(t.totalPeriods),
    deposit: t.deposit,
  };
  return { state, terms, mediator: med, depositPaid: dep, chainNow, site: siteText };
}

/** 화면에서도 같은 식으로 미리 계산할 수 있게 둔다. 체인의 quote()와 동일한 식. */
export function quoteLocal(t, revenue) {
  const r = BigInt(t.baseRent) + (BigInt(revenue) * BigInt(t.pctBps)) / 10_000n;
  if (r < BigInt(t.floorRent)) return BigInt(t.floorRent);
  if (r > BigInt(t.capRent)) return BigInt(t.capRent);
  return r;
}

// ---------- 조건 확정 (Draft → Active) ----------
/** 계약 목적물 한 줄. 계약서의 "무엇을 빌리는가"에 해당한다. */
export function siteLine(d) {
  return [d.siteName, d.siteAddress, d.siteArea ? `${d.siteArea}평` : null, d.siteUse]
    .map((x) => String(x || "").trim()).filter(Boolean).join(" · ");
}
export const hashOf = (text) => ethers.keccak256(ethers.toUtf8Bytes(String(text)));

/** 체인의 목적물 문자열을 화면용으로 쪼갠다. 없으면 배포 설정의 기본값. */
export function siteParts(chainSite) {
  const raw = String(chainSite || "").trim();
  if (!raw) return { name: site.name, rest: site.district, full: `${site.name} · ${site.district}` };
  const [first, ...rest] = raw.split("·").map((x) => x.trim()).filter(Boolean);
  return { name: first, rest: rest.join(" · "), full: raw };
}

export function termsDigest(t) {
  return ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
    ["address", "uint256", "uint16", "uint256", "uint256", "uint16", "uint256", "address", "bytes32"],
    [cfg.address, BigInt(t.baseRent), Number(t.pctBps), BigInt(t.floorRent), BigInt(t.capRent),
     Number(t.totalPeriods), BigInt(t.deposit || 0), t.mediator || ZERO,
     hashOf(t.site !== undefined ? t.site : siteLine(t))]));
}
export function signTerms(role, t) {
  return signer(role).signMessage(ethers.getBytes(termsDigest(t)));
}
export async function activate(role, t, sigL, sigT) {
  const tx = await as(role).activate(
    [BigInt(t.baseRent), Number(t.pctBps), BigInt(t.floorRent), BigInt(t.capRent),
     Number(t.totalPeriods), BigInt(t.deposit || 0)],
    t.mediator || ZERO, t.site !== undefined ? t.site : siteLine(t), sigL, sigT);
  return tx.wait();
}

// ---------- 월별 흐름. 각 함수는 영수증을 돌려준다(해시·블록 표시용) ----------
/** 12개월을 병렬로 읽는다. 순차로 돌면 왕복이 24번이라 원격 RPC 에서 수 초씩 걸린다. */
export async function loadMonths(total) {
  const months = Array.from({ length: total }, (_, i) => i + 1);
  return Promise.all(months.map(async (m) => {
    const [p, esc] = await Promise.all([read.periodOf(m), read.escrow(m)]);
    return {
      month: m, revenue: p.revenue, rent: p.rent, paid: p.paid, arrears: p.arrears,
      state: Number(p.state), // 0 None 1 Posted 2 Disputed 3 Settled
      proposed: p.proposedRevenue, landlordAgreed: p.landlordAgreed, tenantAgreed: p.tenantAgreed,
      escrow: esc, proof: p.proof, postedAt: Number(p.postedAt) * 1000, disputedAt: Number(p.disputedAt) * 1000,
    };
  }));
}

/**
 * 정산 원본 파일의 해시. 실제 서비스에서는 카드사·PG가 내려준 집계 파일을 그대로 해시한다.
 * 원본에는 건별 결제 내역이 들어 있어 체인에 올리면 안 된다 — 지문만 남긴다.
 */
export function makeProof(period, revenue) {
  const doc = `IM-PG-SETTLE|${cfg.address}|${period}|${revenue}|${startMonth}`;
  return { hash: ethers.keccak256(ethers.toUtf8Bytes(doc)), doc };
}
export const DISPUTE_DAYS = 7;
export const MEDIATION_DAYS = 14;

export const fund = (month, amount) => as("tenant").fund(month, { value: amount }).then((t) => t.wait());
export const postRevenue = (month, revenue, proof) => as("gateway").postRevenue(month, revenue, proof).then((t) => t.wait());
export const repay = (month, amount) => as("tenant").repay(month, { value: amount }).then((t) => t.wait());
export const payDeposit = (amount) => as("tenant").payDeposit({ value: amount }).then((t) => t.wait());
export const mediate = (month, revenue) => as("mediator").mediate(month, revenue).then((t) => t.wait());
export const settle = (role, month) => as(role).settle(month).then((t) => t.wait());
export const dispute = (role, month, proposed) => as(role).dispute(month, proposed).then((t) => t.wait());
export const agree = (role, month) => as(role).agree(month).then((t) => t.wait());
export const endLease = (role) => as(role).end().then((t) => t.wait());

/** 시연용 지름길: 임차인 예치 → 게이트웨이 게시 → 정산을 한 번에. 세 역할의 키를 모두 쓴다. */
export async function runMonth(month, revenue) {
  const rent = await read.quote(revenue);
  await fund(month, rent);
  await postRevenue(month, revenue, makeProof(month, revenue).hash);
  return settle("gateway", month);
}

// ---------- 활동 피드: 컨트랙트 이벤트 전체 ----------
export async function loadActivity() {
  const raw = await provider.getLogs({ address: cfg.address, fromBlock: 0, toBlock: "latest" });
  // 블록 조회를 한 번에 던진다. 로그마다 순서대로 기다리면 이벤트 수만큼 왕복한다.
  const nums = [...new Set(raw.map((l) => l.blockNumber))];
  const blocks = new Map(
    await Promise.all(nums.map(async (n) => [n, await provider.getBlock(n)])));
  const out = [];
  for (const l of raw) {
    let ev;
    try { ev = read.interface.parseLog({ topics: [...l.topics], data: l.data }); } catch { continue; }
    if (!ev) continue;
    const b = blocks.get(l.blockNumber);
    out.push({
      name: ev.name, args: ev.args, block: l.blockNumber, tx: l.transactionHash,
      time: Number(b.timestamp) * 1000, key: `${l.transactionHash}:${l.index}`,
    });
  }
  return out.reverse();
}

// ---------- 초안·서명 보관: 역할을 바꿔도 남아 있어야 한다 ----------
const DKEY = `rl:draft:${cfg.address}`;
export function loadDraft() {
  try { return JSON.parse(localStorage.getItem(DKEY) || "null"); } catch { return null; }
}
export function saveDraft(d) {
  try { localStorage.setItem(DKEY, JSON.stringify(d)); } catch {}
}
export function clearDraft() {
  try { localStorage.removeItem(DKEY); } catch {}
}
