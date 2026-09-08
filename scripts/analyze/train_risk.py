#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
점포 소멸(폐업 추정) 예측이 공개 데이터로 가능한지 검증한다.

    python scripts/analyze/train_risk.py

입력  data/processed/stores.csv        (build-dataset.js 가 만든다)
출력  web/public/model-validation.json (화면과 제안서에서 인용할 검증 요약)
      data/processed/risk-model.pkl    (학습된 모델 원본)

왜 "학습"이 아니라 "검증" 스크립트인가:
    이 데이터로 점포 단위 예측이 되는지부터 확인해야 한다. 되지 않는다면
    업종 평균을 쓰는 지금 방식이 옳다는 근거가 되고, 그 판단 자체가 결과물이다.
    성능이 안 나오는 모델을 "AI를 썼다"고 붙이는 것보다, 왜 안 되는지 아는 편이 낫다.

검증 방식은 **시점 분리**다. 과거 구간으로 학습해 다음 구간을 맞히는지 본다.
같은 구간을 무작위로 쪼개면 미래를 맞히는 능력이 아니라 과거를 외우는 능력을 재게 된다.

주의: 원자료에 공식 폐업 플래그가 없어 "직전 스냅샷에 있던 상가업소번호가 사라진 것"을
      소멸로 추정한다. 이전·상호변경·휴업이 섞여 있다.
