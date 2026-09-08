import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  read, site, roles, ROLE_LABEL, FIXED_RENT, won, pct, bpsPct, short, monthLabel, quoteLocal,
  loadLease, loadMonths, loadActivity, makeProof, monthDue, siteParts, DISPUTE_DAYS, MEDIATION_DAYS, ZERO,
  chainName, explorer, txLink, address as contractAddress,
  fund, postRevenue, settle, dispute, agree, repay, payDeposit, mediate, runMonth,
} from "./lease";
import Contract, { Card } from "./Contract";
import Activity from "./Activity";
import Statement from "./Statement";
import "./App.css";

const DEFAULT_REV = [12, 10, 16, 19, 21, 18, 15, 14, 20, 22, 24, 26]; // 백만원, 시연 시나리오

/** 컨트랙트가 되돌린 이유를 사람 말로 */
function explain(e) {
  const name = e?.revert?.name || (() => {
    const data = e?.data || e?.info?.error?.data?.data || e?.info?.error?.data;
    try { return typeof data === "string" ? read.interface.parseError(data)?.name : null; } catch { return null; }
  })();
  const map = {
    NotAuthorized: "권한 없음 — 이 역할은 이 작업을 할 수 없습니다.",
    BadState: "지금 상태에서는 할 수 없는 작업입니다.",
    BadTerms: "조건이 올바르지 않습니다.",
    BadPeriod: "기간 번호가 계약 범위를 벗어났습니다.",
    NothingDue: "갚을 미납분이 없습니다.",
    WindowClosed: `이의 제기 기한(${DISPUTE_DAYS}일)이 지났습니다.`,
    Unfinished: "아직 처리 중인 달이 있습니다. 게시·이의 상태인 달을 먼저 정산하십시오.",
    TooEarly: `조정은 이의가 걸린 뒤 ${MEDIATION_DAYS}일이 지나야 가능합니다.`,
  };
  if (name && map[name]) return map[name];
  const m = String(e?.shortMessage || e?.message || e);
  return m.length > 160 ? m.slice(0, 160) + "…" : m;
}

