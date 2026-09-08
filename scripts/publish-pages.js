#!/usr/bin/env node
/**
 * 빌드 결과를 gh-pages 브랜치로 올린다.
 *
 *   npm run publish:pages
 *
 * 작업 트리를 건드리지 않으려고 임시 디렉터리에서 별도 저장소를 만들어 강제 푸시한다.
 * dist 안에는 데모 계정의 개인키가 들어 있다 — 공개 테스트넷 전용이고 의도한 것이다.
 */
const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const DIST = path.join(ROOT, "web", "dist");
const BRANCH = "gh-pages";

const run = (cmd, args, cwd) =>
  execFileSync(cmd, args, { cwd, stdio: "inherit", shell: false });
const capture = (cmd, args, cwd) =>
  execFileSync(cmd, args, { cwd, encoding: "utf8" }).trim();

function main() {
  if (!fs.existsSync(path.join(DIST, "index.html"))) {
    console.error("web/dist 가 없습니다. 먼저 빌드하십시오:\n  BASE=/IM/ npm --prefix web run build");
    process.exit(1);
  }
  const remote = capture("git", ["remote", "get-url", "origin"], ROOT);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pages-"));
  fs.cpSync(DIST, tmp, { recursive: true });
  // Jekyll 이 밑줄로 시작하는 파일을 숨기지 않도록
  fs.writeFileSync(path.join(tmp, ".nojekyll"), "");

  run("git", ["init", "-q", "-b", BRANCH], tmp);
  run("git", ["add", "-A"], tmp);
  run("git", ["-c", "user.name=deploy", "-c", "user.email=deploy@local",
              "commit", "-q", "-m", `배포 ${new Date().toISOString()}`], tmp);
  run("git", ["push", "-q", "--force", remote, `${BRANCH}:${BRANCH}`], tmp);
  fs.rmSync(tmp, { recursive: true, force: true });

  const m = remote.match(/github\.com[/:]([^/]+)\/([^/.]+)/);
  if (m) console.log(`\n  https://${m[1]}.github.io/${m[2]}/`);
  console.log("  (첫 배포는 Pages 활성화 후 1~2분 걸립니다)");
}
main();
