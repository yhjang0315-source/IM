import { ethers } from "ethers";
import cfg from "./deployed.json";

// 로컬 개발용 키(하드햇 기본 계정). 실제 서비스에서는 은행 앱 내장 키/서버 서명으로 대체된다.
const KEYS = {
  landlord: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  tenant:   "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  gateway:  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
};

// cacheTimeout: -1 — 연속 트랜잭션에서 nonce가 캐시된 값으로 굳는 것을 막는다 (자동 채굴 로컬 체인)
export const provider = new ethers.JsonRpcProvider(cfg.rpc, undefined, { cacheTimeout: -1, staticNetwork: true });
export const terms = cfg.terms;
export const site = cfg.site;
export const FIXED_RENT = BigInt(cfg.fixedRentComparison);

const wallets = {};
const signer = (role) => (wallets[role] ||= new ethers.Wallet(KEYS[role], provider));
const as = (role) => new ethers.Contract(cfg.address, cfg.abi, signer(role));
export const read = new ethers.Contract(cfg.address, cfg.abi, provider);
export const asTenant = () => as("tenant");
export const asGateway = () => as("gateway");
export const asLandlord = () => as("landlord");

export const won = (v) => Number(v).toLocaleString("ko-KR");
export const pct = (a, b) => (b === 0n || b === 0 ? 0 : (Number(a) * 100) / Number(b));

export async function loadMonths(total) {
  const out = [];
  for (let m = 1; m <= total; m++) {
    const p = await read.periodOf(m);
    out.push({
      month: m,
      revenue: p.revenue,
      rent: p.rent,
      paid: p.paid,
      arrears: p.arrears,
      state: Number(p.state), // 0 None 1 Posted 2 Disputed 3 Settled
    });
  }
  return out;
}

/** 한 달치를 예치 → 매출 게시 → 정산까지 실행 */
export async function runMonth(month, revenue) {
  const rent = await read.quote(revenue);
  await (await asTenant().fund(month, { value: rent })).wait();
  await (await asGateway().postRevenue(month, revenue)).wait();
  await (await asGateway().settle(month)).wait();
}

export async function postOnly(month, revenue) {
  const rent = await read.quote(revenue);
  await (await asTenant().fund(month, { value: rent })).wait();
  await (await asGateway().postRevenue(month, revenue)).wait();
}
export async function disputeAs(role, month, proposed) {
  await (await as(role).dispute(month, proposed)).wait();
}
export async function agreeAs(role, month) {
  await (await as(role).agree(month)).wait();
}
export async function settleMonth(month) {
  await (await asGateway().settle(month)).wait();
}
