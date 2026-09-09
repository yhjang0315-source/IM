const { ethers } = require("hardhat");

// 정산 원본 파일의 해시 자리. 실제로는 PG 집계 파일을 해시한다.
const PROOF = ethers.keccak256(ethers.toUtf8Bytes("PG정산파일-시뮬레이션"));

// 동성로 15평 매장 가정. 금액 단위: 원 (프로토타입에서 1 wei = 1 원)
const FIXED_RENT = 2_500_000n;                 // 현행 고정 월세
const REV = [12,10,16,19,21,18,15,14,20,22,24,26].map(v => BigInt(v) * 1_000_000n); // 월 매출

const T = { baseRent: 800_000n, pctBps: 800, floorRent: 1_500_000n, capRent: 3_500_000n, totalPeriods: 12 };

async function main() {
  const [landlord, tenant, gateway] = await ethers.getSigners();
  const F = await ethers.getContractFactory("RevenueLease");
  const c = await F.deploy(landlord.address, tenant.address, gateway.address);
  await c.waitForDeployment();

  const NO_MEDIATOR = "0x0000000000000000000000000000000000000000";
  const DEPOSIT = 10_000_000n;
  const SITE = "동성로 15평 매장 · 대구 중구 동성로";
  const digest = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
    ["address","uint256","uint16","uint256","uint256","uint16","uint256","address","bytes32"],
    [await c.getAddress(), T.baseRent, T.pctBps, T.floorRent, T.capRent, T.totalPeriods, DEPOSIT, NO_MEDIATOR,
     ethers.keccak256(ethers.toUtf8Bytes(SITE))]));
  await c.activate([T.baseRent, T.pctBps, T.floorRent, T.capRent, T.totalPeriods, DEPOSIT], NO_MEDIATOR, SITE,
    await landlord.signMessage(ethers.getBytes(digest)),
    await tenant.signMessage(ethers.getBytes(digest)));

  const won = n => Number(n).toLocaleString("ko-KR");
  const pct = (a,b) => (Number(a)*100/Number(b)).toFixed(1);

  console.log("\n  월   매출        연동 임대료   부담률   고정 월세 부담률");
  console.log("  " + "-".repeat(58));

  let sumRent = 0n, sumRev = 0n, worstLinked = 0, worstFixed = 0;
  for (let m = 0; m < 12; m++) {
    const rev = REV[m];
    const rent = await c.quote(rev);                 // 실제 컨트랙트가 계산
    await c.connect(tenant).fund(m + 1, { value: rent });
    await c.connect(gateway).postRevenue(m + 1, rev, PROOF);
    await c.connect(gateway).settle(m + 1);          // 온체인 정산 실행
    sumRent += rent; sumRev += rev;
    const bl = Number(pct(rent, rev)), bf = Number(pct(FIXED_RENT, rev));
    worstLinked = Math.max(worstLinked, bl); worstFixed = Math.max(worstFixed, bf);
    console.log(`  ${String(m+1).padStart(2)}  ${won(rev).padStart(11)}  ${won(rent).padStart(11)}   ${bl.toFixed(1).padStart(5)}%   ${bf.toFixed(1).padStart(11)}%`);
  }

  console.log("  " + "-".repeat(58));
  console.log(`\n  임대인 연간 수취액`);
  console.log(`    공실 유지            ${won(0).padStart(12)} 원   (현재 상태)`);
  console.log(`    고정 월세 250만      ${won(FIXED_RENT * 12n).padStart(12)} 원   (임차인이 들어와야 성립)`);
  console.log(`    매출연동             ${won(sumRent).padStart(12)} 원   (${pct(sumRent, FIXED_RENT*12n)}% 수준)`);
  console.log(`\n  임차인 최악의 달 임대료 부담률`);
  console.log(`    고정 월세            ${worstFixed.toFixed(1)}%`);
  console.log(`    매출연동             ${worstLinked.toFixed(1)}%   <- 진입 결정을 바꾸는 숫자`);
  console.log(`\n  연간 매출 ${won(sumRev)} 원 / 실효 임대료율 ${pct(sumRent, sumRev)}%\n`);

  const p = await c.periodOf(2);
  console.log(`  검증: 최저매출월(2월) 온체인 기록 — 매출 ${won(p.revenue)} / 임대료 ${won(p.rent)} / 지급 ${won(p.paid)} / 미납 ${won(p.arrears)}\n`);
}
main().catch(e => { console.error(e); process.exit(1); });
