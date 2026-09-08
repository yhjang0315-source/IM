// 공개 데모용 계정을 새로 만든다. 출력한 내용을 .env 에 넣는다.
//   node scripts/new-keys.js
// 하드햇 기본 계정을 공개 테스트넷에 쓰면 안 된다 — 널리 알려진 키라
// 스캐너 봇이 잔액을 곧바로 쓸어간다.
const { ethers } = require("hardhat");

async function main() {
  const roles = ["LANDLORD", "TENANT", "GATEWAY", "MEDIATOR"];
  console.log("KAIROS_RPC=https://public-en-kairos.node.kaia.io");
  const addrs = [];
  for (const r of roles) {
    const w = ethers.Wallet.createRandom();
    console.log(`DEMO_KEY_${r}=${w.privateKey}`);
    addrs.push([r, w.address]);
  }
  console.log("\n주소:");
  addrs.forEach(([r, a]) => console.log(`  ${r.padEnd(9)} ${a}`));
  console.log("\n첫 계정(LANDLORD)이 배포자다. https://faucet.kaia.io 에서 여기에 테스트 KAIA 를 받으면");
  console.log("npm run deploy:kairos 가 나머지 계정에 가스를 나눠준다.");
}
main().catch((e) => { console.error(e); process.exit(1); });
