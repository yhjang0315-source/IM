import { useEffect, useMemo, useState } from "react";
import {
  site, suggested, FIXED_RENT, won, pct, quoteLocal, termsDigest, signTerms, activate, endLease,
  loadDraft, saveDraft, clearDraft, roles, ROLE_LABEL, short, monthLabel, ZERO, MEDIATION_DAYS, DISPUTE_DAYS,
} from "./lease";

const DEMO_REV = [12, 10, 16, 19, 21, 18, 15, 14, 20, 22, 24, 26]; // 백만원, 미리보기용
const man = (v) => Math.round(Number(v) / 10_000) * 10_000;   // 만원 단위 반올림
const n = (v) => Number(v || 0);

function freshDraft() {
  const s = suggested || {};
  return {
    sector: "", district: "",
    marketRent: FIXED_RENT.toString(), expectedRev: "20000000",
    baseRent: s.baseRent || "800000", pctBps: s.pctBps ?? 800,
    floorRent: s.floorRent || "1500000", capRent: s.capRent || "3500000",
    totalPeriods: s.totalPeriods || 12,
    deposit: s.deposit || "10000000",
    mediator: ZERO,
    sigL: null, sigT: null,
  };
}

/** 계약 탭. Draft면 체결 마법사, Active/Ended면 확정 조건과 종료. */
export default function Contract({ lease, market, role, setRole, act, busy }) {
  if (!lease) return null;
  if (lease.state === 0) return <Wizard market={market} role={role} setRole={setRole} act={act} busy={busy} />;
  return <Active lease={lease} role={role} setRole={setRole} act={act} busy={busy} />;
}