export default function App() {
  const [role, setRoleRaw] = useState(() => { try { return localStorage.getItem("rl:role") || "landlord"; } catch { return "landlord"; } });
  const setRole = (r) => { setRoleRaw(r); try { localStorage.setItem("rl:role", r); } catch {} };

  const [lease, setLease] = useState(null);
  const [months, setMonths] = useState([]);
  const [activity, setActivity] = useState([]);
  const [market, setMarket] = useState(null);
  const [validation, setValidation] = useState(null);
  const [tab, setTab] = useState("contract");
  const [busy, setBusy] = useState("");
  const [chainErr, setChainErr] = useState("");
  const [toasts, setToasts] = useState([]);
  const tabbed = useRef(false);

  const refresh = useCallback(async () => {
    try {
      const l = await loadLease();
      const [m, a] = await Promise.all([
        l.terms ? loadMonths(l.terms.totalPeriods) : Promise.resolve([]),
        loadActivity(),
      ]);
      // 셋을 한 번에 넣는다. 따로 넣으면 계약은 있는데 월별 데이터는 빈
      // 중간 상태가 렌더되어 "정산된 달이 없습니다"가 잠깐 뜬다.
      setLease(l); setMonths(m); setActivity(a); setChainErr("");
    } catch (e) {
      setChainErr(`체인에 연결할 수 없습니다 (${site.name}). npm run chain → npm run deploy 순서로 띄우십시오. ${explain(e)}`);
    }
  }, []);
  useEffect(() => { refresh(); }, [refresh]);

  // 처음 로드 때만: 미체결이면 계약 탭, 체결됐으면 임차인 탭
  useEffect(() => {
    if (!lease || tabbed.current) return;
    tabbed.current = true;
    setTab(lease.state === 0 ? "contract" : "tenant");
  }, [lease]);

  useEffect(() => {
    fetch(`${import.meta.env.BASE_URL}market.json`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setMarket(d && d.sectors && d.sectors.length ? d : null))
      .catch(() => setMarket(null));
    fetch(`${import.meta.env.BASE_URL}model-validation.json`)
      .then((r) => (r.ok ? r.json() : null))
      .then(setValidation)
      .catch(() => setValidation(null));
  }, []);

  const notify = useCallback((t) => {
    const id = `${Date.now()}-${Math.random()}`;
    setToasts((x) => [...x, { id, ...t }]);
    setTimeout(() => setToasts((x) => x.filter((y) => y.id !== id)), 6500);
  }, []);

  /** 트랜잭션 하나를 실행하고 결과를 알린다. fn이 영수증을 돌려주면 블록·해시를 붙인다. */
  async function act(label, fn, title) {
    setBusy(label);
    try {
      const rc = await fn();
      await refresh();
      notify({
        kind: "ok", title: title || label,
        detail: rc && rc.hash ? `블록 #${rc.blockNumber} · tx ${short(rc.hash)}` : "오프체인 — 트랜잭션 없음",
        link: rc && rc.hash ? txLink(rc.hash) : null,
      });
    } catch (e) {
      notify({ kind: "err", title: `${title || label} 실패`, detail: explain(e) });
    } finally { setBusy(""); }
  }

  const terms = lease?.terms || null;
  const settled = months.filter((m) => m.state === 3);
  const next = months.find((m) => m.state === 0);
  const pending = months.find((m) => m.state === 1 || m.state === 2);
  const totals = useMemo(() => {
    const rent = settled.reduce((a, m) => a + m.paid, 0n);
    const rev = settled.reduce((a, m) => a + m.revenue, 0n);
    return { rent, rev, fixed: FIXED_RENT * BigInt(settled.length), n: settled.length };
  }, [months]);

  const sp = siteParts(lease?.site);
  const hasMediator = !!lease?.mediator && lease.mediator !== ZERO;
  useEffect(() => { if (!hasMediator && role === "mediator") setRole("landlord"); }, [hasMediator]);
  const stateLabel = ["미체결 · 조건 작성 중", "체결됨 · 진행 중", "종료"][lease?.state ?? 0];
  const tabs = [
    ["contract", "계약"], ["tenant", "임차인"], ["landlord", "임대인"], ["gateway", "게이트웨이"],
    ["evidence", "업종 근거"], ["statement", "명세서"], ["activity", `활동${activity.length ? ` (${activity.length})` : ""}`],
  ];
  const loading = !lease && !chainErr;
  const gated = (node) => (loading ? <Loading /> : terms ? node : <NotYet onGo={() => setTab("contract")} />);

  return (
    <div className="app">
      <header className="hd">
        <div className="hd-l">
          <span className="eyebrow">매출연동 임대차 · RevenueLease</span>
          <h1>{sp.name}</h1>
          <p className="sub">{sp.rest} · 중대형 상가 공실률 <b>{site.vacancyPct}%</b></p>
          <p className="chainline">
            {chainName === "kairos" ? "Kaia Kairos 테스트넷" : "로컬 체인"} ·{" "}
            {explorer
              ? <a href={`${explorer}/address/${contractAddress}`} target="_blank" rel="noreferrer">{short(contractAddress)} ↗</a>
              : <span className="mono">{short(contractAddress)}</span>}
          </p>
        </div>
        {terms ? (
          <dl className="tms">
            <div><dt>기본료</dt><dd>{won(terms.baseRent)}</dd></div>
            <div><dt>매출 연동률</dt><dd>{bpsPct(terms.pctBps)}%</dd></div>
            <div><dt>하한</dt><dd>{won(terms.floorRent)}</dd></div>
            <div><dt>상한</dt><dd>{won(terms.capRent)}</dd></div>
            <div><dt>기간</dt><dd>{monthLabel(1)} ~ {monthLabel(terms.totalPeriods)}</dd></div>
            <div className="locked"><dt>조건 상태</dt><dd>{lease.state === 2 ? "종료" : "확정 · 변경 불가"}</dd></div>
          </dl>
        ) : (
          <dl className="tms">
            <div className="locked"><dt>조건 상태</dt><dd>미확정 — 계약 탭에서 체결</dd></div>
          </dl>
        )}
      </header>

      <div className="rolebar" role="group" aria-label="역할">
        <span className="rl">지금 나는</span>
        {["landlord", "tenant", "gateway", ...(hasMediator ? ["mediator"] : [])].map((r) => (
          <button key={r} className={role === r ? "on" : ""} onClick={() => setRole(r)}>
            {ROLE_LABEL[r]}<span className="ra">{short(roles[r])}</span>
          </button>
        ))}
        <span className={`rs s${lease?.state ?? 0}`}>{stateLabel}</span>
      </div>

      <nav className="tabs">
        {tabs.map(([k, v]) => (
          <button key={k} className={tab === k ? "on" : ""} onClick={() => setTab(k)}>{v}</button>
        ))}
        {terms && <span className="prog">{settled.length} / {terms.totalPeriods}개월 정산 완료</span>}
      </nav>

      {chainErr && <div className="err">{chainErr}</div>}

      {tab === "contract" && (loading ? <Loading /> : <Contract lease={lease} market={market} role={role} setRole={setRole} act={act} busy={busy} />)}
      {tab === "tenant" && gated(<Tenant months={months} totals={totals} terms={terms} next={next} role={role} setRole={setRole} act={act} busy={busy} lease={lease} />)}
      {tab === "landlord" && gated(<Landlord months={months} totals={totals} lease={lease} />)}
      {tab === "gateway" && gated(<Gateway next={next} pending={pending} role={role} setRole={setRole} act={act} busy={busy} lease={lease} />)}
      {tab === "evidence" && <Evidence market={market} terms={terms} validation={validation} />}
      {tab === "statement" && (loading ? <Loading /> : <Statement lease={lease} months={months} activity={activity} />)}
      {tab === "activity" && <Activity items={activity} />}

      {terms && <Ledger months={months} />}

      <div className="toasts" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>
            <b>{t.title}</b>
            {t.detail && (t.link
              ? <a href={t.link} target="_blank" rel="noreferrer">{t.detail} ↗</a>
              : <span>{t.detail}</span>)}
          </div>
        ))}
      </div>
    </div>
  );
}

/** 원 단위 금액 입력. bigint 로 주고받는다. 계약 금액을 손으로 못 넣으면 데모가 아니라 안내문이 된다. */
function MoneyField({ label, value, onChange, hint, warn, disabled }) {
  return (
    <div className="money">
      <label>{label}</label>
      <input type="number" min="0" step="10000" disabled={disabled}
        value={String(value)}
        onChange={(e) => {
          const n = Math.floor(Number(e.target.value));
          onChange(BigInt(Number.isFinite(n) && n > 0 ? n : 0));
        }} />
      <span className="mv">{won(value)}원</span>
      {hint && <span className={`mh ${warn ? "bad" : ""}`}>{hint}</span>}
    </div>
  );
}

