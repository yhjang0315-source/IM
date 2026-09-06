import { useEffect, useMemo, useState } from "react";
import {
  read, terms, site, FIXED_RENT, won, pct,
  loadMonths, runMonth, postOnly, disputeAs, agreeAs, settleMonth,
} from "./lease";
import "./App.css";

const DEFAULT_REV = [12, 10, 16, 19, 21, 18, 15, 14, 20, 22, 24, 26]; // 백만원

export default function App() {
  const [tab, setTab] = useState("tenant");
  const [months, setMonths] = useState([]);
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const [revInput, setRevInput] = useState(DEFAULT_REV[0]);

  const total = terms.totalPeriods;
  const refresh = () => loadMonths(total).then(setMonths).catch((e) => setErr(String(e.message || e)));
  useEffect(() => { refresh(); }, []);

  const settled = months.filter((m) => m.state === 3);
  const next = months.find((m) => m.state === 0);
  const pending = months.find((m) => m.state === 1 || m.state === 2);

  useEffect(() => {
    if (next) setRevInput(DEFAULT_REV[(next.month - 1) % 12]);
  }, [next?.month]);

  const totals = useMemo(() => {
    const rent = settled.reduce((a, m) => a + m.paid, 0n);
    const rev = settled.reduce((a, m) => a + m.revenue, 0n);
    const fixed = FIXED_RENT * BigInt(settled.length);
    return { rent, rev, fixed, n: settled.length };
  }, [months]);

  async function act(label, fn) {
    setBusy(label); setErr("");
    try { await fn(); await refresh(); }
    catch (e) { setErr(String(e.shortMessage || e.message || e)); }
    finally { setBusy(""); }
  }

  return (
    <div className="app">
      <header className="hd">
        <div className="hd-l">
          <span className="eyebrow">매출연동 임대차 · RevenueLease</span>
          <h1>{site.name}</h1>
          <p className="sub">{site.district} · 소규모 상가 공실률 <b>{site.vacancyPct}%</b></p>
        </div>
        <dl className="tms">
          <div><dt>기본료</dt><dd>{won(terms.baseRent)}</dd></div>
          <div><dt>매출 연동률</dt><dd>{terms.pctBps / 100}%</dd></div>
          <div><dt>하한</dt><dd>{won(terms.floorRent)}</dd></div>
          <div><dt>상한</dt><dd>{won(terms.capRent)}</dd></div>
          <div className="locked"><dt>조건 상태</dt><dd>확정 · 변경 불가</dd></div>
        </dl>
      </header>

      <nav className="tabs">
        {[["tenant", "임차인"], ["landlord", "임대인"], ["gateway", "결제 게이트웨이"]].map(([k, v]) => (
          <button key={k} className={tab === k ? "on" : ""} onClick={() => setTab(k)}>{v}</button>
        ))}
        <span className="prog">{settled.length} / {total}개월 정산 완료</span>
      </nav>

      {err && <div className="err">{err}</div>}

      {tab === "tenant" && <Tenant months={months} totals={totals} />}
      {tab === "landlord" && <Landlord months={months} totals={totals} />}
      {tab === "gateway" && (
        <Gateway
          next={next} pending={pending} revInput={revInput} setRevInput={setRevInput}
          busy={busy} act={act}
        />
      )}

      <Ledger months={months} />
    </div>
  );
}

function Tenant({ months, totals }) {
  const last = [...months].reverse().find((m) => m.state === 3);
  const worstLinked = months.filter(m => m.state === 3)
    .reduce((a, m) => Math.max(a, pct(m.rent, m.revenue)), 0);
  const worstFixed = months.filter(m => m.state === 3)
    .reduce((a, m) => Math.max(a, pct(FIXED_RENT, m.revenue)), 0);

  return (
    <section className="pane">
      <h2>이번 달</h2>
      {last ? (
        <div className="cards">
          <Card label={`${last.month}월 매출`} value={`${won(last.revenue)} 원`} />
          <Card label="산정 임대료" value={`${won(last.rent)} 원`} accent />
          <Card label="매출 대비 부담률" value={`${pct(last.rent, last.revenue).toFixed(1)}%`} />
          <Card label="고정 월세였다면" value={`${pct(FIXED_RENT, last.revenue).toFixed(1)}%`} muted />
        </div>
      ) : <p className="empty">아직 정산된 달이 없습니다. 결제 게이트웨이 탭에서 진행하십시오.</p>}

      {totals.n > 0 && (
        <>
          <h2>부담률 추이</h2>
          <Chart months={months} />
          <div className="note">
            최악의 달 부담률 — 고정 월세 <b className="bad">{worstFixed.toFixed(1)}%</b> vs
            매출연동 <b className="good">{worstLinked.toFixed(1)}%</b>.
            진입 여부를 가르는 숫자입니다.
          </div>
        </>
      )}
    </section>
  );
}

