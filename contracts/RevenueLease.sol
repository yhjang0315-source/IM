// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title RevenueLease — 매출연동 임대차
/// @notice 임대료 = clamp(기본료 + 매출 x 연동률, 하한, 상한).
///         산정 공식은 활성화 시점에 고정되며 이후 어느 쪽도 바꿀 수 없다(세터 없음).
contract RevenueLease {
    enum LeaseState { Draft, Active, Ended }
    enum PeriodState { None, Posted, Disputed, Settled }

    struct Terms {
        uint256 baseRent;     // 기본료 (원)
        uint16  pctBps;       // 매출 연동률 (bp, 800 = 8%)
        uint256 floorRent;    // 하한 (원)
        uint256 capRent;      // 상한 (원)
        uint16  totalPeriods; // 계약 개월수
        uint256 deposit;      // 약정 보증금 (원)
    }

    struct Period {
        uint256 revenue;          // 확정 매출
        uint256 rent;             // 산정 임대료
        uint256 paid;             // 임대인에게 실제 지급된 금액(사후 상환·보증금 충당 포함)
        uint256 arrears;          // 남은 미납분
        PeriodState state;
        uint256 proposedRevenue;  // 분쟁 시 제안값
        bool landlordAgreed;
        bool tenantAgreed;
        bytes32 proof;            // 게이트웨이 정산 원본 파일의 해시. 원본은 체인 밖에 둔다.
        uint64  postedAt;         // 매출이 게시된 시각. 이의 기한의 기준.
        uint64  disputedAt;       // 이의가 걸린 시각. 조정 개시 기한의 기준.
    }

    /// @notice 매출 게시 후 이 기간이 지나면 이의를 걸 수 없다. 무기한 분쟁을 막는다.
    uint64 public constant DISPUTE_WINDOW = 7 days;
    /// @notice 이의가 걸린 뒤 이 기간까지 합의가 없으면 조정인이 개입할 수 있다.
    uint64 public constant MEDIATION_DELAY = 14 days;

    address public immutable landlord;
    address public immutable tenant;
    address public immutable gateway; // 결제 게이트웨이(은행). 매출을 게시하는 유일한 주체

    /// @notice 조정인. 양측이 계약 체결 시 함께 서명해 지정한 제3자만 될 수 있다.
    ///         지정하지 않으면(0) 조정 절차 자체가 없고 분쟁은 오직 2-of-2 합의로만 풀린다.
    address public mediator;

    Terms public terms;
    LeaseState public state;
    uint256 public depositPaid; // 임차인이 실제로 넣은 보증금 잔액

    mapping(uint16 => Period) private periods;
    mapping(uint16 => uint256) public escrow; // 기간별 예치금

    event Activated(uint256 baseRent, uint16 pctBps, uint256 floorRent, uint256 capRent, uint16 totalPeriods, uint256 deposit, address mediator);
    event DepositPaid(uint256 amount, uint256 total);
    event Funded(uint16 indexed period, uint256 amount);
    event RevenuePosted(uint16 indexed period, uint256 revenue, uint256 rent, bytes32 proof);
    event Disputed(uint16 indexed period, address by, uint256 proposedRevenue);
    event DisputeResolved(uint16 indexed period, uint256 revenue, uint256 rent);
    event Mediated(uint16 indexed period, uint256 revenue, uint256 rent);
    event Settled(uint16 indexed period, uint256 rent, uint256 paid, uint256 arrears, uint256 refunded);
    event Repaid(uint16 indexed period, uint256 amount, uint256 arrearsLeft);
    event Ended(uint256 escrowRefunded, uint256 depositApplied, uint256 depositReturned);

    error NotAuthorized();
    error BadState();
    error BadTerms();
    error BadPeriod();
    error NothingDue();
    error WindowClosed();
    error TooEarly();
    error Unfinished(uint16 period);

    modifier only(address who) {
        if (msg.sender != who) revert NotAuthorized();
        _;
    }

    constructor(address _landlord, address _tenant, address _gateway) {
        if (_landlord == address(0) || _tenant == address(0) || _gateway == address(0)) revert BadTerms();
        landlord = _landlord;
        tenant = _tenant;
        gateway = _gateway;
        state = LeaseState.Draft;
    }

    /// @notice 조건 확정. 양측이 서명한 조건을 한 번만 기록하며, 이후 변경 함수는 존재하지 않는다.
    /// @param _mediator 교착된 분쟁을 풀 제3자. 0이면 조정 절차 없음.
    ///        서명 대상에 포함되므로, 양측이 동의하지 않은 조정인은 지정될 수 없다.
    function activate(
        uint256 baseRent,
        uint16 pctBps,
        uint256 floorRent,
        uint256 capRent,
        uint16 totalPeriods,
        uint256 deposit,
        address _mediator,
        bytes calldata landlordSig,
        bytes calldata tenantSig
    ) external {
        if (state != LeaseState.Draft) revert BadState();
        if (pctBps > 10_000) revert BadTerms();
        if (floorRent > capRent) revert BadTerms();
        if (totalPeriods == 0) revert BadTerms();
        if (_mediator == landlord || _mediator == tenant || _mediator == gateway) revert BadTerms();

        bytes32 digest = keccak256(
            abi.encode(address(this), baseRent, pctBps, floorRent, capRent, totalPeriods, deposit, _mediator)
        );
        if (_recover(digest, landlordSig) != landlord) revert NotAuthorized();
        if (_recover(digest, tenantSig) != tenant) revert NotAuthorized();

        terms = Terms(baseRent, pctBps, floorRent, capRent, totalPeriods, deposit);
        mediator = _mediator;
        state = LeaseState.Active;
        emit Activated(baseRent, pctBps, floorRent, capRent, totalPeriods, deposit, _mediator);
    }

    /// @notice 보증금 납입. 여러 번 나눠 넣을 수 있다.
    /// @dev 종료 시 미납분을 여기서 먼저 회수하고 남은 금액만 돌려준다.
    function payDeposit() external payable only(tenant) {
        if (state != LeaseState.Active) revert BadState();
        depositPaid += msg.value;
        emit DepositPaid(msg.value, depositPaid);
    }

    /// @notice 임차인이 해당 월 임대료 재원을 예치.
    /// @dev 이미 정산이 끝난 달에는 넣을 수 없다. 넣어봐야 다시 정산할 방법이 없어 돈이 묶인다.
    ///      미납분을 갚는 것은 repay() 로 한다.
    function fund(uint16 period) external payable only(tenant) {
        if (state != LeaseState.Active) revert BadState();
        if (period == 0 || period > terms.totalPeriods) revert BadPeriod();
        if (periods[period].state == PeriodState.Settled) revert BadState();
        escrow[period] += msg.value;
        emit Funded(period, msg.value);
    }

    /// @notice 결제 게이트웨이가 확정 매출을 게시. 임차인 자가신고가 아니다.
    /// @param proof 정산 원본 파일(카드사·PG 집계)의 해시. 원본은 은행이 보관하고 체인에는 지문만 남긴다.
    function postRevenue(uint16 period, uint256 revenue, bytes32 proof) external only(gateway) {
        if (state != LeaseState.Active) revert BadState();
        if (period == 0 || period > terms.totalPeriods) revert BadPeriod();
        Period storage p = periods[period];
        if (p.state != PeriodState.None) revert BadState();
        p.revenue = revenue;
        p.rent = quote(revenue);
        p.state = PeriodState.Posted;
        p.proof = proof;
        p.postedAt = uint64(block.timestamp);
        emit RevenuePosted(period, revenue, p.rent, proof);
    }

    /// @notice 게시된 매출에 이의. 정산이 멈춘다. 게시 후 DISPUTE_WINDOW 안에만 가능하다.
    function dispute(uint16 period, uint256 proposedRevenue) external {
        if (msg.sender != landlord && msg.sender != tenant) revert NotAuthorized();
        Period storage p = periods[period];
        if (p.state != PeriodState.Posted) revert BadState();
        if (block.timestamp > p.postedAt + DISPUTE_WINDOW) revert WindowClosed();
        p.state = PeriodState.Disputed;
        p.proposedRevenue = proposedRevenue;
        p.landlordAgreed = (msg.sender == landlord);
        p.tenantAgreed = (msg.sender == tenant);
        p.disputedAt = uint64(block.timestamp);
        emit Disputed(period, msg.sender, proposedRevenue);
    }

    /// @notice 분쟁 해결은 양측 2-of-2 동의로만 가능하다. 게이트웨이는 개입할 수 없다.
    function agree(uint16 period) external {
        Period storage p = periods[period];
        if (p.state != PeriodState.Disputed) revert BadState();
        if (msg.sender == landlord) p.landlordAgreed = true;
        else if (msg.sender == tenant) p.tenantAgreed = true;
        else revert NotAuthorized();

        if (p.landlordAgreed && p.tenantAgreed) {
            p.revenue = p.proposedRevenue;
            p.rent = quote(p.revenue);
            p.state = PeriodState.Posted;
            emit DisputeResolved(period, p.revenue, p.rent);
        }
    }

    /// @notice 교착된 분쟁을 조정인이 확정한다.
    /// @dev 양측이 체결 시 함께 지정한 제3자만, 그것도 MEDIATION_DELAY 가 지난 뒤에만 개입할 수 있다.
    ///      은행(게이트웨이)은 조정인이 될 수 없다 — 매출을 게시한 쪽이 분쟁까지 결정하면 안 된다.
    function mediate(uint16 period, uint256 revenue) external {
        if (mediator == address(0) || msg.sender != mediator) revert NotAuthorized();
        Period storage p = periods[period];
        if (p.state != PeriodState.Disputed) revert BadState();
        if (block.timestamp < p.disputedAt + MEDIATION_DELAY) revert TooEarly();
        p.revenue = revenue;
        p.rent = quote(revenue);
        p.state = PeriodState.Posted;
        emit Mediated(period, revenue, p.rent);
    }

    /// @notice 정산. 임대료는 임대인에게, 남은 예치금은 임차인에게.
    function settle(uint16 period) external {
        Period storage p = periods[period];
        if (p.state != PeriodState.Posted) revert BadState();

        uint256 bal = escrow[period];
        uint256 rent = p.rent;
        uint256 pay = bal < rent ? bal : rent;
        uint256 refund = bal - pay;

        p.paid = pay;
        p.arrears = rent - pay;
        p.state = PeriodState.Settled;
        escrow[period] = 0;

        if (pay > 0) {
            (bool okL, ) = landlord.call{value: pay}("");
            require(okL, "landlord transfer failed");
        }
        if (refund > 0) {
            (bool okT, ) = tenant.call{value: refund}("");
            require(okT, "tenant refund failed");
        }
        emit Settled(period, rent, pay, p.arrears, refund);
    }

    /// @notice 정산 후 남은 미납분을 갚는다. 부분 상환이 되고, 초과분은 즉시 돌려준다.
    /// @dev 계약이 끝난 뒤에도 갚을 수 있다. 채무는 계약 종료로 사라지지 않는다.
    function repay(uint16 period) external payable only(tenant) {
        if (state == LeaseState.Draft) revert BadState();
        Period storage p = periods[period];
        if (p.state != PeriodState.Settled) revert BadState();
        if (p.arrears == 0) revert NothingDue();

        uint256 due = p.arrears;
        uint256 pay = msg.value < due ? msg.value : due;
        uint256 back = msg.value - pay;

        p.arrears = due - pay;
        p.paid += pay;

        if (pay > 0) {
            (bool okL, ) = landlord.call{value: pay}("");
            require(okL, "landlord transfer failed");
        }
        if (back > 0) {
            (bool okT, ) = tenant.call{value: back}("");
            require(okT, "tenant refund failed");
        }
        emit Repaid(period, pay, p.arrears);
    }

    /// @notice 계약 종료. 처리 중인 달(게시됨·이의)이 남아 있으면 종료할 수 없다.
    ///         정산되지 않은 예치금은 임차인에게 돌려주고,
    ///         남은 미납분은 보증금에서 회수한 뒤 나머지 보증금을 반환한다.
    function end() external {
        if (msg.sender != landlord && msg.sender != tenant) revert NotAuthorized();
        if (state != LeaseState.Active) revert BadState();

        uint256 refund = 0;
        uint16 n = terms.totalPeriods;
        for (uint16 i = 1; i <= n; i++) {
            PeriodState ps = periods[i].state;
            if (ps == PeriodState.Posted || ps == PeriodState.Disputed) revert Unfinished(i);
            uint256 e = escrow[i];
            if (e > 0) {
                escrow[i] = 0;
                refund += e;
            }
        }

        // 보증금으로 미납분부터 갚는다. 이것이 보증금의 본래 목적이다.
        uint256 pool = depositPaid;
        uint256 applied = 0;
        for (uint16 i = 1; i <= n && pool > 0; i++) {
            uint256 a = periods[i].arrears;
            if (a == 0) continue;
            uint256 take = a < pool ? a : pool;
            periods[i].arrears = a - take;
            periods[i].paid += take;
            pool -= take;
            applied += take;
        }
        depositPaid = 0;
        state = LeaseState.Ended;

        uint256 toTenant = refund + pool;
        if (applied > 0) {
            (bool okL, ) = landlord.call{value: applied}("");
            require(okL, "landlord transfer failed");
        }
        if (toTenant > 0) {
            (bool okT, ) = tenant.call{value: toTenant}("");
            require(okT, "tenant refund failed");
        }
        emit Ended(refund, applied, pool);
    }

    /// @notice 임대료 산정식. 순수 함수이며 조건은 불변이므로 결과를 사후에 조작할 수 없다.
    function quote(uint256 revenue) public view returns (uint256) {
        uint256 r = terms.baseRent + (revenue * terms.pctBps) / 10_000;
        if (r < terms.floorRent) return terms.floorRent;
        if (r > terms.capRent) return terms.capRent;
        return r;
    }

    function periodOf(uint16 period) external view returns (Period memory) {
        return periods[period];
    }

    /// @notice 남은 미납 합계. 화면과 조정 절차에서 쓴다.
    function totalArrears() external view returns (uint256 sum) {
        uint16 n = terms.totalPeriods;
        for (uint16 i = 1; i <= n; i++) sum += periods[i].arrears;
    }

    function _recover(bytes32 digest, bytes calldata sig) private pure returns (address) {
        bytes32 eth = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", digest));
        if (sig.length != 65) revert NotAuthorized();
        bytes32 r; bytes32 s; uint8 v;
        assembly {
            r := calldataload(sig.offset)
            s := calldataload(add(sig.offset, 32))
            v := byte(0, calldataload(add(sig.offset, 64)))
        }
        return ecrecover(eth, v, r, s);
    }
}
