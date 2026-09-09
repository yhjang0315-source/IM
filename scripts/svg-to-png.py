#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
구조도 SVG 를 인쇄용 PNG 로 굽는다.

    python scripts/svg-to-png.py

제안요약서 서식(한글·워드)은 SVG 를 받지 않는다. 그렇다고 그림을 두 벌로
관리하면 반드시 어긋나므로, SVG 하나를 원본으로 두고 여기서 굽는다.

윈도우에는 cairo 가 없어 cairosvg 가 임포트조차 되지 않는다. 그래서 브라우저의
캔버스를 렌더러로 쓴다. 이 스크립트는 로컬 서버를 띄우고, 열린 페이지가
캔버스에 그린 결과를 POST 로 돌려주면 파일로 저장한 뒤 종료한다.

브라우저는 사람이 열어도 되고(콘솔에 주소가 뜬다), 자동화 도구가 열어도 된다.
"""
import base64
import http.server
import os
import sys
import threading
import webbrowser

HERE = os.path.dirname(os.path.abspath(__file__))
ASSETS = os.path.join(HERE, "..", "docs", "assets")
SVG = "architecture.svg"
OUT = "architecture.png"
PORT = 8899
SCALE = 2  # 1060x700 → 2120x1400. A4 폭에 넣어도 글자가 뭉개지지 않는다.

PAGE = """<!doctype html><meta charset="utf-8"><body style="font:14px sans-serif;padding:24px">
<p id="m">굽는 중…</p><img id="s" src="%s" style="display:none">
<script>
const img = document.getElementById('s'), m = document.getElementById('m');
img.onerror = () => m.textContent = 'SVG 를 읽지 못했습니다.';
img.onload = () => {
  const S = %d, c = document.createElement('canvas');
  c.width = %d * S; c.height = %d * S;
  const g = c.getContext('2d');
  g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
  g.drawImage(img, 0, 0, c.width, c.height);
  fetch('/save', { method: 'POST', body: c.toDataURL('image/png') })
    .then(() => { m.textContent = '저장했습니다. 창을 닫으셔도 됩니다.'; document.title = 'done'; })
    .catch((e) => m.textContent = '저장 실패: ' + e);
};
</script></body>"""


def main():
    width, height = 1060, 700
    svg_path = os.path.join(ASSETS, SVG)
    if not os.path.exists(svg_path):
        sys.exit(f"{svg_path} 가 없습니다.")
    out_path = os.path.join(ASSETS, OUT)
    done = threading.Event()

    class Handler(http.server.SimpleHTTPRequestHandler):
        def __init__(self, *a, **kw):
            super().__init__(*a, directory=ASSETS, **kw)

        def log_message(self, *a):
            pass

        def do_GET(self):
            if self.path in ("/", "/index.html"):
                body = (PAGE % (SVG, SCALE, width, height)).encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return
            super().do_GET()

        def do_POST(self):
            n = int(self.headers.get("Content-Length", 0))
            data = self.rfile.read(n).decode("ascii")
            _, b64 = data.split(",", 1)
            with open(out_path, "wb") as f:
                f.write(base64.b64decode(b64))
            self.send_response(204)
            self.end_headers()
            done.set()

    srv = http.server.ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    url = f"http://127.0.0.1:{PORT}/"
    print(f"  브라우저에서 {url} 를 여십시오. 자동으로 열어 봅니다.")
    try:
        webbrowser.open(url)
    except Exception:
        pass

    if not done.wait(timeout=120):
        srv.shutdown()
        sys.exit("  120초 안에 브라우저가 결과를 보내지 않았습니다.")
    srv.shutdown()
    size = os.path.getsize(out_path)
    print(f"  → docs/assets/{OUT}  {width * SCALE}x{height * SCALE}  {size // 1024}KB")


if __name__ == "__main__":
    main()