/** 미납 한 건. 행마다 상환 금액을 따로 잡아야 해서 별도 컴포넌트로 뺀다. */
function ArrearsRow({ m, role, setRole, busy, act }) {
  const [amt, setAmt] = useState(m.arrears);
  useEffect(() => { setAmt(m.arrears); }, [m.arrears]);
  const over = amt > m.arrears;
  return (
    <tr>
      <td>{monthLabel(m.month)}</td>
      <td className="r">{won(m.rent)}</td>
      <td className="r">{won(m.paid)}</td>
      <td className="r"><b className="bad">{won(m.arrears)}</b></td>
      <td>
        {role === "tenant" ? (
          <div className="rowact">
            <MoneyField label="상환액" value={amt} onChange={setAmt}
              hint={over ? "초과분은 즉시 돌아옵니다" : amt < m.arrears ? "부분 상환" : null} />
            <button className="ghost sm" disabled={!!busy || amt === 0n}
              onClick={() => act("repay", () => repay(m.month, amt), `${monthLabel(m.month)} 미납 ${won(amt)}원 상환`)}>
              상환
            </button>
          </div>
        ) : <Need role="tenant" setRole={setRole} what="상환" />}
      </td>
    </tr>
  );
}

function Loading() {
  return <section className="pane"><p className="empty">체인에서 계약을 불러오는 중…</p></section>;
}