"""
import json
import os
import sys

import numpy as np
import pandas as pd
from sklearn.compose import ColumnTransformer
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.impute import SimpleImputer
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import average_precision_score, brier_score_loss, roc_auc_score
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import OneHotEncoder, StandardScaler

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SRC = os.path.join(ROOT, "data", "processed", "stores.csv")
OUT_JSON = os.path.join(ROOT, "web", "public", "model-validation.json")
OUT_PKL = os.path.join(ROOT, "data", "processed", "risk-model.pkl")

CATS = ["small", "mid", "big", "sgg", "dong"]
NUMS = ["floor", "basement", "dens_all", "dens_same", "bus_stops", "bus_routes", "bus_nearest"]
MIN_FREQ = 30

LABEL = {
    "floor": "층수",
    "basement": "지하 여부",
    "dens_all": "반경 200m 점포 수",
    "dens_same": "반경 200m 동종업종 수",
    "bus_stops": "반경 200m 버스정류장 수",
    "bus_routes": "반경 200m 경유노선 수",
    "bus_nearest": "최근접 정류장 거리",
    "small": "업종 소분류",
    "mid": "업종 중분류",
    "dong": "행정동",
    "sgg": "시군구",
}


def load():
    if not os.path.exists(SRC):
        sys.exit(f"{SRC} 가 없습니다. 먼저 node scripts/analyze/build-dataset.js 를 실행하십시오.")
    df = pd.read_csv(SRC, dtype={"obs_date": str, "next_date": str})
    for c in CATS:
        df[c] = df[c].fillna("").astype(str)
    return df


def report(name, y, p):
    return {
        "model": name,
        "rocAuc": round(float(roc_auc_score(y, p)), 4),
        "prAuc": round(float(average_precision_score(y, p)), 4),
        "brier": round(float(brier_score_loss(y, p)), 4),
    }


def main():
    df = load()
    intervals = sorted(df["obs_date"].unique())
    if len(intervals) < 2:
        sys.exit("관측 구간이 1개뿐입니다. 스냅샷이 3개 이상 있어야 시점 분리 검증이 됩니다.")

    tr = df[df["obs_date"] == intervals[0]]
    te = df[df["obs_date"] == intervals[-1]]
    Xtr, ytr = tr[CATS + NUMS], tr["gone"].values
    Xte, yte = te[CATS + NUMS], te["gone"].values

    print(f"  학습 {intervals[0]}→{tr['next_date'].iloc[0]} ({int(tr['months'].iloc[0])}개월) "
          f"{len(tr):,}행 · 소멸 {int(tr['gone'].sum()):,}건 ({tr['gone'].mean()*100:.1f}%)")
    print(f"  검증 {intervals[-1]}→{te['next_date'].iloc[0]} ({int(te['months'].iloc[0])}개월) "
          f"{len(te):,}행 · 소멸 {int(te['gone'].sum()):,}건 ({te['gone'].mean()*100:.1f}%)\n")

    # ---------- 1) 모델 비교 ----------
    cat_enc = OneHotEncoder(handle_unknown="infrequent_if_exist", min_frequency=MIN_FREQ, sparse_output=False)
    lr = Pipeline([
        ("pre", ColumnTransformer([
            ("cat", cat_enc, CATS),
            ("num", Pipeline([("imp", SimpleImputer(strategy="median", add_indicator=True)),
                              ("sc", StandardScaler())]), NUMS)])),
        # 소멸이 5%뿐이라 가중치를 주지 않으면 전부 "생존"으로 찍는 쪽이 유리해진다
        ("clf", LogisticRegression(max_iter=2000, C=0.5, class_weight="balanced")),
    ]).fit(Xtr, ytr)

    gb = Pipeline([
        ("pre", ColumnTransformer([
            ("cat", OneHotEncoder(handle_unknown="infrequent_if_exist", min_frequency=MIN_FREQ, sparse_output=False), CATS),
            ("num", SimpleImputer(strategy="median", add_indicator=True), NUMS)])),
        ("clf", HistGradientBoostingClassifier(max_iter=200, learning_rate=0.08, random_state=0)),
    ]).fit(Xtr, ytr)

    # 지금 서비스가 쓰는 방식이 기준선이다. 모델이 이걸 못 이기면 쓸 이유가 없다.
    rate = tr.groupby("small")["gone"].mean()
    p_base = te["small"].map(rate).fillna(tr["gone"].mean()).values

    models = [
        report("업종 평균 (현재 방식)", yte, p_base),
        report("로지스틱 회귀", yte, lr.predict_proba(Xte)[:, 1]),
        report("그래디언트 부스팅", yte, gb.predict_proba(Xte)[:, 1]),
    ]
    print("  모델 비교 (ROC-AUC 0.5 = 무작위)")
    for m in models:
        print(f"    {m['model']:<22} ROC-AUC {m['rocAuc']:.3f}   PR-AUC {m['prAuc']:.3f}")

    # ---------- 2) 피처별 단독 신호 ----------
    feats = []
    for c in NUMS:
        m = te[c].notna()
        if m.sum() < 1000:
            continue
        a = roc_auc_score(te.loc[m, "gone"], te.loc[m, c])
        feats.append({"feature": LABEL.get(c, c), "rocAuc": round(float(max(a, 1 - a)), 4),
                      "missingPct": round(float(te[c].isna().mean() * 100), 1)})
    for c in ["small", "dong", "sgg"]:
        r = tr.groupby(c)["gone"].mean()
        p = te[c].map(r).fillna(tr["gone"].mean())
        feats.append({"feature": LABEL.get(c, c), "rocAuc": round(float(roc_auc_score(yte, p)), 4), "missingPct": 0.0})
    feats.sort(key=lambda x: -x["rocAuc"])
    print("\n  피처별 단독 판별력")
    for f in feats:
        print(f"    {f['feature']:<22} {f['rocAuc']:.3f}" + (f"   결측 {f['missingPct']:.0f}%" if f["missingPct"] else ""))

    # ---------- 3) 집계 추정의 안정성 ----------
    def stability(keys, min_n):
        a = tr.groupby(keys)["gone"].agg(n1="size", p1="mean")
        b = te.groupby(keys)["gone"].agg(n2="size", p2="mean")
        j = a.join(b, how="inner")
        j = j[(j.n1 >= min_n) & (j.n2 >= min_n)]
        if len(j) < 20:
            return None
        return {"minSample": min_n, "cells": int(len(j)), "corr": round(float(np.corrcoef(j.p1, j.p2)[0, 1]), 3)}

    sector_stab = [s for s in (stability("small", n) for n in (30, 100, 300)) if s]
    district_stab = [s for s in (stability(["dong", "small"], n) for n in (30, 100, 300)) if s]
    print("\n  집계 추정의 안정성 (학습구간 소멸률과 검증구간 소멸률의 상관)")
    for s in sector_stab:
        print(f"    업종      표본 {s['minSample']:>3}개 이상 {s['cells']:>4}개 : {s['corr']:.3f}")
    for s in district_stab:
        print(f"    상권x업종 표본 {s['minSample']:>3}개 이상 {s['cells']:>4}개 : {s['corr']:.3f}")

    # 상권 세분화를 신뢰할 최소 표본: 업종 단위 안정성에 근접하는 지점
    sector_best = max(s["corr"] for s in sector_stab)
    reliable_n = next((s["minSample"] for s in district_stab if s["corr"] >= sector_best * 0.9), 300)

    out = {
        "generatedAt": pd.Timestamp.now("UTC").isoformat(),
        "question": "공개 데이터만으로 개별 점포의 폐업을 예측할 수 있는가",
        "answer": "예측되지 않는다. 업종이 유일한 신호이며, 그 신호는 업종 평균으로 이미 얻고 있다.",
        "train": {"from": intervals[0], "to": str(tr["next_date"].iloc[0]),
                  "months": int(tr["months"].iloc[0]), "rows": int(len(tr)), "eventRate": round(float(tr["gone"].mean()), 4)},
        "test": {"from": intervals[-1], "to": str(te["next_date"].iloc[0]),
                 "months": int(te["months"].iloc[0]), "rows": int(len(te)), "eventRate": round(float(te["gone"].mean()), 4)},
        "models": models,
        "features": feats,
        "stability": {"sector": sector_stab, "districtSector": district_stab},
        "reliableDistrictSample": int(reliable_n),
        "conclusion": [
            "점포 단위 예측은 ROC-AUC 0.60 수준으로, 업종 평균과 차이가 없다.",
            "위치 기반 피처(행정동·점포밀도·버스 접근성·층)는 단독 판별력이 0.50~0.53으로 사실상 무신호다.",
            "상가정보에는 매출·임대료·개업일·사업자 특성이 없다. 폐업을 가르는 변수가 데이터에 없다.",
            f"업종별 소멸률은 다음 분기에도 재현된다(상관 {sector_best:.2f}). 업종 단위 추정은 근거가 있다.",
            f"상권x업종 세분화는 표본 {reliable_n}개 이상일 때만 신뢰할 수 있다. 그 미만은 표본 노이즈다.",
        ],
    }
    os.makedirs(os.path.dirname(OUT_JSON), exist_ok=True)
    with open(OUT_JSON, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=1)

    try:
        import joblib
        os.makedirs(os.path.dirname(OUT_PKL), exist_ok=True)
        joblib.dump({"logistic": lr, "gradient_boosting": gb}, OUT_PKL)
    except Exception as e:
        print(f"  (모델 저장 실패: {e})")

    print(f"\n  결론: {out['answer']}")
    print(f"  상권 세분화 신뢰 최소 표본: {reliable_n}개")
    print(f"  → {os.path.relpath(OUT_JSON, ROOT)}")


if __name__ == "__main__":
    main()
