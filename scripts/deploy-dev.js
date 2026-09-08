// 배포 + 프런트가 읽을 설정 파일 생성.
//
//   npm run deploy          로컬 체인, 미체결(Draft) 상태
//   npm run deploy:active   로컬 체인, 조건까지 확정 (정산 시연만 할 때)
//   npm run deploy:kairos   공개 테스트넷(Kaia Kairos)
//
// 조건 작성·양측 서명·확정은 원래 화면에서 하는 것이라 기본은 Draft 로 둔다.
const { ethers, artifacts, network } = require("hardhat");
const fs = require("fs");
const path = require("path");

// 화면의 "권장값 적용" 버튼이 시작점으로 쓰는 값. 실제 권장치는 market.json에서 온다.
const T = {
  baseRent: 800_000n, pctBps: 800, floorRent: 1_500_000n, capRent: 3_500_000n,
  totalPeriods: 12, deposit: 10_000_000n,
};
const ACTIVATE = process.env.ACTIVATE === "1";

// 역할 계정이 트랜잭션을 보내려면 가스가 있어야 한다. 공개 테스트넷에서는
// faucet 을 네 번 받는 대신 배포자가 한 번 받아 나눠준다.
const GAS_ALLOWANCE = ethers.parseEther("1.0");

const RPC = {
  localhost: "http://127.0.0.1:8545",
  kairos: process.env.KAIROS_RPC || "https://public-en-kairos.node.kaia.io",
};
const EXPLORER = { kairos: "https://kairos.kaiascan.io" };

// 로컬은 널리 알려진 하드햇 기본 키를 쓴다. 공개 테스트넷에서는 .env 의 데모 키를 쓴다.
const LOCAL_KEYS = {
  landlord: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  tenant: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  gateway: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  mediator: "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a",
};

function nextMonth() {
  const d = new Date();
  d.setDate(1); d.setMonth(d.getMonth() + 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function keysFor(net) {
  if (net !== "kairos") return LOCAL_KEYS;
  const out = {};
  for (const r of ["landlord", "tenant", "gateway", "mediator"]) {
    const k = process.env[`DEMO_KEY_${r.toUpperCase()}`];
    if (!k) throw new Error(`.env 에 DEMO_KEY_${r.toUpperCase()} 가 없습니다. node scripts/new-keys.js 를 먼저 실행하십시오.`);
    out[r] = k;
  }
  return out;
}

/** 역할 계정에 가스가 없으면 배포자가 채워준다. 공개 테스트넷에서만 한다. */
async function topUp(signers) {
  const [payer] = signers;
  const bal = await ethers.provider.getBalance(payer.address);
  console.log(`  배포자 잔액 ${ethers.formatEther(bal)} KAIA`);
  if (bal === 0n) {
    throw new Error(
      `배포자 ${payer.address} 에 테스트 KAIA 가 없습니다.\n` +
      `  https://faucet.kaia.io 에서 이 주소로 받은 뒤 다시 실행하십시오.`);
  }
  for (const s of signers.slice(1)) {
    const b = await ethers.provider.getBalance(s.address);
    if (b >= GAS_ALLOWANCE / 2n) continue;
    process.stdout.write(`  가스 보내는 중 → ${s.address} … `);
    await (await payer.sendTransaction({ to: s.address, value: GAS_ALLOWANCE })).wait();
    console.log("완료");
  }
}

async function main() {
  const net = network.name;
  const signers = await ethers.getSigners();
  const [landlord, tenant, gateway, ...rest] = signers;
  // 로컬 하드햇은 계정이 20개라 5번째를 조정인으로 쓰고, 테스트넷은 .env 의 4번째다.
  const mediator = net === "kairos" ? rest[0] : rest[1];

  if (net === "kairos") await topUp([landlord, tenant, gateway, mediator]);

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
    network: net,
    address: addr,
    abi: art.abi,
    rpc: RPC[net] || RPC.localhost,
    explorer: EXPLORER[net] || null,
    // 데모용 서명 키. 실제 서비스에서는 은행 앱 내장 키나 서버 서명으로 대체된다.
    keys: keysFor(net),
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
      mediator: mediator.address,
    },
  };
  const dir = path.join(__dirname, "..", "web", "src");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "deployed.json"), JSON.stringify(out, null, 2));

  console.log(`\n  배포 완료 [${net}] ${addr} ${ACTIVATE ? "(활성화됨)" : "(Draft — 화면에서 체결)"}`);
  if (out.explorer) console.log(`  ${out.explorer}/address/${addr}`);
  console.log("  web/src/deployed.json 생성됨");
}
main().catch((e) => { console.error(e.message || e); process.exit(1); });