// ------------------------------------------------------------------ 체결 마법사
function Wizard({ market, role, setRole, act, busy }) {
  const [d, setD] = useState(() => loadDraft() || freshDraft());
  useEffect(() => { saveDraft(d); }, [d]);
  const set = (k, v) => setD((x) => ({ ...x, [k]: v }));

  const step = !d.sigL ? 1 : !d.sigT ? 2 : 3;
  const locked = step > 1;

  // 실데이터 권장값. 상권을 고르면 그 상권 값, 아니면 업종 값.
  const rec = useMemo(() => {
    if (!market || !d.sector) return null;
    const sec = market.sectors.find((s) => s.sector === d.sector);
    if (!sec) return null;
    const dis = d.district
      ? market.districts.find((x) => x.district === d.district && sec.sector.endsWith(x.sector)) : null;
    const src = dis || sec;
    const mr = n(d.marketRent), er = n(d.expectedRev);
    const base = man(mr * src.recommended.baseShare);
    const linked = Math.max(0, mr - base);
    const bps = er > 0 ? Math.max(0, Math.min(10_000, Math.round((linked / er) * 10_000))) : 0;
    return { src, sec, isDistrict: !!dis, base, bps, floor: man(mr * 0.6), cap: man(mr * 1.4), deposit: man(mr * 10) };
  }, [market, d.sector, d.district, d.marketRent, d.expectedRev]);

  const districtsFor = useMemo(() => {
    if (!market || !d.sector) return [];
    return market.districts.filter((x) => d.sector.endsWith(x.sector))
      .sort((a, b) => b.countFirst - a.countFirst);
  }, [market, d.sector]);

  const problems = [];
  if (n(d.floorRent) > n(d.capRent)) problems.push("하한이 상한보다 큽니다.");
  if (n(d.pctBps) < 0 || n(d.pctBps) > 10_000) problems.push("연동률은 0~100% 사이여야 합니다.");
  if (n(d.totalPeriods) < 1) problems.push("계약 기간은 1개월 이상이어야 합니다.");
  const valid = problems.length === 0;

  const preview = DEMO_REV.map((v, i) => {
    const rev = BigInt(v) * 1_000_000n;
    const rent = valid ? quoteLocal(d, rev) : 0n;
    return { m: i + 1, rev, rent };
  });
  const worst = preview.reduce((a, p) => Math.max(a, pct(p.rent, p.rev)), 0);
  const worstFixed = preview.reduce((a, p) => Math.max(a, pct(FIXED_RENT, p.rev)), 0);
  const digest = valid ? termsDigest(d) : null;

  const apply = () => rec && setD((x) => ({
    ...x, baseRent: String(rec.base), pctBps: rec.bps, floorRent: String(rec.floor),
    capRent: String(rec.cap), deposit: String(rec.deposit),
  }));

  const signL = () => act("sign-l", async () => { set("sigL", await signTerms("landlord", d)); }, "임대인 서명 완료 (오프체인)");
  const signT = () => act("sign-t", async () => { set("sigT", await signTerms("tenant", d)); }, "임차인 서명 완료 (오프체인)");
  const reject = () => setD((x) => ({ ...x, sigL: null, sigT: null }));
  const confirm = () => act("activate", async () => {
    const rc = await activate(role, d, d.sigL, d.sigT);
    saveDraft({ ...d, activated: true });
    return rc;
  }, "조건 확정 — 이제 누구도 바꿀 수 없습니다");
  const reset = () => { clearDraft(); setD(freshDraft()); };

  return (
    <section className="pane">
      <div className="steps" aria-label="체결 단계">
        {[["1", "임대인 조건 작성"], ["2", "임차인 검토·서명"], ["3", "체인에 확정"]].map(([k, v], i) => (
          <div key={k} className={`step ${step === i + 1 ? "on" : step > i + 1 ? "done" : ""}`}>
            <span className="sn">{step > i + 1 ? "✓" : k}</span><span>{v}</span>
          </div>
        ))}
      </div>

      <h2>조건</h2>
      <p className="lead">
        {site.name} · {site.district}. 임대료 = 기본료 + 매출×연동률, 하한과 상한 사이로 고정.
        확정 후에는 컨트랙트에 이 값을 바꾸는 함수가 없습니다.
      </p>

      <div className="frm">
        <div className="fgroup">
          <span className="ftitle">근거 데이터</span>
          <label>업종
            <select value={d.sector} disabled={locked || !market} onChange={(e) => { set("sector", e.target.value); set("district", ""); }}>
              <option value="">{market ? "선택 — 대구 실데이터 권장값을 불러옵니다" : "market.json 없음"}</option>
              {market && [...market.sectors].sort((a, b) => b.countFirst - a.countFirst).slice(0, 80).map((s) => (
                <option key={s.sector} value={s.sector}>{s.sector} (n={s.countFirst.toLocaleString()})</option>
              ))}
            </select>
          </label>
          <label>상권 <span className="opt">선택</span>
            <select value={d.district} disabled={locked || !districtsFor.length} onChange={(e) => set("district", e.target.value)}>
              <option value="">업종 전체 평균</option>
              {districtsFor.map((x) => (
                <option key={x.district} value={x.district}>{x.district} (n={x.countFirst}, 소멸 {(x.disappearRate * 100).toFixed(1)}%)</option>
              ))}
            </select>
          </label>
          <label>시세 임대료 (고정 월세라면)
            <input type="number" step="10000" value={d.marketRent} disabled={locked} onChange={(e) => set("marketRent", e.target.value)} />
          </label>
          <label>예상 월매출
            <input type="number" step="1000000" value={d.expectedRev} disabled={locked} onChange={(e) => set("expectedRev", e.target.value)} />
          </label>
        </div>

        {rec && (
          <div className="recbox">
            <div>
              <b>{rec.isDistrict ? d.district : "업종 평균"}</b> · 표본 {rec.src.countFirst.toLocaleString()}개 ·
              연 잔존 {(rec.src.annualSurvival * 100).toFixed(1)}% →
              권장 기본료 <b>{(rec.src.recommended.baseShare * 100).toFixed(0)}%</b> / 연동 {(rec.src.recommended.linkedShare * 100).toFixed(0)}%
            </div>
            <div className="recv">
              기본료 {won(rec.base)} · 연동률 {(rec.bps / 100).toFixed(1)}% · 하한 {won(rec.floor)} · 상한 {won(rec.cap)} · 보증금 {won(rec.deposit)}
            </div>
            <div className="btns"><button type="button" className="ghost" disabled={locked} onClick={apply}>권장값 적용</button></div>
          </div>
        )}

        <div className="fgroup">
          <span className="ftitle">계약 조건 {locked && <em>서명됨 · 잠김</em>}</span>
          <label>기본료 (원/월)
            <input type="number" step="10000" value={d.baseRent} disabled={locked} onChange={(e) => set("baseRent", e.target.value)} />
          </label>
          <label>매출 연동률 (%)
            <input type="number" step="0.1" min="0" max="100" value={(n(d.pctBps) / 100).toFixed(1)} disabled={locked}
              onChange={(e) => set("pctBps", Math.round(Number(e.target.value) * 100))} />
          </label>
          <label>하한 (원/월)
            <input type="number" step="10000" value={d.floorRent} disabled={locked} onChange={(e) => set("floorRent", e.target.value)} />
          </label>
          <label>상한 (원/월)
            <input type="number" step="10000" value={d.capRent} disabled={locked} onChange={(e) => set("capRent", e.target.value)} />
          </label>
          <label>계약 기간 (개월)
            <input type="number" min="1" max="60" value={d.totalPeriods} disabled={locked} onChange={(e) => set("totalPeriods", Number(e.target.value))} />
          </label>
          <label>보증금 (원)
            <input type="number" step="1000000" value={d.deposit} disabled={locked} onChange={(e) => set("deposit", e.target.value)} />
          </label>
          <label>조정인 <span className="opt">교착 시</span>
            <select value={d.mediator} disabled={locked} onChange={(e) => set("mediator", e.target.value)}>
              <option value={ZERO}>지정 안 함 — 분쟁은 오직 양측 합의로만</option>
              <option value={roles.mediator}>지정 ({short(roles.mediator)})</option>
            </select>
          </label>
        </div>
      </div>

      <p className="hint">
        보증금은 종료 시 남은 미납분을 먼저 회수하고 나머지를 돌려줍니다.
        조정인을 지정하면 이의가 {MEDIATION_DAYS}일 넘게 풀리지 않을 때만 개입할 수 있습니다 —
        은행은 조정인이 될 수 없고, 지정 자체가 양측 서명 대상입니다.
      </p>

      {problems.length > 0 && <div className="err">{problems.join(" ")}</div>}

      {valid && (
        <>
          <h2>이 조건이면 — 12개월 미리보기</h2>
          <div className="cards">
            <Card label="최악의 달 부담률" value={`${worst.toFixed(1)}%`} accent />
            <Card label="고정 월세였다면" value={`${worstFixed.toFixed(1)}%`} muted />
            <Card label="보증금" value={`${won(d.deposit)}원`} />
            <Card label="조건 해시" value={short(digest)} mono />
          </div>
          <p className="hint">미리보기 매출은 시연용 가정치입니다. 실제 매출은 결제 게이트웨이가 매달 게시합니다.</p>
        </>
      )}

      <h2>서명</h2>
      <div className="sigs">
        <SigRow who="landlord" sig={d.sigL} />
        <SigRow who="tenant" sig={d.sigT} />
      </div>

      <div className="btns">
        {step === 1 && (role === "landlord"
          ? <button disabled={!!busy || !valid} onClick={signL}>임대인 서명</button>
          : <Need role="landlord" setRole={setRole} what="조건 작성과 서명" />)}
        {step === 2 && (role === "tenant"
          ? <>
              <button disabled={!!busy} onClick={signT}>임차인 서명</button>
              <button className="ghost" disabled={!!busy} onClick={reject}>반려 — 조건 수정 요청</button>
            </>
          : <Need role="tenant" setRole={setRole} what="검토와 서명" />)}
        {step === 3 && (
          <>
            <button disabled={!!busy} onClick={confirm}>{busy === "activate" ? "전송 중…" : "체인에 확정"}</button>
            <span className="hint">누가 보내도 됩니다. 두 서명이 조건 해시와 맞아야만 통과합니다.</span>
          </>
        )}
        <button className="ghost right" disabled={!!busy} onClick={reset}>처음부터</button>
      </div>
    </section>
  );
}

