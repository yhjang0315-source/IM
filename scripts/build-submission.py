#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
제출 폴더를 통째로 만든다.

    python scripts/build-submission.py      (npm run bundle)

dist/제출/ 아래에 접수처에 올릴 것들을 모아 둔다. 마감 직전에 "뭐가 최신이지"를
헤매지 않으려고 한 번에 다시 굽는다. 중간 산출물이 남아 섞이는 것을 막으려고
폴더를 비우고 시작한다.

붙임 1~3(참가신청서·서약서·개인정보 동의서)은 대회 서식이라 여기서 만들 수 없다.
대신 그 서식에 옮겨 적을 값을 전부 모은 접수기입표를 함께 굽는다.
"""
import os
import shutil
import subprocess
import sys

from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (
    BaseDocTemplate, Frame, PageTemplate, Paragraph, Spacer, Table, TableStyle,
)

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
OUTDIR = os.path.join(ROOT, "dist", "제출")

INK = colors.HexColor("#1a1a1a")
GRAY = colors.HexColor("#5a5a5a")
RULE = colors.HexColor("#c8c8c8")
HEAD_BG = colors.HexColor("#f2f2f2")
FILLIN = colors.HexColor("#fff8e1")

MARGIN = 20 * mm
WIDTH = A4[0] - 2 * MARGIN

# 접수 서식에 그대로 옮겨 적을 값. 비워 둔 칸은 본인만 채울 수 있는 것이다.
FIELDS = [
    ("공모분야", "⑤ 블록체인 기반 신뢰 인프라", False),
    ("과제명", "매출연동 임대차 — 골목상권 임대차의 블록체인 검증 인프라", False),
    ("핵심 키워드", "스마트컨트랙트 / 매출연동 임대료 / 결제 게이트웨이 / 증빙 해시 검증", False),
    ("참가 형태", "개인 (1인)", False),
    ("성명", "장예현", True),
    ("생년월일", "", True),
    ("연락처", "", True),
    ("이메일", "yhjang0315@gmail.com", True),
    ("소속", "", True),
    ("주소", "", True),
]

CHECKLIST = [
    ("붙임 1 참가신청서", "서식에 기입 → 날인", False),
    ("붙임 2 참가서약서", "서식에 기입 → 날인", False),
    ("붙임 3 개인정보 동의서", "서식에 기입 → 날인 (단독 참가라 1인분)", False),
    ("붙임 1~3 병합", "스캔해서 1개 파일로 합칠 것 — 공고문 요구사항", False),
    ("붙임 4 제안요약서", "제안요약서.pdf (A4 4쪽). 서식이 워드를 요구하면 .docx", True),
    ("프로토타입", "매출연동임대차_프로토타입.zip", True),
    ("시연영상", "선택 — ZIP 이 있으므로 없어도 요건 충족", False),
]


def register_fonts():
    for name, fn in [("KR", "malgun.ttf"), ("KR-B", "malgunbd.ttf")]:
        p = os.path.join(r"C:\Windows\Fonts", fn)
        if not os.path.exists(p):
            sys.exit(f"{p} 가 없습니다.")
        pdfmetrics.registerFont(TTFont(name, p))
    pdfmetrics.registerFontFamily("KR", normal="KR", bold="KR-B")


def run(desc, cmd):
    print(f"  {desc} …", end=" ", flush=True)
    r = subprocess.run(cmd, cwd=ROOT, shell=True, capture_output=True, text=True,
                       encoding="utf-8", errors="replace")
    if r.returncode != 0:
        print("실패")
        print((r.stdout or "") + (r.stderr or ""))
        sys.exit(1)
    print("완료")
    return r.stdout or ""


def summary_text():
    import json
    src = json.load(open(os.path.join(ROOT, "docs", "proposal.json"), encoding="utf-8"))
    for b in src["blocks"]:
        if b["t"] == "box":
            return b["text"].replace("**", "")
    sys.exit("proposal.json 에 과제요약(box) 이 없습니다.")


def sheet():
    S = {
        "title": ParagraphStyle("t", fontName="KR-B", fontSize=17, leading=22, textColor=INK),
        "sub": ParagraphStyle("s", fontName="KR", fontSize=9.5, leading=14, textColor=GRAY,
                              spaceAfter=12),
        "h": ParagraphStyle("h", fontName="KR-B", fontSize=11.5, leading=15, textColor=INK,
                            spaceBefore=13, spaceAfter=5),
        "p": ParagraphStyle("p", fontName="KR", fontSize=9, leading=13.5, textColor=INK,
                            alignment=TA_LEFT, spaceAfter=4),
        "note": ParagraphStyle("n", fontName="KR", fontSize=8.3, leading=12.5, textColor=GRAY,
                               spaceBefore=3),
        "cell": ParagraphStyle("c", fontName="KR", fontSize=8.7, leading=12.5, textColor=INK),
        "cellb": ParagraphStyle("cb", fontName="KR-B", fontSize=8.7, leading=12.5, textColor=INK),
        "sum": ParagraphStyle("sm", fontName="KR", fontSize=8.7, leading=13.5, textColor=INK),
    }
    F = [Paragraph("접수 기입표", S["title"]),
         Paragraph("2026 AI Blockchain Challenge in Daegu · 접수 im-challenge.com · "
                   "마감 2026. 9. 20.(일) 23:59<br/>"
                   "붙임 1~3 서식에 이 값을 그대로 옮겨 적으면 된다. 노란 칸은 본인만 채울 수 있는 것이다.",
                   S["sub"])]

    F.append(Paragraph("신청 정보", S["h"]))
    rows = [[Paragraph("항목", S["cellb"]), Paragraph("값", S["cellb"])]]
    for label, value, is_blank in FIELDS:
        rows.append([Paragraph(label, S["cellb"]),
                     Paragraph(value or "&nbsp;", S["cell"])])
    t = Table(rows, colWidths=[32 * mm, WIDTH - 32 * mm])
    style = [
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("TOPPADDING", (0, 0), (-1, -1), 5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
        ("LEFTPADDING", (0, 0), (-1, -1), 6),
        ("BACKGROUND", (0, 0), (-1, 0), HEAD_BG),
        ("LINEABOVE", (0, 0), (-1, 0), 0.6, INK),
        ("LINEBELOW", (0, 0), (-1, -2), 0.35, RULE),
        ("LINEBELOW", (0, -1), (-1, -1), 0.6, INK),
    ]
    for i, (_, value, is_blank) in enumerate(FIELDS, start=1):
        if is_blank:
            style.append(("BACKGROUND", (1, i), (1, i), FILLIN))
    t.setStyle(TableStyle(style))
    F.append(t)

    F.append(Paragraph("과제요약 (500자 이내)", S["h"]))
    text = summary_text()
    box = Table([[Paragraph(text, S["sum"])]], colWidths=[WIDTH])
    box.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), colors.HexColor("#f7f7f7")),
        ("BOX", (0, 0), (-1, -1), 0.35, RULE),
        ("TOPPADDING", (0, 0), (-1, -1), 8), ("BOTTOMPADDING", (0, 0), (-1, -1), 8),
        ("LEFTPADDING", (0, 0), (-1, -1), 9), ("RIGHTPADDING", (0, 0), (-1, -1), 9),
    ]))
    F.append(box)
    F.append(Paragraph(f"공백 포함 {len(text)}자 — 500자 기준 {500 - len(text)}자 여유. "
                       "붙여넣은 뒤 접수 화면의 글자수 표시를 한 번 더 확인할 것.", S["note"]))

    F.append(Paragraph("제출물 점검", S["h"]))
    rows = [[Paragraph("제출물", S["cellb"]), Paragraph("상태", S["cellb"]),
             Paragraph("확인", S["cellb"])]]
    for name, how, ready in CHECKLIST:
        mark = "준비됨" if ready else "본인 작업"
        rows.append([Paragraph(name, S["cell"]), Paragraph(how, S["cell"]),
                     Paragraph(mark, S["cell"])])
    t2 = Table(rows, colWidths=[42 * mm, WIDTH - 42 * mm - 22 * mm, 22 * mm])
    t2.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("TOPPADDING", (0, 0), (-1, -1), 5), ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
        ("LEFTPADDING", (0, 0), (-1, -1), 6),
        ("BACKGROUND", (0, 0), (-1, 0), HEAD_BG),
        ("LINEABOVE", (0, 0), (-1, 0), 0.6, INK),
        ("LINEBELOW", (0, 0), (-1, -2), 0.35, RULE),
        ("LINEBELOW", (0, -1), (-1, -1), 0.6, INK),
    ]))
    F.append(t2)
    F.append(Paragraph(
        "붙임 1~3 은 원본 직인 날인 스캔 또는 전자서명 후 <b>1개 파일로</b> 제출한다. "
        "마감 전까지 수정·보완이 가능하므로, 다 갖춰지지 않았더라도 먼저 올려 두고 나중에 교체하는 편이 안전하다.",
        S["note"]))

    F.append(Paragraph("제안요약서를 무엇으로 낼까", S["h"]))
    F.append(Paragraph(
        "<b>PDF 를 기본으로 한다.</b> 워드 파일은 여는 PC 의 글꼴과 여백에 따라 쪽수가 달라져서, "
        "이쪽에서 4쪽이어도 접수처에서 6쪽이 될 수 있다. PDF 는 굽는 순간 쪽수가 고정된다. "
        "서식이 워드(.docx) 제출을 명시적으로 요구할 때만 .docx 를 낸다. 두 파일의 내용은 같다 — "
        "같은 원고 파일에서 만든다.", S["p"]))
    return F


def footer(canvas, doc):
    canvas.saveState()
    canvas.setFont("KR", 7.5)
    canvas.setFillColor(GRAY)
    canvas.drawString(MARGIN, 12 * mm, "매출연동 임대차 · 접수 기입표")
    canvas.drawRightString(A4[0] - MARGIN, 12 * mm, f"{doc.page}")
    canvas.restoreState()


def main():
    register_fonts()

    if os.path.isdir(OUTDIR):
        shutil.rmtree(OUTDIR)
    os.makedirs(OUTDIR, exist_ok=True)

    print("\n  제출 폴더를 다시 굽습니다\n")
    run("제안요약서 PDF", "python scripts/make-proposal-pdf.py")
    run("제안요약서 워드", "node scripts/make-proposal-docx.js")
    run("프로토타입 ZIP", "python scripts/make-submission-zip.py")

    zip_src = os.path.join(ROOT, "dist", "매출연동임대차_프로토타입.zip")
    if os.path.exists(zip_src):
        shutil.move(zip_src, os.path.join(OUTDIR, "매출연동임대차_프로토타입.zip"))

    print("  접수 기입표 …", end=" ", flush=True)
    out = os.path.join(OUTDIR, "접수기입표.pdf")
    doc = BaseDocTemplate(out, pagesize=A4, leftMargin=MARGIN, rightMargin=MARGIN,
                          topMargin=18 * mm, bottomMargin=20 * mm,
                          title="접수 기입표", author="장예현")
    doc.addPageTemplates([PageTemplate(id="p", onPage=footer, frames=[
        Frame(doc.leftMargin, doc.bottomMargin, WIDTH,
              A4[1] - doc.topMargin - doc.bottomMargin, id="b")])])
    doc.build(sheet())
    print("완료")

    print(f"\n  dist/제출/")
    for f in sorted(os.listdir(OUTDIR)):
        size = os.path.getsize(os.path.join(OUTDIR, f))
        print(f"    {f}  ({size / 1024:.0f}KB)")
    print("\n  남은 것: 붙임 1~3 서식에 기입 → 날인 → 1개 파일로 병합")


if __name__ == "__main__":
    main()
