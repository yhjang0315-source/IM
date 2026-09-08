import { won, monthLabel, roleOf, ROLE_LABEL, short, ZERO } from "./lease";

/** 이벤트 한 줄을 사람 말로. 누가 했는지는 컨트랙트가 강제한 역할에서 온다. */
function describe(ev) {
  const a = ev.args;
  const L = (p) => monthLabel(p);
  switch (ev.name) {
    case "Activated":
      return { who: "양측 서명", text: `조건 확정 — 기본료 ${won(a.baseRent)} · 연동 ${Number(a.pctBps) / 100}% · 하한 ${won(a.floorRent)} · 상한 ${won(a.capRent)} · ${a.totalPeriods}개월 · 보증금 ${won(a.deposit)}${a.mediator && a.mediator !== ZERO ? ` · 조정인 ${short(a.mediator)}` : " · 조정인 없음"}` };
    case "DepositPaid":
      return { who: "임차인", text: `보증금 ${won(a.amount)}원 납입 · 누계 ${won(a.total)}원` };
    case "Mediated":
      return { who: "조정인", text: `${L(a.period)} 조정 확정 · 매출 ${won(a.revenue)}원 → 임대료 ${won(a.rent)}원`, warn: true };
    case "Funded":
      return { who: "임차인", text: `${L(a.period)} 임대료 재원 예치 ${won(a.amount)}원` };
    case "RevenuePosted":
      return { who: "게이트웨이", text: `${L(a.period)} 확정 매출 ${won(a.revenue)}원 게시 → 임대료 ${won(a.rent)}원 · 증빙 ${short(a.proof)}` };
    case "Disputed":
      return { who: ROLE_LABEL[roleOf(a.by)] || short(a.by), text: `${L(a.period)} 이의 제기 · 제안 매출 ${won(a.proposedRevenue)}원 — 정산 정지`, bad: true };
    case "DisputeResolved":
      return { who: "양측 동의", text: `${L(a.period)} 합의 · 매출 ${won(a.revenue)}원 → 임대료 ${won(a.rent)}원` };
    case "Settled": {
      const bits = [`임대인 지급 ${won(a.paid)}원`];
      if (a.arrears > 0n) bits.push(`미납 ${won(a.arrears)}원`);
      if (a.refunded > 0n) bits.push(`임차인 환급 ${won(a.refunded)}원`);
      return { who: "정산", text: `${L(a.period)} 정산 · ${bits.join(" · ")}`, warn: a.arrears > 0n };
    }
    case "Repaid":
      return { who: "임차인", text: `${L(a.period)} 미납 상환 ${won(a.amount)}원${a.arrearsLeft > 0n ? ` · 남은 미납 ${won(a.arrearsLeft)}원` : " · 미납 정리 완료"}` };
    case "Ended": {
      const bits = [];
      if (a.escrowRefunded > 0n) bits.push(`미정산 예치금 ${won(a.escrowRefunded)}원 반환`);
      if (a.depositApplied > 0n) bits.push(`보증금에서 미납 ${won(a.depositApplied)}원 회수`);
      if (a.depositReturned > 0n) bits.push(`보증금 ${won(a.depositReturned)}원 반환`);
      return { who: "당사자", text: `계약 종료${bits.length ? " · " + bits.join(" · ") : ""}`, bad: true };
    }
    default:
      return { who: "", text: ev.name };
  }
}

export default function Activity({ items }) {
  return (
    <section className="pane">
      <h2>활동</h2>
      <p className="lead">컨트랙트가 남긴 이벤트 전부입니다. 각 줄은 블록에 기록된 트랜잭션 하나에 대응합니다.</p>
      {!items.length && <p className="empty">아직 기록이 없습니다. 계약을 체결하면 첫 줄이 생깁니다.</p>}
      <ol className="feed">
        {items.map((ev) => {
          const d = describe(ev);
          return (
            <li key={ev.key} className={d.bad ? "bad" : d.warn ? "warn" : ""}>
              <span className="ft">{new Date(ev.time).toLocaleString("ko-KR", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span>
              <span className="fe">{ev.name}</span>
              <span className="fx">{d.text}</span>
              <span className="fw">{d.who}</span>
              <span className="fb">#{ev.block} · {short(ev.tx)}</span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
