#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
제출용 프로토타입 ZIP 을 만든다.

    python scripts/make-submission-zip.py

공고문은 "프로토타입(소스코드·데이터셋·학습모델) ZIP 또는 시연영상"을 요구한다.
심사위원이 압축을 풀고 그대로 돌려볼 수 있어야 하므로, 받는 쪽에 없는 것
(node_modules, 340MB 짜리 원본 zip, 빌드 산출물)은 빼고 재현 절차를 적어 넣는다.

**빼는 것 중 하나는 비밀이다.** .env 에는 데모 계정의 개인키가 들어 있다.
테스트넷 전용이라 금전 피해는 없지만, 제출물에 개인키를 넣는 습관은 그 자체로
감점 요인이다. 그래서 목록에서 빼는 데 그치지 않고, 담긴 파일 전체를 훑어
개인키처럼 생긴 문자열이 있으면 압축을 중단한다.
"""
import os
import re
import sys
import zipfile

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
OUT = os.path.join(ROOT, "dist", "매출연동임대차_프로토타입.zip")

# 담을 것. 디렉터리는 통째로, 파일은 그대로.
INCLUDE = [
    "contracts", "test", "scripts", "docs",
    "web/src", "web/public", "web/index.html", "web/package.json",
    "web/package-lock.json", "web/vite.config.js",
    "data/external",
    "hardhat.config.js", "package.json", "package-lock.json",
    "render.yaml", "README.md", ".env.example", ".gitignore",
]

# 받는 쪽에서 다시 만들어지거나, 넣으면 안 되는 것.
EXCLUDE_DIRS = {
    "node_modules", ".git", "dist", "artifacts", "cache", "coverage",
    "__pycache__", ".tmp-office", "typechain", "typechain-types",
}
EXCLUDE_FILES = {".env", "deployed.json"}
EXCLUDE_SUFFIX = (".log", ".pyc", ".zip")

# 개인키(0x + 64 hex)와 니모닉처럼 보이는 것.
SECRET = re.compile(r"0x[0-9a-fA-F]{64}")
# 하드햇 기본 계정 키는 공개된 값이라 예외로 둔다. 로컬 실행에 필요하다.
KNOWN_PUBLIC = {
    "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
    "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
    "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
    "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a",
}
# 해시는 32바이트라 같은 모양이다. 키를 담을 리 없는 파일은 검사에서 뺀다.
SKIP_SCAN = (".json", ".png", ".svg", ".csv", ".docx", ".sol")

GUIDE = """# 매출연동 임대차 — 프로토타입

2026 AI Blockchain Challenge in Daegu · 공모분야 ❺ 블록체인 기반 신뢰 인프라

## 돌려 보기

터미널 세 개가 필요합니다. Node.js 20 이상.

```
npm install

# 1번 터미널 — 로컬 체인
npm run chain

# 2번 터미널 — 컨트랙트 배포 (미체결 상태로 시작합니다)
npm run deploy

# 3번 터미널 — 화면
cd web && npm install && npm run dev     →  http://localhost:5173
```

화면 왼쪽 위 역할 전환 버튼으로 임대인·임차인·게이트웨이(은행)를 오가며
계약 체결부터 정산까지 진행할 수 있습니다. 시연 순서는 `docs/03-발표-대비.md`
아래쪽 "시연 시나리오"에 적어 두었습니다.

컨트랙트만 확인하시려면 설치 후 `npm test` (테스트 27개).

## 이 압축에 없는 것

- `node_modules` — `npm install` 로 받습니다.
- `data/raw/*.zip` — 소상공인시장진흥공단 상가(상권)정보 분기 스냅샷. 한 개가 340MB라
  넣지 못했습니다. 공공데이터포털에서 받아 `data/raw/` 에 두고 `npm run market` 을 돌리면
  분석 결과가 다시 만들어집니다. 분석 결과 자체(`web/public/market.json`)는 넣었으므로
  원본 없이도 화면은 그대로 돕니다.
- `.env` — 공개 테스트넷 데모 계정의 개인키가 들어 있어 제외했습니다.
  로컬 실행에는 필요 없습니다. `.env.example` 에 형식만 담았습니다.

## 어디를 먼저 보면 되는지

| 파일 | |
|---|---|
| `contracts/RevenueLease.sol` | 컨트랙트 본체 |
| `test/RevenueLease.test.js` | 자금 잠김·권한·기한 경계 테스트 |
| `web/src/Contract.jsx` | 계약 체결 마법사 |
| `web/src/Statement.jsx` | 명세서와 증빙 대조 |
| `scripts/analyze/` | 공공데이터 분석 → 업종별 권장 연동률 |
| `scripts/analyze/train_risk.py` | 폐업 예측 가능성 검증 (기각 근거) |
| `docs/06-제안요약서.md` | 제안요약서 원고 |
"""


def wanted(rel):
    parts = rel.replace("\\", "/").split("/")
    if any(p in EXCLUDE_DIRS for p in parts):
        return False
    if parts[-1] in EXCLUDE_FILES:
        return False
    if rel.endswith(EXCLUDE_SUFFIX):
        return False
    return True


def collect():
    out = []
    for item in INCLUDE:
        path = os.path.join(ROOT, item)
        if os.path.isfile(path):
            if wanted(item):
                out.append((path, item))
        elif os.path.isdir(path):
            for dirpath, dirnames, filenames in os.walk(path):
                dirnames[:] = [d for d in dirnames if d not in EXCLUDE_DIRS]
                for fn in filenames:
                    full = os.path.join(dirpath, fn)
                    rel = os.path.relpath(full, ROOT).replace("\\", "/")
                    if wanted(rel):
                        out.append((full, rel))
        else:
            print(f"  ! {item} 가 없어 건너뜁니다.")
    return sorted(out, key=lambda p: p[1])


def scan_for_secrets(files):
    """개인키처럼 생긴 문자열이 담기면 압축을 중단한다."""
    hits = []
    for full, rel in files:
        if rel.endswith(SKIP_SCAN):
            continue
        try:
            text = open(full, encoding="utf-8", errors="ignore").read()
        except OSError:
            continue
        for m in set(SECRET.findall(text)):
            if m.lower() not in KNOWN_PUBLIC:
                hits.append((rel, m[:10] + "…"))
    return hits


def main():
    files = collect()
    hits = scan_for_secrets(files)
    if hits:
        print("\n  개인키로 보이는 값이 담길 뻔했습니다. 압축을 중단합니다.\n")
        for rel, frag in hits:
            print(f"    {rel}  {frag}")
        print("\n  해당 파일을 빼거나 EXCLUDE 목록에 추가하십시오.")
        sys.exit(1)

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with zipfile.ZipFile(OUT, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        z.writestr("매출연동임대차/제출안내.md", GUIDE)
        for full, rel in files:
            z.write(full, f"매출연동임대차/{rel}")

    size = os.path.getsize(OUT)
    print(f"\n  파일 {len(files)}개 · {size / 1024 / 1024:.1f}MB")
    print(f"  → {os.path.relpath(OUT, ROOT)}")
    print("  개인키 검사 통과")


if __name__ == "__main__":
    main()
