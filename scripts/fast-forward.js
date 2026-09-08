// 시연용: 로컬 체인의 시간을 앞으로 돌린다.
//   npm run demo:ff        → 15일 (조정 개시 기한 통과)
//   DAYS=8 npm run demo:ff → 8일  (이의 제기 기한 통과)
// 실제 체인에서는 불가능하며, 기한이 걸린 규칙을 시연에서 보여주기 위한 장치다.
const { ethers } = require("hardhat");

async function main() {
  const days = Number(process.env.DAYS || 15);
  await ethers.provider.send("evm_increaseTime", [days * 24 * 60 * 60]);
  await ethers.provider.send("evm_mine", []);
  const b = await ethers.provider.getBlock("latest");
  console.log(`체인 시간을 ${days}일 앞으로 돌렸습니다 → ${new Date(Number(b.timestamp) * 1000).toLocaleString("ko-KR")}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
