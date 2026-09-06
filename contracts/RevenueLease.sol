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
    }

    struct Period {
        uint256 revenue;          // 확정 매출
        uint256 rent;             // 산정 임대료
        uint256 paid;             // 임대인에게 실제 지급된 금액
        uint256 arrears;          // 미납분
        PeriodState state;
        uint256 proposedRevenue;  // 분쟁 시 제안값
        bool landlordAgreed;
        bool tenantAgreed;
    }

    address public immutable landlord;
    address public immutable tenant;
    address public immutable gateway; // 결제 게이트웨이(은행). 매출을 게시하는 유일한 주체

    Terms public terms;
    LeaseState public state;

    mapping(uint16 => Period) private periods;
    mapping(uint16 => uint256) public escrow; // 기간별 예치금

    event Activated(uint256 baseRent, uint16 pctBps, uint256 floorRent, uint256 capRent, uint16 totalPeriods);
    event Funded(uint16 indexed period, uint256 amount);
    event RevenuePosted(uint16 indexed period, uint256 revenue, uint256 rent);
    event Disputed(uint16 indexed period, address by, uint256 proposedRevenue);
    event DisputeResolved(uint16 indexed period, uint256 revenue, uint256 rent);
    event Settled(uint16 indexed period, uint256 rent, uint256 paid, uint256 arrears, uint256 refunded);
    event Ended();

    error NotAuthorized();
    error BadState();
    error BadTerms();
    error BadPeriod();

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
    function activate(
        uint256 baseRent,
        uint16 pctBps,
        uint256 floorRent,
        uint256 capRent,
        uint16 totalPeriods,
        bytes calldata landlordSig,
        bytes calldata tenantSig
    ) external {
        if (state != LeaseState.Draft) revert BadState();
        if (pctBps > 10_000) revert BadTerms();
        if (floorRent > capRent) revert BadTerms();
        if (totalPeriods == 0) revert BadTerms();

        bytes32 digest = keccak256(
            abi.encode(address(this), baseRent, pctBps, floorRent, capRent, totalPeriods)
        );
        if (_recover(digest, landlordSig) != landlord) revert NotAuthorized();
        if (_recover(digest, tenantSig) != tenant) revert NotAuthorized();

        terms = Terms(baseRent, pctBps, floorRent, capRent, totalPeriods);
        state = LeaseState.Active;
        emit Activated(baseRent, pctBps, floorRent, capRent, totalPeriods);
    }

    /// @notice 임차인이 해당 월 임대료 재원을 예치
    function fund(uint16 period) external payable only(tenant) {
        if (state != LeaseState.Active) revert BadState();
        if (period == 0 || period > terms.totalPeriods) revert BadPeriod();
        escrow[period] += msg.value;
        emit Funded(period, msg.value);
    }

    /// @notice 결제 게이트웨이가 확정 매출을 게시. 임차인 자가신고가 아니다.
    function postRevenue(uint16 period, uint256 revenue) external only(gateway) {
        if (state != LeaseState.Active) revert BadState();
        if (period == 0 || period > terms.totalPeriods) revert BadPeriod();
        Period storage p = periods[period];
        if (p.state != PeriodState.None) revert BadState();
        p.revenue = revenue;
        p.rent = quote(revenue);
        p.state = PeriodState.Posted;
        emit RevenuePosted(period, revenue, p.rent);
    }

    /// @notice 게시된 매출에 이의. 정산이 멈춘다.
    function dispute(uint16 period, uint256 proposedRevenue) external {
        if (msg.sender != landlord && msg.sender != tenant) revert NotAuthorized();
        Period storage p = periods[period];
        if (p.state != PeriodState.Posted) revert BadState();
        p.state = PeriodState.Disputed;
        p.proposedRevenue = proposedRevenue;
        p.landlordAgreed = (msg.sender == landlord);
        p.tenantAgreed = (msg.sender == tenant);
        emit Disputed(period, msg.sender, proposedRevenue);
    }

    /// @notice 분쟁 해결은 양측 2-of-2 동의로만 가능하다.
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

    function end() external {
        if (msg.sender != landlord && msg.sender != tenant) revert NotAuthorized();
        if (state != LeaseState.Active) revert BadState();
        state = LeaseState.Ended;
        emit Ended();
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