function NotYet({ onGo }) {
  return (
    <section className="pane notyet">
      <h2>아직 체결된 계약이 없습니다</h2>
      <p className="lead">임대인이 조건을 쓰고 양측이 서명하면 이 화면이 열립니다.</p>
      <div className="btns"><button onClick={onGo}>계약 탭으로</button></div>
    </section>
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

// ------------------------------------------------------------------ 임차인
function Tenant({ months, totals, terms, next, role, setRole, act, busy, lease }) {
  const last = [...months].reverse().find((m) => m.state === 3);
  const done = months.filter((m) => m.state === 3);
  const worstLinked = done.reduce((a, m) => Math.max(a, pct(m.rent, m.revenue)), 0);
  const worstFixed = done.reduce((a, m) => Math.max(a, pct(FIXED_RENT, m.revenue)), 0);
  const [simRev, setSimRev] = useState(BigInt(next ? DEFAULT_REV[(next.month - 1) % 12] : 15) * 1_000_000n);
  const simRent = quoteLocal(terms, simRev);
  const [fundAmt, setFundAmt] = useState(simRent);
  const [depAmt, setDepAmt] = useState(0n);
  useEffect(() => {
    if (next) setSimRev(BigInt(DEFAULT_REV[(next.month - 1) % 12]) * 1_000_000n);
  }, [next?.month]);
  // 매출을 바꾸면 예치 기본값도 따라간다. 사용자가 직접 고친 뒤에는 건드리지 않는다.
  const touched = useRef(false);
  useEffect(() => { if (!touched.current) setFundAmt(quoteLocal(terms, simRev)); }, [simRev]);
  useEffect(() => { setDepAmt(terms.deposit - lease.depositPaid); }, [lease.depositPaid, terms.deposit]);
  const clamped = simRent === BigInt(terms.floorRent) ? "하한 적용" : simRent === BigInt(terms.capRent) ? "상한 적용" : null;
  const active = lease.state === 1;
  const arrearsRows = months.filter((m) => m.state === 3 && m.arrears > 0n);

  return (
    <section className="pane">
      <h2>{last ? `${monthLabel(last.month)} 정산` : "이번 달"}</h2>
      {last ? (
        <div className="cards">
          <Card label="매출" value={`${won(last.revenue)}원`} />
          <Card label="산정 임대료" value={`${won(last.rent)}원`} accent />
          <Card label="매출 대비 부담률" value={`${pct(last.rent, last.revenue).toFixed(1)}%`} />
          <Card label="고정 월세였다면" value={`${pct(FIXED_RENT, last.revenue).toFixed(1)}%`} muted />
        </div>
      ) : <p className="empty">아직 정산된 달이 없습니다.</p>}

      {next && active && (
        <>
          <h2>{monthLabel(next.month)} — 매출이 이 정도면</h2>
          <div className="runbox">
            <label>예상 매출</label>
            <input type="range" min="4" max="40" value={Number(simRev / 1_000_000n)}
              onChange={(e) => setSimRev(BigInt(e.target.value) * 1_000_000n)} />
            <MoneyField label="정확한 금액" value={simRev} onChange={setSimRev} />
            <div className="quote">
              임대료 <b>{won(simRent)}원</b>
              {clamped && <span className="tagc">{clamped}</span>}
              <span className="qsub">부담률 {pct(simRent, simRev).toFixed(1)}% · 고정 월세였다면 {pct(FIXED_RENT, simRev).toFixed(1)}%</span>
            </div>
            <div className="escrow">이미 예치한 금액 <b>{won(next.escrow)}원</b></div>
            {role === "tenant" && (
              <MoneyField label="이번에 예치할 금액" value={fundAmt}
                onChange={(v) => { touched.current = true; setFundAmt(v); }}
                warn={next.escrow + fundAmt < simRent}
                hint={next.escrow + fundAmt < simRent
                  ? `이 매출이면 ${won(simRent - next.escrow - fundAmt)}원이 미납으로 기록됩니다`
                  : `정산 후 ${won(next.escrow + fundAmt - simRent)}원이 돌아옵니다`} />
            )}
            <div className="btns">
              {role === "tenant"
                ? <>
                    <button disabled={!!busy || fundAmt === 0n}
                      onClick={() => act("fund", () => fund(next.month, fundAmt), `${monthLabel(next.month)} 예치 ${won(fundAmt)}원`)}>
                      {busy === "fund" ? "전송 중…" : `${won(fundAmt)}원 예치`}
                    </button>
                    <button className="ghost" disabled={!!busy}
                      onClick={() => { touched.current = false; setFundAmt(simRent > next.escrow ? simRent - next.escrow : 0n); }}>
                      부족분 채우기
                    </button>
                  </>
                : <Need role="tenant" setRole={setRole} what="예치" />}
              <span className="hint">예치금은 정산 때 임대료만큼 임대인에게 가고 나머지는 돌아옵니다.</span>
            </div>
          </div>
        </>
      )}

      {active && lease.depositPaid < terms.deposit && (
        <>
          <h2>보증금</h2>
          <div className="runbox">
            <div className="escrow">
              약정 <b>{won(terms.deposit)}원</b> · 납입 <b>{won(lease.depositPaid)}원</b> · 미납입 <b className="bad">{won(terms.deposit - lease.depositPaid)}원</b>
            </div>
            <p className="hint">
              계약이 끝날 때 남은 미납 임대료를 보증금에서 먼저 회수하고, 나머지를 돌려줍니다.
            </p>
            {role === "tenant" && (
              <MoneyField label="납입할 금액" value={depAmt} onChange={setDepAmt}
                hint={depAmt < terms.deposit - lease.depositPaid ? "나눠서 낼 수 있습니다" : null} />
            )}
            <div className="btns">
              {role === "tenant"
                ? <button disabled={!!busy || depAmt === 0n}
                    onClick={() => act("deposit", () => payDeposit(depAmt), `보증금 ${won(depAmt)}원 납입`)}>
                    {busy === "deposit" ? "전송 중…" : `${won(depAmt)}원 납입`}
                  </button>
                : <Need role="tenant" setRole={setRole} what="보증금 납입" />}
            </div>
          </div>
        </>
      )}

      {arrearsRows.length > 0 && (
        <>
          <h2>미납 상환</h2>
          <p className="lead">
            예치가 모자랐던 달의 차액입니다. 계약이 끝난 뒤에도 남으며, 부분 상환이 됩니다.
          </p>
          <div className="tw">
            <table>
              <thead><tr><th>기간</th><th className="r">임대료</th><th className="r">지급</th><th className="r">남은 미납</th><th>상환</th></tr></thead>
              <tbody>
                {arrearsRows.map((m) => (
                  <ArrearsRow key={m.month} m={m} role={role} setRole={setRole} busy={busy} act={act} />
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {totals.n > 0 && (
        <>
          <h2>부담률 추이</h2>
          <Chart months={months} />
          <div className="note">
            최악의 달 부담률 — 고정 월세 <b className="bad">{worstFixed.toFixed(1)}%</b> vs
            매출연동 <b className="good">{worstLinked.toFixed(1)}%</b>. 진입 여부를 가르는 숫자입니다.
          </div>
        </>
      )}
    </section>
  );
}

// ------------------------------------------------------------------ 임대인
function Landlord({ months, totals, lease }) {
  const t = lease.terms;
  const max = Number(totals.fixed) || 1;
  const arrearsTotal = months.reduce((a, m) => a + (m.state === 3 ? m.arrears : 0n), 0n);
  const depositShort = t.deposit > lease.depositPaid;
  const bars = [
    ["공실 유지 (현재)", 0n, "bad"],
    ["매출연동 실수취", totals.rent, "good"],
    ["고정 월세 (임차인이 들어와야 성립)", totals.fixed, "muted"],
  ];
  return (
    <section className="pane">
      <h2>담보와 채권</h2>
      <p className="lead">
        보증금은 계약이 끝날 때 남은 미납분을 먼저 회수하고 나머지를 돌려줍니다.
        미납이 보증금을 넘으면 그만큼은 채무로 남습니다.
      </p>
      <div className="cards">
        <Card label="약정 보증금" value={`${won(t.deposit)}원`} />
        <Card label="납입된 보증금" value={`${won(lease.depositPaid)}원`} muted={depositShort} />
        <Card label="미납 누계" value={`${won(arrearsTotal)}원`} accent={arrearsTotal > 0n} />
        <Card label="보증금 대비 미납" value={t.deposit > 0n ? `${pct(arrearsTotal, t.deposit).toFixed(1)}%` : "—"} />
      </div>
      {depositShort && (
        <div className="warn-note">
          보증금이 <b>{won(t.deposit - lease.depositPaid)}원</b> 덜 납입됐습니다.
          그만큼 미납 회수 여력이 줄어듭니다.
        </div>
      )}

      <h2>{totals.n}개월 누적 수취액</h2>
      <div className="bars">
        {bars.map(([label, v, cls]) => (
          <div className="barrow" key={label}>
            <span className="bl">{label}</span>
            <span className="bt"><i className={cls} style={{ width: `${(Number(v) / max) * 100}%` }} /></span>
            <span className="bv">{won(v)} 원</span>
          </div>
        ))}
      </div>
      {totals.n > 0 ? (
        <div className="note">
          고정 월세 대비 <b className="good">{pct(totals.rent, totals.fixed).toFixed(1)}%</b>를 수취했습니다.
          {arrearsTotal > 0n && <> 미납 누계 <b className="bad">{won(arrearsTotal)}원</b>이 온체인에 기록돼 있습니다.</>}
          {" "}호가를 내린 것이 아니라 연동한 것이므로 <b>담보평가 기준 임대료는 유지</b>됩니다.
        </div>
      ) : <p className="empty">첫 정산이 끝나면 누적 수취액이 채워집니다.</p>}
    </section>
  );
}

// ------------------------------------------------------------------ 게이트웨이
function Gateway({ next, pending, role, setRole, act, busy, lease }) {
  const [revenue, setRevenue] = useState(BigInt(next ? DEFAULT_REV[(next.month - 1) % 12] : 15) * 1_000_000n);
  useEffect(() => { if (next) setRevenue(BigInt(DEFAULT_REV[(next.month - 1) % 12]) * 1_000_000n); }, [next?.month]);
  // 이의·조정 금액은 당사자가 직접 넣는 값이다. 코드에 박아두면 시연에서
  // "그 숫자는 어디서 나왔나요"에 답할 수 없다.
  const [proposal, setProposal] = useState(0n);
  const [mediation, setMediation] = useState(0n);
  useEffect(() => { if (pending) { setProposal(pending.revenue); setMediation(pending.proposed || pending.revenue); } },
    [pending?.month, pending?.state, pending?.revenue?.toString(), pending?.proposed?.toString()]);
  const active = lease.state === 1;
  const L = pending ? monthLabel(pending.month) : "";
  const proof = next ? makeProof(next.month, revenue) : null;
  const now = lease.chainNow || Date.now();
  const mediationOpen = !!pending && pending.state === 2 && pending.disputedAt > 0
    && now >= pending.disputedAt + MEDIATION_DAYS * 86400000;
  // 게시 예정일: 해당 월이 끝난 다음 달 5일. 결제망 집계가 마감되는 시점을 가정한 값이다.
  const dueInfo = (() => {
    if (!next) return null;
    const due = monthDue(next.month);
    const days = Math.ceil((due - now) / 86400000);
    return days >= 0 ? { text: `게시 기한 ${due.toLocaleDateString("ko-KR")} (D-${days})`, late: false }
                     : { text: `게시 기한 ${due.toLocaleDateString("ko-KR")} — ${-days}일 지연`, late: true };
  })();

  return (
    <section className="pane">
      <h2>매출 게시 · 정산</h2>
      <p className="lead">
        매출은 임차인이 신고하는 것이 아니라 결제 게이트웨이(은행)가 게시합니다.
        컨트랙트는 게이트웨이 주소 외의 게시를 거부합니다.
      </p>

      {!active && <p className="empty">계약이 종료되어 더 이상 게시·정산할 수 없습니다.</p>}

      {active && pending && (
        <div className="pendbox">
          <b>{L}</b> — {pending.state === 2 ? "이의 제기로 정산 정지" : "매출 게시됨 · 정산 대기"}
          <div>매출 {won(pending.revenue)}원 · 임대료 {won(pending.rent)}원 · 예치 {won(pending.escrow)}원
            {pending.escrow < pending.rent && <b className="bad"> · 부족 {won(pending.rent - pending.escrow)}원 → 미납으로 기록됨</b>}
          </div>
          <div className="escrow">
            증빙 해시 <b>{short(pending.proof)}</b>
            {pending.postedAt > 0 && <> · 이의 제기 기한 {new Date(pending.postedAt + DISPUTE_DAYS * 86400000).toLocaleDateString("ko-KR")}까지</>}
          </div>
          {pending.state === 2 && (
            <div className="escrow">제안 매출 {won(pending.proposed)}원 · 임대인 {pending.landlordAgreed ? "동의" : "대기"} · 임차인 {pending.tenantAgreed ? "동의" : "대기"}</div>
          )}
          <div className="btns">
            {pending.state === 1 && <>
              {role === "gateway"
                ? <button disabled={!!busy} onClick={() => act("settle", () => settle("gateway", pending.month), `${L} 정산`)}>정산 실행</button>
                : null}
              {(role === "landlord" || role === "tenant") && (
                <div className="rowact wide">
                  <MoneyField label="내가 보는 매출" value={proposal} onChange={setProposal}
                    hint={proposal === pending.revenue ? "게시된 값과 같습니다" :
                      proposal > pending.revenue ? `게시액보다 ${won(proposal - pending.revenue)}원 많음` :
                      `게시액보다 ${won(pending.revenue - proposal)}원 적음`} />
                  <button className="ghost" disabled={!!busy || proposal === pending.revenue}
                    onClick={() => act("dispute", () => dispute(role, pending.month, proposal), `${L} 이의 제기 (${ROLE_LABEL[role]})`)}>
                    이의 제기
                  </button>
                </div>
              )}
              {role !== "gateway" && <span className="hint">정산 실행은 게이트웨이가 합니다.</span>}
            </>}
            {pending.state === 2 && <>
              {role === "landlord" && <button disabled={!!busy || pending.landlordAgreed} onClick={() => act("agree", () => agree("landlord", pending.month), `${L} 임대인 동의`)}>임대인 동의</button>}
              {role === "tenant" && <button disabled={!!busy || pending.tenantAgreed} onClick={() => act("agree", () => agree("tenant", pending.month), `${L} 임차인 동의`)}>임차인 동의</button>}
              {role === "mediator" && (
                mediationOpen
                  ? <div className="rowact wide">
                      <MoneyField label="조정으로 확정할 매출" value={mediation} onChange={setMediation}
                        hint={`게시 ${won(pending.revenue)}원 · 제안 ${won(pending.proposed)}원 사이에서 정합니다`} />
                      <button disabled={!!busy || mediation === 0n}
                        onClick={() => act("mediate", () => mediate(pending.month, mediation), `${L} 조정 확정 ${won(mediation)}원`)}>
                        조정 확정
                      </button>
                    </div>
                  : <span className="hint">교착 {MEDIATION_DAYS}일이 지나야 개입할 수 있습니다 — {new Date(pending.disputedAt + MEDIATION_DAYS * 86400000).toLocaleDateString("ko-KR")}부터</span>
              )}
              <span className="hint">둘 다 동의해야 정산이 풀립니다 (2-of-2). 게이트웨이는 개입할 수 없습니다.</span>
            </>}
          </div>
        </div>
      )}

      {active && !pending && next && (
        <div className="runbox">
          <label>
            {monthLabel(next.month)} 확정 매출 (결제망 집계)
            {dueInfo && <span className={`due ${dueInfo.late ? "late" : ""}`}>{dueInfo.text}</span>}
          </label>
          <input type="range" min="4" max="40" value={Number(revenue / 1_000_000n)}
            onChange={(e) => setRevenue(BigInt(e.target.value) * 1_000_000n)} />
          <MoneyField label="정확한 금액 (결제망 집계값)" value={revenue} onChange={setRevenue} />
          <QuotePreview revenue={revenue} terms={lease.terms} />
          <div className="escrow">임차인 예치금 <b>{won(next.escrow)}원</b></div>
          <div className="proofbox">
            <span className="pl">정산 원본</span>
            <code>{proof.doc}</code>
            <span className="pl">체인에 올릴 해시</span>
            <code className="ph">{proof.hash}</code>
            <span className="pnote">
              건별 결제 내역이 든 원본은 은행이 보관하고, 체인에는 이 해시만 남깁니다.
              나중에 원본을 다시 해시해 보면 위변조 여부가 드러납니다.
            </span>
          </div>
          <div className="btns">
            {role === "gateway" ? (
              <>
                <button disabled={!!busy} onClick={() => act("post", () => postRevenue(next.month, revenue, proof.hash), `${monthLabel(next.month)} 매출 게시`)}>
                  {busy === "post" ? "전송 중…" : "매출 게시"}
                </button>
                <button className="ghost" disabled={!!busy} onClick={() => act("run", () => runMonth(next.month, revenue), `${monthLabel(next.month)} 예치→게시→정산`)}>
                  {busy === "run" ? "처리 중…" : "시연: 예치 → 게시 → 정산 한 번에"}
                </button>
                <span className="hint">한 번에 실행은 세 역할의 키를 모두 씁니다 — 시연 전용.</span>
              </>
            ) : <Need role="gateway" setRole={setRole} what="매출 게시" />}
          </div>
        </div>
      )}

      {active && !pending && !next && <p className="empty">계약 기간의 모든 달이 정산되었습니다.</p>}
    </section>
  );
}

function QuotePreview({ revenue, terms }) {
  const q = quoteLocal(terms, revenue);
  const clamped = q === BigInt(terms.floorRent) ? "하한 적용" : q === BigInt(terms.capRent) ? "상한 적용" : null;
  return (
    <div className="quote">
      산정 임대료 <b>{won(q)}원</b>
      {clamped && <span className="tagc">{clamped}</span>}
      <span className="qsub">부담률 {pct(q, revenue).toFixed(1)}%</span>
    </div>
  );
}

// ------------------------------------------------------------------ 업종 근거
function Evidence({ market, terms, validation }) {
  const [sel, setSel] = useState("");
  if (!market) {
    return (
      <section className="pane">
        <h2>업종 근거</h2>
        <p className="empty">분석 결과가 없습니다. 상가(상권)정보 zip을 <code>data/raw/</code> 에 넣고 <code>npm run market</code> 을 실행하십시오.</p>
      </section>
    );
  }
  const byCount = [...market.sectors].sort((a, b) => b.countFirst - a.countFirst);
  const cur = market.sectors.find((s) => s.sector === sel) || byCount.find((s) => s.sector.includes("카페")) || byCount[0];
  const baseShareNow = terms ? Number(terms.baseRent) / Number(FIXED_RENT) : null;
  const gap = baseShareNow === null ? 0 : cur.recommended.baseShare - baseShareNow;
  const breakEvenRev = terms ? (Number(FIXED_RENT) - Number(terms.baseRent)) / (terms.pctBps / 10000) : null;
  const GU = ["중구", "동구", "서구", "남구", "북구", "수성구", "달서구", "달성군", "군위군"];
  const gu = GU.find((g) => site.district.includes(g));
  const allRows = market.districts.filter((d) => cur.sector.endsWith(d.sector));
  const mine = gu ? allRows.filter((d) => d.district.startsWith(gu)) : [];
  const localRows = [...mine, ...allRows.filter((d) => !mine.includes(d))].slice(0, 8);

  return (
    <section className="pane">
      <h2>업종 근거</h2>
      <p className="lead">
        연동률은 협상으로 정한 값이 아니라 <b>그 업종이 실제로 얼마나 사라지는가</b>에서 나옵니다.
        아래는 {market.region} {market.snapshots[0]}~{market.snapshots[market.snapshots.length - 1]} ({market.periodMonths}개월) 상가 데이터를 비교한 결과입니다.
      </p>
      <div className="selrow">
        <label htmlFor="sector">업종</label>
        <select id="sector" value={cur.sector} onChange={(e) => setSel(e.target.value)}>
          {byCount.slice(0, 60).map((s) => <option key={s.sector} value={s.sector}>{s.sector} (n={s.countFirst.toLocaleString()})</option>)}
        </select>
      </div>
      <div className="cards">
        <Card label="표본 점포" value={`${cur.countFirst.toLocaleString()}개`} />
        <Card label={`${market.periodMonths}개월 소멸률`} value={`${(cur.disappearRate * 100).toFixed(1)}%`} />
        <Card label="연 환산 잔존율" value={`${(cur.annualSurvival * 100).toFixed(1)}%`} />
        <Card label="권장 매출 연동분" value={`${(cur.recommended.linkedShare * 100).toFixed(0)}%`} accent />
      </div>

      {terms ? (
        <>
          <h2>이 계약 조건과 대조</h2>
          <div className="bars">
            {[["권장 기본료 비중", cur.recommended.baseShare, "good"], ["이 계약의 기본료 비중", baseShareNow, "muted"]].map(([label, v, cls]) => (
              <div className="barrow" key={label}>
                <span className="bl">{label}</span>
                <span className="bt"><i className={cls} style={{ width: `${v * 100}%` }} /></span>
                <span className="bv">{(v * 100).toFixed(0)}%</span>
              </div>
            ))}
          </div>
          <div className="note">
            이 계약은 기본료 {won(terms.baseRent)}원 / 시세 {won(FIXED_RENT)}원, 즉 기본료 비중 <b>{(baseShareNow * 100).toFixed(0)}%</b>입니다.
            이 업종 권장치는 <b className="good">{(cur.recommended.baseShare * 100).toFixed(0)}%</b>이므로{" "}
            {Math.abs(gap) < 0.05 ? <>권장 범위 안입니다.</>
              : gap > 0 ? <>권장보다 <b className="bad">{(Math.abs(gap) * 100).toFixed(0)}%p 낮습니다</b> — 임대인 고정수입이 과소합니다.</>
              : <>권장보다 <b className="bad">{(Math.abs(gap) * 100).toFixed(0)}%p 높습니다</b> — 임차인 하방 위험이 큽니다.</>}
            {terms.pctBps > 0 && <> 연동률 {bpsPct(terms.pctBps)}%는 월매출 <b>{won(Math.round(breakEvenRev))}원</b>에서 연동 임대료가 시세와 같아지도록 잡은 값입니다.</>}
          </div>
        </>
      ) : (
        <div className="note">계약 탭에서 이 업종을 고르면 위 권장치가 조건의 기본값으로 들어갑니다.</div>
      )}

      {localRows.length > 0 && (
        <>
          <h2>같은 업종, 상권별 편차</h2>
          <p className="lead">
            같은 업종이라도 상권에 따라 갈립니다. 다만 <b>표본 {market.reliableDistrictSample}개 미만인 조합은 근거로 쓰지 않습니다</b> —
            시점을 나눠 검증했을 때 다음 분기에 재현되지 않았습니다.
          </p>
          <div className="tw">
            <table>
              <thead><tr><th>상권</th><th className="r">표본</th><th className="r">소멸률</th><th className="r">업종 평균 대비</th></tr></thead>
              <tbody>
                {localRows.map((d) => {
                  const diff = (d.disappearRate - cur.disappearRate) * 100;
                  return (
                    <tr key={d.district + d.sector} className={`${gu && d.district.startsWith(gu) ? "hi" : ""} ${d.reliable ? "" : "weak"}`}>
                      <td>{d.district}</td>
                      <td className="r">{d.countFirst.toLocaleString()}</td>
                      <td className="r">{(d.disappearRate * 100).toFixed(1)}%</td>
                      <td className={`r ${d.reliable ? (diff > 0 ? "bad" : "good") : ""}`}>
                        {d.reliable ? `${diff > 0 ? "+" : ""}${diff.toFixed(1)}%p` : "표본 부족"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}

      {validation && <Validation v={validation} />}

      <p className="caveat">
        <b>한계</b> — {market.caveat} 눈금은 {market.scale.basis}. 표본 {market.minCount}개 미만 조합은 제외했습니다.
      </p>
    </section>
  );
}

/**
 * "이 숫자를 믿어도 되나"에 대한 답.
 * 개별 점포 폐업을 예측할 수 있는지 먼저 확인했고, 안 된다는 결론이 나왔다.
 * 그 확인 과정을 숨기지 않고 보여주는 편이 낫다 — 안 되는 것을 아는 것도 근거다.
 */
function Validation({ v }) {
  const [open, setOpen] = useState(false);
  const best = v.models.reduce((a, b) => (b.rocAuc > a.rocAuc ? b : a));
  return (
    <>
      <h2>이 숫자를 믿어도 되나</h2>
      <p className="lead">
        {v.train.from}~{v.train.to} 구간으로 학습해 {v.test.from}~{v.test.to} 구간을 맞히는지 확인했습니다.
        같은 구간을 무작위로 쪼개면 미래를 맞히는 능력이 아니라 과거를 외우는 능력을 재게 됩니다.
      </p>
      <div className="cards">
        <Card label="검증 표본" value={`${v.test.rows.toLocaleString()}개 점포`} />
        <Card label="개별 점포 예측" value={`AUC ${best.rocAuc.toFixed(2)}`} muted />
        <Card label="업종 단위 재현성" value={`상관 ${Math.max(...v.stability.sector.map((s) => s.corr)).toFixed(2)}`} accent />
        <Card label="상권 신뢰 최소 표본" value={`${v.reliableDistrictSample}개`} />
      </div>
      <div className="note">
        <b>개별 점포의 폐업은 공개 데이터로 예측되지 않습니다.</b> 머신러닝을 붙여도 업종 평균과 차이가 없었습니다
        (AUC {v.models.map((m) => m.rocAuc.toFixed(2)).join(" / ")}). 상가정보에는 매출·임대료·개업일이 없어
        폐업을 가르는 변수 자체가 데이터에 없기 때문입니다.
        그래서 이 서비스는 <b>예측이 아니라 업종 단위 집계</b>를 씁니다. 그쪽은 다음 분기에도 재현됩니다.
      </div>
      <button className="link" onClick={() => setOpen(!open)}>{open ? "자세히 접기" : "검증 수치 자세히 보기"}</button>
      {open && (
        <div className="tw">
          <table>
            <thead><tr><th>확인한 것</th><th className="r">판별력 (AUC)</th><th>해석</th></tr></thead>
            <tbody>
              {v.models.map((m) => (
                <tr key={m.model}><td>{m.model}</td><td className="r">{m.rocAuc.toFixed(3)}</td>
                  <td>{m.rocAuc < 0.65 ? "약함" : "쓸 만함"}</td></tr>
              ))}
              {v.features.map((f) => (
                <tr key={f.feature} className={f.rocAuc < 0.55 ? "weak" : ""}>
                  <td>{f.feature}</td><td className="r">{f.rocAuc.toFixed(3)}</td>
                  <td>{f.rocAuc < 0.55 ? "무신호" : "신호 있음"}{f.missingPct > 10 ? ` · 결측 ${f.missingPct.toFixed(0)}%` : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

// ------------------------------------------------------------------ 차트 · 원장
function Chart({ months }) {
  const done = months.filter((m) => m.state === 3);
  if (!done.length) return null;
  const W = 640, H = 160, PAD = 28;
  const xs = (i) => PAD + (i * (W - PAD * 2)) / Math.max(done.length - 1, 1);
  const maxP = Math.max(...done.map((m) => Math.max(pct(m.rent, m.revenue), pct(FIXED_RENT, m.revenue)))) * 1.15;
  const ys = (p) => H - PAD - (p / maxP) * (H - PAD * 2);
  const line = (fn) => done.map((m, i) => `${i ? "L" : "M"}${xs(i)},${ys(fn(m))}`).join(" ");
  return (
    <div className="chartwrap">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="월별 임대료 부담률 비교">
        <line x1={PAD} y1={H - PAD} x2={W - PAD} y2={H - PAD} stroke="var(--line)" />
        <path d={line((m) => pct(FIXED_RENT, m.revenue))} fill="none" stroke="var(--muted)" strokeWidth="2" strokeDasharray="4 3" />
        <path d={line((m) => pct(m.rent, m.revenue))} fill="none" stroke="var(--accent)" strokeWidth="2.5" />
        {done.map((m, i) => <circle key={m.month} cx={xs(i)} cy={ys(pct(m.rent, m.revenue))} r="3" fill="var(--accent)" />)}
        <text x={PAD} y={16} className="cl" fill="var(--accent)">매출연동</text>
        <text x={PAD + 72} y={16} className="cl" fill="var(--muted)">고정 월세</text>
        <text x={W - PAD} y={ys(maxP / 1.15) + 4} textAnchor="end" className="cl" fill="var(--ink3)">{(maxP / 1.15).toFixed(0)}%</text>
      </svg>
    </div>
  );
}

function Ledger({ months }) {
  const S = ["대기", "게시됨", "이의", "정산완료"];
  return (
    <section className="pane">
      <h2>온체인 원장</h2>
      <div className="tw">
        <table>
          <thead><tr><th>월</th><th className="r">예치</th><th className="r">매출</th><th className="r">임대료</th><th className="r">지급</th><th className="r">미납</th><th>상태</th></tr></thead>
          <tbody>
            {months.map((m) => (
              <tr key={m.month} className={m.state === 0 ? "off" : ""}>
                <td>{monthLabel(m.month)}</td>
                <td className="r">{m.escrow > 0n ? won(m.escrow) : m.state === 3 ? "—" : "0"}</td>
                <td className="r">{m.state ? won(m.revenue) : "—"}</td>
                <td className="r">{m.state ? won(m.rent) : "—"}</td>
                <td className="r">{m.state === 3 ? won(m.paid) : "—"}</td>
                <td className="r">{m.state === 3 && m.arrears > 0n ? <b className="bad">{won(m.arrears)}</b> : m.state === 3 ? "0" : "—"}</td>
                <td><span className={`st s${m.state}`}>{S[m.state]}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
