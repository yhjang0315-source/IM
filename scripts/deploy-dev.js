// 로컬 체인에 배포 + 프런트가 읽을 설정 파일 생성.
//
// 기본은 Draft 상태로 둔다 — 조건 작성·양측 서명·확정을 화면에서 한다.
// 예전처럼 배포 시점에 바로 활성화하려면 `npm run deploy:active`.
const { ethers, artifacts } = require("hardhat");
const fs = require("fs");
const path = require("path");

// 화면의 "권장값 적용" 버튼이 시작점으로 쓰는 값. 실제 권장치는 market.json에서 온다.
const T = {
  baseRent: 800_000n, pctBps: 800, floorRent: 1_500_000n, capRent: 3_500_000n,
  totalPeriods: 12, deposit: 10_000_000n,
};
const ACTIVATE = process.env.ACTIVATE === "1";

function nextMonth() {
  const d = new Date();
  d.setDate(1); d.setMonth(d.getMonth() + 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

async function main() {
  const [landlord, tenant, gateway, , mediator] = await ethers.getSigners();
  const F = await ethers.getContractFactory("RevenueLease");
  const c = await F.deploy(landlord.address, tenant.address, gateway.address);
  await c.waitForDeployment();
  const addr = await c.getAddress();

  if (ACTIVATE) {
    const digest = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
      ["address", "uint256", "uint16", "uint256", "uint256", "uint16", "uint256", "address"],
      [addr, T.baseRent, T.pctBps, T.floorRent, T.capRent, T.totalPeriods, T.deposit, mediator.address]));
    await (await c.activate(
      T.baseRent, T.pctBps, T.floorRent, T.capRent, T.totalPeriods, T.deposit, mediator.address,
      await landlord.signMessage(ethers.getBytes(digest)),
      await tenant.signMessage(ethers.getBytes(digest))
    )).wait();
  }

  const art = await artifacts.readArtifact("RevenueLease");
  const out = {
    address: addr,
    abi: art.abi,
    rpc: "http://127.0.0.1:8545",
    startMonth: nextMonth(),
    suggested: {
      baseRent: T.baseRent.toString(), pctBps: T.pctBps,
      floorRent: T.floorRent.toString(), capRent: T.capRent.toString(),
      totalPeriods: T.totalPeriods, deposit: T.deposit.toString(),
    },
    fixedRentComparison: "2500000",
    site: { name: "동성로 15평 매장", district: "대구 중구 동성로", areaPyeong: 15, vacancyPct: 23.3 },
    roles: {
      landlord: landlord.address, tenant: tenant.address, gateway: gateway.address,
      mediator: mediator.address, // 화면에서 조정인으로 지정할 수 있는 후보. 지정은 양측 서명으로만.
    },
  };
  const dir = path.join(__dirname, "..", "web", "src");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "deployed.json"), JSON.stringify(out, null, 2));
  console.log("배포 완료:", addr, ACTIVATE ? "(활성화됨)" : "(Draft — 화면에서 체결)");
  console.log("web/src/deployed.json 생성됨");
}
main().catch(e => { console.error(e); process.exit(1); });