function SigRow({ who, sig }) {
  return (
    <div className={`sig ${sig ? "ok" : ""}`}>
      <span className="sw">{ROLE_LABEL[who]}</span>
      <span className="sa">{short(roles[who])}</span>
      <span className="ss">{sig === "on-chain" ? "서명 검증됨 (체인)" : sig ? `서명됨 · ${short(sig)}` : "대기 중"}</span>
    </div>
  );
}

function Need({ role, setRole, what }) {
  return (
    <span className="need">
      {what}은 <b>{ROLE_LABEL[role]}</b>만 할 수 있습니다.
      <button type="button" className="link" onClick={() => setRole(role)}>{ROLE_LABEL[role]}으로 전환</button>
    </span>
  );
}

// ------------------------------------------------------------------ 확정된 계약
function Active({ lease, role, setRole, act, busy }) {
  const t = lease.terms;
  const digest = termsDigest(t);
  const draft = loadDraft();
  const sigs = draft && draft.activated && termsDigest(draft) === digest ? draft : null;
  const ended = lease.state === 2;

  const end = () => {
    if (!window.confirm("계약을 종료합니다. 이후 예치·게시·정산이 모두 막힙니다. 계속할까요?")) return;
    act("end", () => endLease(role), "계약 종료");
  };

  return (
    <section className="pane">
      <h2>{ended ? "종료된 계약" : "확정된 계약"}</h2>
      <p className="lead">
        {site.name} · {monthLabel(1)}부터 {t.totalPeriods}개월.
        조건은 양측 서명으로 확정됐고, 컨트랙트에는 이를 바꾸는 함수가 존재하지 않습니다.
      </p>
      <div className="cards">
        <Card label="기본료" value={`${won(t.baseRent)}원`} />
        <Card label="매출 연동률" value={`${(t.pctBps / 100).toFixed(1)}%`} accent />
        <Card label="하한" value={`${won(t.floorRent)}원`} />
        <Card label="상한" value={`${won(t.capRent)}원`} />
        <Card label="약정 보증금" value={`${won(t.deposit)}원`} />
        <Card label="납입된 보증금" value={`${won(lease.depositPaid)}원`} muted={lease.depositPaid < t.deposit} />
      </div>
      <div className="note">
        분쟁 규칙 — 이의는 게시 후 <b>{DISPUTE_DAYS}일</b> 안에, 해제는 <b>양측 2-of-2 동의</b>로만.
        {lease.mediator && lease.mediator !== ZERO
          ? <> 교착이 <b>{MEDIATION_DAYS}일</b>을 넘으면 양측이 함께 지정한 조정인 <span className="mono">{short(lease.mediator)}</span>이 확정할 수 있습니다.</>
          : <> 이 계약에는 <b>조정인이 없습니다</b> — 합의가 안 되면 온체인에서는 풀리지 않고 계약 밖 절차로 갑니다.</>}
      </div>
      <div className="sigs">
        <SigRow who="landlord" sig={sigs ? sigs.sigL : "on-chain"} />
        <SigRow who="tenant" sig={sigs ? sigs.sigT : "on-chain"} />
      </div>
      <div className="note">
        조건 해시 <b className="mono">{digest}</b><br />
        이 해시에 대한 두 서명이 <code>activate()</code> 에서 검증됐습니다. 사후에 조건이 바뀌었다면 이 해시가 달라집니다.
      </div>
      {!ended && (
        <div className="btns">
          {role === "landlord" || role === "tenant"
            ? <button className="ghost danger" disabled={!!busy} onClick={end}>계약 종료</button>
            : <Need role="landlord" setRole={setRole} what="계약 종료" />}
        </div>
      )}
    </section>
  );
}

export function Card({ label, value, accent, muted, mono }) {
  return (
    <div className={`card ${accent ? "ac" : ""} ${muted ? "mu" : ""}`}>
      <span className="cl2">{label}</span><strong className={mono ? "mono" : ""}>{value}</strong>
    </div>
  );
}
