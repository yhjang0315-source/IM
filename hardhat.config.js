require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config();

// 공개 데모용 Kairos(카이아 테스트넷) 계정. .env 에 있고 저장소에는 올라가지 않는다.
// 다만 배포된 프런트 번들에는 들어간다 — 역할 전환 데모를 위해 의도한 것이다.
const demoKeys = ["LANDLORD", "TENANT", "GATEWAY", "MEDIATOR"]
  .map((r) => process.env[`DEMO_KEY_${r}`])
  .filter(Boolean);

module.exports = {
  solidity: { version: "0.8.24", settings: { optimizer: { enabled: true, runs: 200 } } },
  networks: {
    kairos: {
      url: process.env.KAIROS_RPC || "https://public-en-kairos.node.kaia.io",
      chainId: 1001,
      accounts: demoKeys,
    },
  },
};
