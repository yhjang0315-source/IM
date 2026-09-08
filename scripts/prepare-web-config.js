#!/usr/bin/env node
/**
 * 빌드 서버가 web/src/deployed.json 을 갖게 한다.
 *
 *   node scripts/prepare-web-config.js
 *
 * deployed.json 은 배포 스크립트가 만들고 저장소에는 넣지 않는다. 데모 서명 키가
 * 들어 있어서다. 그런데 화면은 이 파일 없이는 빌드조차 되지 않는다(lease.js 가 import 한다).
 * 그래서 Render 같은 빌드 서버에는 파일 대신 값으로 넘긴다.
 *
 * 찾는 순서:
 *   1. web/src/deployed.json 이 이미 있으면 그대로 쓴다 (로컬)
 *   2. 환경변수 DEPLOYED_JSON 의 내용을 쓴다
 *   3. 저장소 뿌리의 deployed.json 을 복사한다 (Render Secret Files 가 여기에 둔다)
 *
 * 셋 다 없으면 빌드를 세운다. 빈 화면이 배포되는 것보다 낫다.
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const TARGET = path.join(ROOT, "web", "src", "deployed.json");
const SECRET = path.join(ROOT, "deployed.json");

function write(text, from) {
  let cfg;
  try {
    cfg = JSON.parse(text);
  } catch (e) {
    throw new Error(`${from} 의 내용이 JSON 이 아닙니다: ${e.message}`);
  }
  for (const k of ["network", "address", "abi", "rpc", "keys"]) {
    if (!cfg[k]) throw new Error(`${from} 에 "${k}" 가 없습니다. 배포 스크립트가 만든 파일이 맞습니까?`);
  }
  fs.mkdirSync(path.dirname(TARGET), { recursive: true });
  fs.writeFileSync(TARGET, JSON.stringify(cfg, null, 2));
  console.log(`  deployed.json ← ${from}  [${cfg.network}] ${cfg.address}`);
  if (cfg.network === "localhost") {
    console.warn("  ! 로컬 체인(127.0.0.1:8545) 설정입니다. 공개 배포에는 kairos 설정을 넣으십시오.");
  }
}

if (fs.existsSync(TARGET)) {
  const cfg = JSON.parse(fs.readFileSync(TARGET, "utf8"));
  console.log(`  deployed.json 이미 있음  [${cfg.network}] ${cfg.address}`);
} else if (process.env.DEPLOYED_JSON) {
  write(process.env.DEPLOYED_JSON, "환경변수 DEPLOYED_JSON");
} else if (fs.existsSync(SECRET)) {
  write(fs.readFileSync(SECRET, "utf8"), "deployed.json (Secret File)");
} else {
  console.error(
    "\n  web/src/deployed.json 이 없어 빌드할 수 없습니다.\n\n" +
    "  로컬:      npx hardhat run scripts/deploy-dev.js --network localhost\n" +
    "  빌드서버:  환경변수 DEPLOYED_JSON 에 그 파일 내용을 통째로 넣거나,\n" +
    "             Secret File 이름을 deployed.json 으로 올리십시오.\n");
  process.exit(1);
}
