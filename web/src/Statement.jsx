import { useMemo, useState } from "react";
import {
  site, roles, ROLE_LABEL, FIXED_RENT, address, won, pct, short, monthLabel,
  termsDigest, loadDraft, DISPUTE_DAYS, MEDIATION_DAYS, ZERO,
} from "./lease";

const fmt = (t) => (t ? new Date(t).toLocaleString("ko-KR", { year: "numeric", month: "long", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "—");

/**
 * 사람이 읽는 계약 요약 + 월별 정산 명세.
 * 인쇄하면 그대로 PDF로 남는다(브라우저 인쇄 → PDF로 저장).
 */
export default function Statement({ lease, months, activity }) {
  const [only, setOnly] = useState("");   // 특정 월만 보기
  const t = lease?.terms;
  if (!t) {
    return (
      <section className="pane">
        <h2>명세서</h2>
        <p className="empty">계약이 확정되면 계약 요약과 월별 정산 명세가 여기에 만들어집니다.</p>
      </section>
    );
  }

  const draft = loadDraft();
  const digest = termsDigest(t);
  const signedAt = useMemo(() => {
    const a = activity.find((x) => x.name === "Activated");
    return a ? a.time : null;
  }, [activity]);
  const settled = months.filter((m) => m.state === 3);
  const rows = only ? months.filter((m) => String(m.month) === only) : months.filter((m) => m.state !== 0);
  const sum = settled.reduce((a, m) => ({
    rev: a.rev + m.revenue, rent: a.rent + m.rent, paid: a.paid + m.paid, arrears: a.arrears + m.arrears,
  }), { rev: 0n, rent: 0n, paid: 0n, arrears: 0n });
  const fixedTotal = FIXED_RENT * BigInt(settled.length);

  return (
    <section className="pane doc">
      <div className="docbar noprint">
        <div className="selrow" style={{ margin: 0, flex: 1 }}>
          <label htmlFor="onlym">기간</label>
          <select id="onlym" value={only} onChange={(e) => setOnly(e.target.value)}>
            <option value="">전체 — 계약 요약 + 월별 명세</option>
            {months.filter((m) => m.state !== 0).map((m) => (
              <option key={m.month} value={String(m.month)}>{monthLabel(m.month)} 명세서</option>
            ))}
          </select>
        </div>
        <button className="ghost" onClick={() => window.print()}>인쇄 · PDF로 저장</button>
      </div>

      <header className="dochd">
        <div>
          <h2>매출연동 임대차 계약 명세서</h2>
          <p className="lead">{site.name} · {site.district}</p>
        </div>
        <dl className="docmeta">
          <div><dt>계약 식별자</dt><dd className="mono">{address}</dd></div>
          <div><dt>발행 시각</dt><dd>{fmt(Date.now())}</dd></div>
        </dl>
      </header>

      <h3>1. 당사자</h3>
      <div className="tw">
        <table>
          <thead><tr><th>구분</th><th>역할</th><th>주소</th></tr></thead>
          <tbody>
            <tr><td>임대인</td><td>조건 서명 · 임대료 수취</td><td className="mono">{roles.landlord}</td></tr>
            <tr><td>임차인</td><td>조건 서명 · 예치 · 미납 상환</td><td className="mono">{roles.tenant}</td></tr>
            <tr><td>{ROLE_LABEL.gateway}</td><td>확정 매출 게시 · 정산 실행. 조건 변경·분쟁 개입 불가</td><td className="mono">{roles.gateway}</td></tr>
          </tbody>
        </table>
      </div>

      <h3>2. 확정 조건</h3>
      <div className="tw">
        <table>
          <tbody>
            <tr><td>기본료</td><td className="r">{won(t.baseRent)}원 / 월</td></tr>
            <tr><td>매출 연동률</td><td className="r">{(t.pctBps / 100).toFixed(2)}%</td></tr>
            <tr><td>임대료 하한</td><td className="r">{won(t.floorRent)}원</td></tr>
            <tr><td>임대료 상한</td><td className="r">{won(t.capRent)}원</td></tr>
            <tr><td>계약 기간</td><td className="r">{monthLabel(1)} ~ {monthLabel(t.totalPeriods)} ({t.totalPeriods}개월)</td></tr>
            <tr><td>약정 보증금</td><td className="r">{won(t.deposit)}원</td></tr>
            <tr><td>납입된 보증금</td><td className="r">{won(lease.depositPaid)}원</td></tr>
            <tr><td>조정인</td><td className="r">{lease.mediator && lease.mediator !== ZERO ? <span className="mono">{lease.mediator}</span> : "지정 없음"}</td></tr>
            <tr><td>비교 기준 고정 월세</td><td className="r">{won(FIXED_RENT)}원 / 월</td></tr>
            <tr><td>확정 시각</td><td className="r">{fmt(signedAt)}</td></tr>
          </tbody>
        </table>
      </div>

      <h3>3. 임대료 산정식</h3>
      <p className="formula">
        임대료 = min( max( {won(t.baseRent)} + 월매출 × {(t.pctBps / 100).toFixed(2)}% , {won(t.floorRent)} ) , {won(t.capRent)} )
      </p>
      <p className="fine">
        이 식은 계약 확정 시 컨트랙트에 기록되었고, 컨트랙트에는 이를 변경하는 함수가 존재하지 않습니다.
        매월 임대료는 이 식에 확정 매출을 넣어 자동 산정됩니다.
      </p>

      <h3>4. 절차와 분쟁 규칙</h3>
      <ol className="rules">
        <li><b>매출 게시</b> — 확정 매출은 결제 게이트웨이만 게시합니다. 임차인·임대인의 게시는 컨트랙트가 거부합니다. 게시할 때 정산 원본 파일의 해시를 함께 기록하며, 원본 자체는 체인에 올리지 않습니다.</li>
        <li><b>이의 제기</b> — 게시 후 <b>{DISPUTE_DAYS}일</b> 안에 임대인 또는 임차인이 이의를 걸 수 있습니다. 이의가 걸리면 정산이 멈춥니다.</li>
        <li><b>합의</b> — 이의는 <b>양측 모두의 동의(2-of-2)</b>로만 풀립니다. 게이트웨이는 개입할 수 없습니다.</li>
        <li><b>정산</b> — 예치금에서 임대료를 임대인에게 지급하고 남은 금액은 임차인에게 반환합니다. 예치가 모자라면 받은 만큼만 지급하고 차액을 미납으로 기록합니다.</li>
        <li><b>조정</b> — {lease.mediator && lease.mediator !== ZERO
          ? <>이의가 <b>{MEDIATION_DAYS}일</b> 넘게 풀리지 않으면 양측이 계약 체결 시 함께 서명해 지정한 조정인이 매출을 확정할 수 있습니다. 은행은 조정인이 될 수 없습니다.</>
          : <>이 계약에는 조정인이 없습니다. 합의가 되지 않으면 온체인에서는 풀리지 않으며 계약 외부 절차로 갑니다.</>}</li>
        <li><b>미납</b> — 미납분은 언제든 부분 상환할 수 있으며, 계약이 종료된 뒤에도 채무로 남습니다.</li>
        <li><b>종료</b> — 처리 중인 달(게시됨·이의)이 남아 있으면 종료할 수 없습니다. 종료 시 정산되지 않은 예치금은 임차인에게 반환하고,
          남은 미납분은 <b>보증금에서 회수</b>한 뒤 나머지 보증금을 돌려줍니다.</li>
      </ol>

      <h3>5. 월별 정산 명세</h3>
      <div className="tw">
        <table>
          <thead>
            <tr>
              <th>기간</th><th className="r">확정 매출</th><th className="r">산정 임대료</th>
              <th className="r">부담률</th><th className="r">지급</th><th className="r">미납</th>
              <th>증빙 해시</th><th>상태</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && <tr><td colSpan={8}>아직 게시된 달이 없습니다.</td></tr>}
            {rows.map((m) => (
              <tr key={m.month}>
                <td>{monthLabel(m.month)}</td>
                <td className="r">{won(m.revenue)}</td>
                <td className="r">{won(m.rent)}</td>
                <td className="r">{m.revenue > 0n ? `${pct(m.rent, m.revenue).toFixed(1)}%` : "—"}</td>
                <td className="r">{m.state === 3 ? won(m.paid) : "—"}</td>
                <td className="r">{m.arrears > 0n ? <b className="bad">{won(m.arrears)}</b> : m.state === 3 ? "0" : "—"}</td>
                <td className="mono" title={m.proof}>{m.proof && m.proof !== "0x" + "0".repeat(64) ? short(m.proof) : "—"}</td>
                <td>{["대기", "게시됨", "이의", "정산완료"][m.state]}</td>
              </tr>
            ))}
          </tbody>
          {!only && settled.length > 0 && (
            <tfoot>
              <tr>
                <td><b>{settled.length}개월 합계</b></td>
                <td className="r">{won(sum.rev)}</td>
                <td className="r">{won(sum.rent)}</td>
                <td className="r">{sum.rev > 0n ? `${pct(sum.rent, sum.rev).toFixed(1)}%` : "—"}</td>
                <td className="r">{won(sum.paid)}</td>
                <td className="r">{sum.arrears > 0n ? <b className="bad">{won(sum.arrears)}</b> : "0"}</td>
                <td colSpan={2} />
              </tr>
            </tfoot>
          )}
        </table>
      </div>

      {settled.length > 0 && (
        <p className="fine">
          같은 기간 고정 월세였다면 {won(fixedTotal)}원. 매출연동으로 임대인이 실제 수취한 금액은 {won(sum.paid)}원
          (고정 월세 대비 {pct(sum.paid, fixedTotal).toFixed(1)}%)이며, 임차인의 매출 대비 부담률은 평균 {pct(sum.rent, sum.rev).toFixed(1)}%입니다.
        </p>
      )}

      <h3>6. 검증</h3>
      <p className="fine">
        조건 해시 <b className="mono">{digest}</b><br />
        이 해시에 대한 임대인·임차인의 서명이 계약 확정 시 컨트랙트에서 검증되었습니다.
        {draft && draft.activated && draft.sigL && (
          <> 임대인 서명 <span className="mono">{short(draft.sigL)}</span>, 임차인 서명 <span className="mono">{short(draft.sigT)}</span>.</>
        )}
        {" "}위 표의 모든 금액은 컨트랙트가 남긴 이벤트에서 그대로 읽은 값이며, 이 문서를 위해 다시 계산하지 않았습니다.
      </p>
      <p className="fine">
        본 명세서는 프로토타입 출력물입니다. 금액 단위는 1 wei = 1 원으로 취급했습니다.
      </p>
    </section>
  );
}