function Landlord({ months, totals }) {
  const vac = 0n;
  const max = Number(totals.fixed) || 1;
  const bars = [
    ["공실 유지 (현재)", vac, "bad"],
    ["매출연동 실수취", totals.rent, "good"],
    ["고정 월세 (임차인이 들어와야 성립)", totals.fixed, "muted"],
  ];
  return (
    <section className="pane">
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
      {totals.n > 0 && (
        <div className="note">
          고정 월세 대비 <b className="good">{pct(totals.rent, totals.fixed).toFixed(1)}%</b>를 수취했습니다.
          호가를 내린 것이 아니라 연동한 것이므로 <b>담보평가 기준 임대료는 유지</b>됩니다.
        </div>
      )}
    </section>
  );
}

function Gateway({ next, pending, revInput, setRevInput, busy, act }) {
  return (
    <section className="pane">
      <h2>매출 게시 · 정산</h2>
      <p className="lead">
        매출은 임차인이 신고하는 것이 아니라 결제 게이트웨이(은행)가 게시합니다.
        컨트랙트는 게이트웨이 주소 외의 게시를 거부합니다.
      </p>

      {pending && (
        <div className="pendbox">
          <b>{pending.month}월</b>이 {pending.state === 2 ? "이의 제기로 정산 대기 중" : "게시됨 · 정산 대기"}입니다
          — 매출 {won(pending.revenue)} / 임대료 {won(pending.rent)}
          <div className="btns">
            {pending.state === 1 && <>
              <button disabled={!!busy} onClick={() => act("settle", () => settleMonth(pending.month))}>정산 실행</button>
              <button className="ghost" disabled={!!busy}
                onClick={() => act("dispute", () => disputeAs("landlord", pending.month, pending.revenue + 5_000_000n))}>
                임대인 이의 제기
              </button>
            </>}
            {pending.state === 2 && <>
              <button className="ghost" disabled={!!busy} onClick={() => act("a1", () => agreeAs("landlord", pending.month))}>임대인 동의</button>
              <button className="ghost" disabled={!!busy} onClick={() => act("a2", () => agreeAs("tenant", pending.month))}>임차인 동의</button>
              <span className="hint">둘 다 동의해야 정산이 풀립니다 (2-of-2)</span>
            </>}
          </div>
        </div>
      )}

      {!pending && next && (
        <div className="runbox">
          <label>{next.month}월 매출</label>
          <input type="range" min="4" max="40" value={revInput}
            onChange={(e) => setRevInput(Number(e.target.value))} />
          <span className="revv">{won(revInput * 1_000_000)} 원</span>
          <QuotePreview revenue={BigInt(revInput) * 1_000_000n} />
          <div className="btns">
            <button disabled={!!busy}
              onClick={() => act("run", () => runMonth(next.month, BigInt(revInput) * 1_000_000n))}>
              {busy === "run" ? "처리 중…" : "예치 → 게시 → 정산"}
            </button>
            <button className="ghost" disabled={!!busy}
              onClick={() => act("post", () => postOnly(next.month, BigInt(revInput) * 1_000_000n))}>
              게시까지만 (분쟁 시연용)
            </button>
          </div>
        </div>
      )}

      {!pending && !next && <p className="empty">12개월 계약이 모두 정산되었습니다.</p>}
    </section>
  );
}

function QuotePreview({ revenue }) {
  const [q, setQ] = useState(null);
  useEffect(() => { read.quote(revenue).then(setQ).catch(() => setQ(null)); }, [revenue.toString()]);
  if (q === null) return null;
  const clamped = q === BigInt(terms.floorRent) || q === BigInt(terms.capRent);
  return (
    <div className="quote">
      산정 임대료 <b>{won(q)} 원</b>
      {clamped && <span className="tagc">{q === BigInt(terms.floorRent) ? "하한 적용" : "상한 적용"}</span>}
      <span className="qsub">부담률 {pct(q, revenue).toFixed(1)}%</span>
    </div>
  );
}

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
          <thead><tr><th>월</th><th className="r">매출</th><th className="r">임대료</th><th className="r">지급</th><th className="r">미납</th><th>상태</th></tr></thead>
          <tbody>
            {months.map((m) => (
              <tr key={m.month} className={m.state === 0 ? "off" : ""}>
                <td>{m.month}</td>
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

function Card({ label, value, accent, muted }) {
  return (
    <div className={`card ${accent ? "ac" : ""} ${muted ? "mu" : ""}`}>
      <span className="cl2">{label}</span><strong>{value}</strong>
    </div>
  );
}
