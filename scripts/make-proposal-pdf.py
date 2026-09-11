#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
제안요약서(붙임4)를 PDF 로 굽는다.

    python scripts/make-proposal-pdf.py

원고는 docs/proposal.json 이고 워드판(make-proposal-docx.js)과 같은 파일을 읽는다.
두 파일이 조용히 달라지는 사고를 막으려는 것이다.

PDF 를 따로 만드는 이유는 쪽수 때문이다. 서식이 "A4 5장 내외"를 요구하는데
워드 파일은 여는 PC 의 글꼴과 여백에 따라 쪽수가 달라진다. PDF 는 굽는 순간
쪽수가 고정되고, 여기서 바로 세어 확인할 수 있다.
"""
import json
import os
import re
import sys

from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (
    BaseDocTemplate, Frame, Image, PageTemplate, Paragraph, Spacer, Table, TableStyle,
)

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
SRC = os.path.join(ROOT, "docs", "proposal.json")
OUT = os.path.join(ROOT, "dist", "제출", "제안요약서.pdf")

FONTS = r"C:\Windows\Fonts"
INK = colors.HexColor("#1a1a1a")
GRAY = colors.HexColor("#5a5a5a")
RULE = colors.HexColor("#c8c8c8")
HEAD_BG = colors.HexColor("#f2f2f2")
BOX_BG = colors.HexColor("#f7f7f7")

MARGIN = 18 * mm
WIDTH = A4[0] - 2 * MARGIN
PAGE_LIMIT = 5


def register_fonts():
    for name, fn in [("KR", "malgun.ttf"), ("KR-B", "malgunbd.ttf")]:
        p = os.path.join(FONTS, fn)
        if not os.path.exists(p):
            sys.exit(f"{p} 가 없습니다. 맑은 고딕이 설치된 윈도우에서 실행하십시오.")
        pdfmetrics.registerFont(TTFont(name, p))
    pdfmetrics.registerFontFamily("KR", normal="KR", bold="KR-B")


def markup(text):
    """**굵게** 와 `코드` 를 reportlab 인라인 태그로 바꾼다."""
    text = text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    text = re.sub(r"\*\*([^*]+)\*\*", r"<b>\1</b>", text)
    # Courier 에는 한글이 없어 네모로 나온다. 한글이 섞인 코드는 본문 글꼴로 쓴다.
    def code(m):
        body = m.group(1)
        if body.isascii():
            return f'<font face="Courier" size=7.6>{body}</font>'
        return f'<font face="KR" size=7.8 color="#333333">{body}</font>'

    text = re.sub(r"`([^`]+)`", code, text)
    return text


def styles():
    base = dict(fontName="KR", textColor=INK, alignment=TA_LEFT)
    return {
        "title": ParagraphStyle("t", fontName="KR-B", fontSize=20, leading=25, textColor=INK, spaceAfter=2),
        "sub": ParagraphStyle("s", fontName="KR", alignment=TA_LEFT, fontSize=11, leading=15,
                              textColor=GRAY, spaceAfter=10),
        "h1": ParagraphStyle("h1", fontName="KR-B", fontSize=12.5, leading=16, textColor=INK,
                             spaceBefore=11, spaceAfter=5),
        "h2": ParagraphStyle("h2", fontName="KR-B", fontSize=10.5, leading=14, textColor=INK,
                             spaceBefore=8, spaceAfter=3),
        "p": ParagraphStyle("p", **base, fontSize=8.8, leading=13.2, spaceAfter=3.5),
        "bul": ParagraphStyle("b", **base, fontSize=8.8, leading=13.2, spaceAfter=2.5,
                              leftIndent=9, bulletIndent=1),
        "box": ParagraphStyle("x", **base, fontSize=8.8, leading=13.6),
        "fx": ParagraphStyle("f", fontName="KR-B", fontSize=11, leading=15, textColor=INK,
                             alignment=TA_CENTER, spaceBefore=4, spaceAfter=6),
        "cell": ParagraphStyle("c", **base, fontSize=8, leading=11.6),
        "cellb": ParagraphStyle("cb", fontName="KR-B", fontSize=8, leading=11.6, textColor=INK),
        "cellc": ParagraphStyle("cc", fontName="KR", fontSize=8, leading=11.6, textColor=INK,
                                alignment=TA_CENTER),
    }


def make_table(b, S):
    widths = [f * WIDTH for f in b["w"]]
    center = set(b.get("center", []))
    data = [[Paragraph(markup(h), S["cellb"]) for h in b["head"]]]
    for row in b["rows"]:
        data.append([Paragraph(markup(c), S["cellc"] if i in center else S["cell"])
                     for i, c in enumerate(row)])
    t = Table(data, colWidths=widths, repeatRows=1)
    t.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("TOPPADDING", (0, 0), (-1, -1), 3.5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 3.5),
        ("LEFTPADDING", (0, 0), (-1, -1), 5),
        ("RIGHTPADDING", (0, 0), (-1, -1), 5),
        ("BACKGROUND", (0, 0), (-1, 0), HEAD_BG),
        ("LINEABOVE", (0, 0), (-1, 0), 0.6, INK),
        ("LINEBELOW", (0, 0), (-1, -2), 0.35, RULE),
        ("LINEBELOW", (0, -1), (-1, -1), 0.6, INK),
    ]))
    return t


def make_box(text, S):
    t = Table([[Paragraph(markup(text), S["box"])]], colWidths=[WIDTH])
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), BOX_BG),
        ("TOPPADDING", (0, 0), (-1, -1), 7),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 7),
        ("LEFTPADDING", (0, 0), (-1, -1), 9),
        ("RIGHTPADDING", (0, 0), (-1, -1), 9),
        ("BOX", (0, 0), (-1, -1), 0.35, RULE),
    ]))
    return t


def build(doc_src, S):
    F = [Paragraph(markup(doc_src["title"]), S["title"]),
         Paragraph(markup(doc_src["subtitle"]), S["sub"])]
    for b in doc_src["blocks"]:
        k = b["t"]
        if k == "h1":
            F.append(Paragraph(markup(b["text"]), S["h1"]))
        elif k == "h2":
            F.append(Paragraph(markup(b["text"]), S["h2"]))
        elif k == "p":
            F.append(Paragraph(markup(b["text"]), S["p"]))
        elif k == "bullet":
            F.append(Paragraph(markup(b["text"]), S["bul"], bulletText="·"))
        elif k == "formula":
            F.append(Paragraph(markup(b["text"]), S["fx"]))
        elif k == "box":
            F.append(make_box(b["text"], S))
            F.append(Spacer(1, 4))
        elif k == "table":
            F.append(make_table(b, S))
            F.append(Spacer(1, 5))
        elif k == "image":
            # 그림은 쪼갤 수 없어 안 들어가면 통째로 다음 쪽으로 넘어간다. 폭을 조금
            # 줄여 두면 앞 쪽 하단에 들어가고, 5장 안에서 빈 공간이 생기지 않는다.
            path = os.path.join(ROOT, b["src"].replace("/", os.sep))
            w = WIDTH * b.get("w", 1.0)
            img = Image(path, width=w, height=w * b["ratio"])
            img.hAlign = "CENTER"
            F.append(img)
            F.append(Spacer(1, 6))
        else:
            sys.exit(f"모르는 블록 종류: {k}")
    return F


def footer(canvas, doc):
    canvas.saveState()
    canvas.setFont("KR", 7.5)
    canvas.setFillColor(GRAY)
    canvas.drawString(MARGIN, 10 * mm, "매출연동 임대차 · 제안요약서 · 2026 AI Blockchain Challenge in Daegu")
    canvas.drawRightString(A4[0] - MARGIN, 10 * mm, f"{doc.page}")
    canvas.restoreState()


def main():
    register_fonts()
    src = json.load(open(SRC, encoding="utf-8"))
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    doc = BaseDocTemplate(OUT, pagesize=A4,
                          leftMargin=MARGIN, rightMargin=MARGIN,
                          topMargin=16 * mm, bottomMargin=16 * mm,
                          title="제안요약서 — 매출연동 임대차", author="장예현")
    frame = Frame(doc.leftMargin, doc.bottomMargin, WIDTH,
                  A4[1] - doc.topMargin - doc.bottomMargin, id="body")
    doc.addPageTemplates([PageTemplate(id="p", frames=[frame], onPage=footer)])
    doc.build(build(src, styles()))

    pages = doc.page
    size = os.path.getsize(OUT) // 1024
    print(f"  → {os.path.relpath(OUT, ROOT)}  {size}KB  {pages}쪽")
    if pages > PAGE_LIMIT:
        print(f"  ! A4 {PAGE_LIMIT}장 기준을 {pages - PAGE_LIMIT}장 넘습니다. 5절 표부터 줄이십시오.")
        sys.exit(1)
    print(f"  A4 {PAGE_LIMIT}장 기준 이내")


if __name__ == "__main__":
    main()
