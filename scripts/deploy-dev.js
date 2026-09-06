// 로컬 체인에 배포 + 조건 활성화 + 프런트가 읽을 설정 파일 생성
const { ethers, artifacts } = require("hardhat");
const fs = require("fs");
const path = require("path");

const T = { baseRent: 800_000n, pctBps: 800, floorRent: 1_500_000n, capRent: 3_500_000n, totalPeriods: 12 };

async function main() {
  const [landlord, tenant, gateway] = await ethers.getSigners();
  const F = await ethers.getContractFactory("RevenueLease");
  const c = await F.deploy(landlord.address, tenant.address, gateway.address);
  await c.waitForDeployment();
  const addr = await c.getAddress();

  const digest = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
    ["address","uint256","uint16","uint256","uint256","uint16"],
    [addr, T.baseRent, T.pctBps, T.floorRent, T.capRent, T.totalPeriods]));
  await (await c.activate(
    T.baseRent, T.pctBps, T.floorRent, T.capRent, T.totalPeriods,
    await landlord.signMessage(ethers.getBytes(digest)),
    await tenant.signMessage(ethers.getBytes(digest))
  )).wait();

  const art = await artifacts.readArtifact("RevenueLease");
  const out = {
    address: addr,
    abi: art.abi,
    rpc: "http://127.0.0.1:8545",
    terms: {
      baseRent: T.baseRent.toString(), pctBps: T.pctBps,
      floorRent: T.floorRent.toString(), capRent: T.capRent.toString(),
      totalPeriods: T.totalPeriods,
    },
    fixedRentComparison: "2500000",
    site: { name: "동성로 15평 매장", district: "대구 중구 동성로", vacancyPct: 23.3 },
    roles: { landlord: landlord.address, tenant: tenant.address, gateway: gateway.address },
  };
  const dir = path.join(__dirname, "..", "web", "src");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "deployed.json"), JSON.stringify(out, null, 2));
  console.log("배포 완료:", addr);
  console.log("web/src/deployed.json 생성됨");
}
main().catch(e => { console.error(e); process.exit(1); });
