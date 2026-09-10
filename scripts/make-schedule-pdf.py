#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
제출 일정표를 인쇄용 PDF 로 만든다.

    python scripts/make-schedule-pdf.py

원고는 docs/08-일정.md 이고 여기서 서식을 입힌다. 마크다운을 파싱하지 않고
넣을 것을 명시한다 — 제안요약서와 같은 이유다.

이 PC 에는 LibreOffice 도 pandoc 도 없어서 md→pdf 변환기를 쓸 수 없다.
reportlab 은 순수 파이썬이라 그런 것에 기대지 않는다. 한글은 맑은 고딕을
직접 등록해 쓴다.
"""
import os
import sys

from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (
    BaseDocTemplate, Frame, KeepTogether, PageTemplate, Paragraph, Table, TableStyle,
)

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
OUT = os.path.join(ROOT, "dist", "매출연동임대차_제출일정.pdf")

FONTS = r"C:\Windows\Fonts"
INK = colors.HexColor("#1a1a1a")
GRAY = colors.HexColor("#666666")
RULE = colors.HexColor("#d0d0d0")
HEAD_BG = colors.HexColor("#f2f2f2")
DONE = colors.HexColor("#1a7f4b")
TODO = colors.HexColor("#b3261e")

WIDTH = A4[0] - 40 * mm


def register_fonts():
    # 맑은 고딕에 없는 글자를 쓰면 조용히 빈칸으로 나온다. 공고문의 ❺ 가 그렇다.
    # 대신 ⑤(U+2465)를 쓴다 — 같은 뜻이고 이 글꼴에 들어 있다.
    faces = [("Malgun", "malgun.ttf"), ("Malgun-Bold", "malgunbd.ttf")]
    for name, fn in faces:
        path = os.path.join(FONTS, fn)
        if not os.path.exists(path):
            sys.exit(f"{path} 가 없습니다. 맑은 고딕이 설치된 윈도우에서 실행하십시오.")
        pdfmetrics.registerFont(TTFont(name, path))
    pdfmetrics.registerFontFamily("Malgun", normal="Malgun", bold="Malgun-Bold")


def styles():
    base = dict(fontName="Malgun", textColor=INK, alignment=TA_LEFT)
    return {
        "title": ParagraphStyle("title", fontName="Malgun-Bold", fontSize=19, leading=24,
                                textColor=INK, spaceAfter=3),
        "sub": ParagraphStyle("sub", **base, fontSize=10, leading=15, spaceAfter=14),
        "h": ParagraphStyle("h", fontName="Malgun-Bold", fontSize=12, leading=16,
                            textColor=INK, spaceBefore=14, spaceAfter=6),
        "p": ParagraphStyle("p", **base, fontSize=9, leading=14, spaceAfter=4),
        "note": ParagraphStyle("note", fontName="Malgun", fontSize=8.5, leading=13,
                               textColor=GRAY, spaceBefore=3, spaceAfter=2),
        "cell": ParagraphStyle("cell", **base, fontSize=8.5, leading=12.5),
        "cellb": ParagraphStyle("cellb", fontName="Malgun-Bold", fontSize=8.5, leading=12.5,
                                textColor=INK),
    }


def table(rows, widths, S, header=True, align_center=()):
    data = []
    for r, row in enumerate(rows):
        line = []
        for c, txt in enumerate(row):
            st = S["cellb"] if (header and r == 0) else S["cell"]
            if c in align_center:
                st = ParagraphStyle("c", parent=st, alignment=1)
            line.append(Paragraph(txt, st))
        data.append(line)
    t = Table(data, colWidths=widths, repeatRows=1 if header else 0)
    style = [
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("TOPPADDING", (0, 0), (-1, -1), 5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
        ("LEFTPADDING", (0, 0), (-1, -1), 6),
        ("RIGHTPADDING", (0, 0), (-1, -1), 6),
        ("LINEBELOW", (0, 0), (-1, -2), 0.4, RULE),
        ("LINEBELOW", (0, -1), (-1, -1), 0.7, INK),
    ]
    if header:
        style += [("BACKGROUND", (0, 0), (-1, 0), HEAD_BG),
                  ("LINEABOVE", (0, 0), (-1, 0), 0.7, INK)]
    t.setStyle(TableStyle(style))
    return t


def build():
    S = styles()
    F = []
    ok = f'<font color="#{DONE.hexval()[2:]}"><b>완료</b></font>'
    no = f'<font color="#{TODO.hexval()[2:]}"><b>미착수</b></font>'

    F.append(Paragraph("매출연동 임대차 — 제출 일정", S["title"]))
    F.append(Paragraph(
        "2026 AI Blockchain Challenge in Daegu · 단독 참가<br/>"
        "마감 <b>2026. 9. 20.(일) 23:59</b> · 목표 제출 <b>9/16(수)</b> · 오늘 9/10(목) 기준 <b>D-10</b>",
        S["sub"]))
    F.append(Paragraph(
        "접수처는 마감 전까지 수정·보완을 허용한다. 목표 제출일을 마감 나흘 전으로 잡고 "
        "남은 나흘을 교체용 여유로 둔다. 마감일에 처음 올리는 일정은 만들지 않는다.", S["p"]))

    F.append(Paragraph("지금 상태", S["h"]))
    F.append(table([
        ["제출물", "상태"],
        ["붙임 1 참가신청서", f"{no} — 서식 필요. 공모주제는 ⑤ 블록체인 기반 신뢰 인프라로 확정"],
        ["붙임 2 참가서약서", f"{no} — 서식 필요"],
        ["붙임 3 개인정보 동의서", f"{no} — 서식 필요. 단독 참가라 1인분"],
        ["붙임 4 제안요약서", "원고·워드 파일 완성. 공식 서식에 옮기는 것이 남음 (쪽수 확인 9/14)"],
        ["프로토타입 ZIP", f"{ok} — 49개 파일 0.8MB"],
        ["시연영상", "대본 완성, <b>촬영 남음</b>"],
        ["공개 URL (선택)", "faucet 대기"],
    ], [42 * mm, WIDTH - 42 * mm], S))
    F.append(Paragraph(
        "프로토타입 ZIP 이 이미 있으므로 영상이 없어도 제출 요건은 충족한다. "
        "영상은 심사에서 유리해서 찍는 것이지, 없으면 못 내는 것이 아니다.", S["note"]))

    F.append(KeepTogether([
        Paragraph("내가 못 하는 일 — 본인이 해야 뒤가 풀린다", S["h"]),
        table([
            ["할 일", "시간", "왜 대신 못 하나"],
            ["faucet 에서 테스트 KAIA 받기<br/>"
             "<font size=7.5 color='#666666'>0xf5d4c72E482f6CafB0615B1b474185BE406e2E1e</font>",
             "5분", "CAPTCHA"],
            ["Render 계정 연결·OAuth 승인", "10분", "계정 인증은 대신할 수 없다"],
            ["붙임 1~3 서식 내려받기", "10분", "im-challenge.com 로그인 필요"],
            ["날인·전자서명", "20분", "원본 직인"],
            ["시연영상 촬영", "2시간", "목소리"],
            ["제안요약서 쪽수 확인 (9/14)", "5분", "이 PC 에 LibreOffice 가 없어 PDF 변환 불가"],
        ], [WIDTH - 62 * mm, 17 * mm, 45 * mm], S, align_center=(1,)),
    ]))

    F.append(Paragraph("날짜별", S["h"]))
    F.append(table([
        ["날짜", "할 일"],
        ["<b>9/10 (목)</b><br/><font size=7.5 color='#666666'>오늘</font>",
         "<b>막힌 것부터 푼다.</b> ① faucet 수령 → 알려주면 테스트넷 배포와 Render 연결까지 이어서 함 "
         "② 붙임 1~3 서식 내려받아 전달 → 받는 즉시 채울 수 있는 칸을 채워 둠<br/>"
         "<font size=7.5 color='#666666'>이 둘이 오늘 안 풀리면 뒤가 전부 밀린다. 나머지는 오늘 안 해도 된다.</font>"],
        ["<b>9/11 (금)</b><br/><font size=7.5 color='#666666'>서류</font>",
         "제안요약서를 공식 서식에 옮김 (내가 함) · 붙임 1~3 작성 (본인 정보·주제 ⑤·연락처)"],
        ["<b>9/12 (토)<br/>~ 9/13 (일)</b><br/><font size=7.5 color='#666666'>영상</font>",
         "대본대로 촬영, 4분 40초 목표 · 증빙 대조 장면은 반드시 성공시킴 · 촬영 후 체크리스트 4개<br/>"
         "<font size=7.5 color='#666666'>주말에 둔 이유는 다시 찍을 시간이 필요해서다. 한 번에 끝난다고 가정하지 않는다.</font>"],
        ["<b>9/14 (월)</b><br/><font size=7.5 color='#666666'>날인</font>",
         "붙임 1~3 인쇄 → 날인 → 스캔 → <b>1개 파일로 병합</b> · "
         "<b>제안요약서 Word 로 열어 쪽수 확인</b> → 5장 넘으면 5절 검증 표부터 줄임"],
        ["<b>9/15 (화)</b><br/><font size=7.5 color='#666666'>점검</font>",
         "제출물 전부를 한 폴더에 모아 처음부터 확인 · ZIP 재생성 · 500자 요약 재확인(현재 458자) · "
         "영상을 다른 PC 에서 재생"],
        ["<b>9/16 (수)</b><br/><font size=7.5 color='#666666'>제출</font>",
         "<b>im-challenge.com 접수</b> · 접수 완료 화면 캡처 보관"],
        ["<b>9/17 (목)<br/>~ 9/20 (일)</b><br/><font size=7.5 color='#666666'>여유</font>",
         "수정·보완 가능 기간. <b>비워 두는 것이 목적이다.</b> 새 기능을 넣지 않고 발견된 오류만 고쳐 교체한다"],
    ], [26 * mm, WIDTH - 26 * mm], S))

    F.append(KeepTogether([
        Paragraph("위험 요소", S["h"]),
        table([
            ["위험", "영향", "대비"],
            ["제안요약서가 5장을 넘음", "서식 위반",
             "9/14 에 확인. 넘으면 5절 검증 표부터 줄인다 — 본문이 아니라 표부터"],
            ["공식 서식이 한글(HWP) 전용", "워드 파일을 못 씀",
             "원고가 마크다운으로 있으므로 옮겨 붙이면 된다. 서식만 주면 된다"],
            ["faucet 이 계속 막힘", "공개 URL 없음",
             "ZIP 제출로 요건 충족. URL 은 가산점이지 필수가 아니다"],
            ["영상 촬영이 밀림", "—", "ZIP 이 있어 제출은 가능하다. 영상은 포기해도 된다"],
        ], [40 * mm, 28 * mm, WIDTH - 68 * mm], S),
        Paragraph("단독 참가라 사람을 기다리는 위험은 없다. 남은 위험은 서류 서식뿐이고, "
                  "코드 쪽은 이미 제출 가능한 상태다.", S["note"]),
    ]))

    F.append(KeepTogether([
        Paragraph("본선에 갔다면", S["h"]),
        table([
            ["9/23 (수)", "본선 진출 발표 (10개 팀)"],
            ["9/28 (월)", "멘토링 · DIP 태양홀"],
            ["10/22 (목)", "본선 발표·시상 · 대구 EXCO 서관 322호"],
        ], [26 * mm, WIDTH - 26 * mm], S, header=False),
        Paragraph("발표는 15분(발표 10분 + 질의응답 5분). 예상 질문 6개와 답변은 이미 정리돼 있다. "
                  "발표 슬라이드는 본선이 확정되면 만든다 — 지금 만들면 버릴 확률이 높다.", S["note"]),
    ]))
    return F


def footer(canvas, doc):
    canvas.saveState()
    canvas.setFont("Malgun", 7.5)
    canvas.setFillColor(GRAY)
    canvas.drawString(20 * mm, 12 * mm, "매출연동 임대차 · 제출 일정 · 2026-09-10 기준")
    canvas.drawRightString(A4[0] - 20 * mm, 12 * mm, f"{doc.page}")
    canvas.restoreState()


def main():
    register_fonts()
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    doc = BaseDocTemplate(OUT, pagesize=A4,
                          leftMargin=20 * mm, rightMargin=20 * mm,
                          topMargin=18 * mm, bottomMargin=20 * mm,
                          title="매출연동 임대차 — 제출 일정", author="장예현")
    frame = Frame(doc.leftMargin, doc.bottomMargin, WIDTH,
                  A4[1] - doc.topMargin - doc.bottomMargin, id="body")
    doc.addPageTemplates([PageTemplate(id="p", frames=[frame], onPage=footer)])
    doc.build(build())
    print(f"  → {os.path.relpath(OUT, ROOT)}  {os.path.getsize(OUT) // 1024}KB  {doc.page}쪽")


if __name__ == "__main__":
    main()
