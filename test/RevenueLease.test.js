const { expect } = require("chai");
const { ethers } = require("hardhat");

// 프로토타입 단위: 1 wei = 1 원
const T = {
  baseRent: 800_000n,      // 기본료 80만
  pctBps: 800,             // 매출 8%
  floorRent: 1_500_000n,   // 하한 150만
  capRent: 3_500_000n,     // 상한 350만
  totalPeriods: 12,
  deposit: 10_000_000n,    // 보증금 1,000만
};

const PROOF = ethers.keccak256(ethers.toUtf8Bytes("PG정산파일-테스트"));
const NO_MEDIATOR = "0x0000000000000000000000000000000000000000";
const DAY = 24 * 60 * 60;

const jump = async (secs) => {
  await ethers.provider.send("evm_increaseTime", [secs]);
  await ethers.provider.send("evm_mine", []);
};

/** 양측이 서명하는 조건 해시. 보증금과 조정인까지 포함해야 사후에 끼워 넣을 수 없다. */
function digestOf(addr, t, mediator) {
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["address", "uint256", "uint16", "uint256", "uint256", "uint16", "uint256", "address"],
      [addr, t.baseRent, t.pctBps, t.floorRent, t.capRent, t.totalPeriods, t.deposit, mediator]
    )
  );
}

async function deployAndActivate(opts = {}) {
  const [landlord, tenant, gateway, outsider, mediatorAcct] = await ethers.getSigners();
  const mediator = opts.withMediator ? mediatorAcct.address : NO_MEDIATOR;
  const F = await ethers.getContractFactory("RevenueLease");
  const c = await F.deploy(landlord.address, tenant.address, gateway.address);
  await c.waitForDeployment();

  const digest = digestOf(await c.getAddress(), T, mediator);
  const sigL = await landlord.signMessage(ethers.getBytes(digest));
  const sigT = await tenant.signMessage(ethers.getBytes(digest));
  await c.activate(T.baseRent, T.pctBps, T.floorRent, T.capRent, T.totalPeriods, T.deposit, mediator, sigL, sigT);
  return { c, landlord, tenant, gateway, outsider, mediator: mediatorAcct };
}

describe("RevenueLease", function () {
  it("양측 서명이 있어야만 조건이 확정된다", async () => {
    const [landlord, tenant, gateway, outsider] = await ethers.getSigners();
    const F = await ethers.getContractFactory("RevenueLease");
    const c = await F.deploy(landlord.address, tenant.address, gateway.address);
    const digest = digestOf(await c.getAddress(), T, NO_MEDIATOR);
    const sigL = await landlord.signMessage(ethers.getBytes(digest));
    const sigBad = await outsider.signMessage(ethers.getBytes(digest));
    await expect(
      c.activate(T.baseRent, T.pctBps, T.floorRent, T.capRent, T.totalPeriods, T.deposit, NO_MEDIATOR, sigL, sigBad)
    ).to.be.revertedWithCustomError(c, "NotAuthorized");
  });

  it("확정된 조건은 두 번 활성화할 수 없다 (변경 함수 자체가 없음)", async () => {
    const { c, landlord, tenant } = await deployAndActivate();
    const alt = { ...T, baseRent: 5_000_000n };
    const digest = digestOf(await c.getAddress(), alt, NO_MEDIATOR);
    const sigL = await landlord.signMessage(ethers.getBytes(digest));
    const sigT = await tenant.signMessage(ethers.getBytes(digest));
    await expect(
      c.activate(alt.baseRent, alt.pctBps, alt.floorRent, alt.capRent, alt.totalPeriods, alt.deposit, NO_MEDIATOR, sigL, sigT)
    ).to.be.revertedWithCustomError(c, "BadState");
    // 컨트랙트 ABI에 조건 변경 함수가 존재하지 않음을 확인
    const names = c.interface.fragments.filter(f => f.type === "function").map(f => f.name);
    expect(names).to.not.include.members(["setTerms", "updateTerms", "setBaseRent", "setPct"]);
  });

  it("평월: 매출 2,000만 → 임대료 240만", async () => {
    const { c } = await deployAndActivate();
    expect(await c.quote(20_000_000n)).to.equal(2_400_000n);
  });

  it("매출 급감 달에는 임대료가 내려가고, 하한에서 멈춘다", async () => {
    const { c } = await deployAndActivate();
    // 500만 매출 → 80만 + 40만 = 120만 → 하한 150만으로 상향
    expect(await c.quote(5_000_000n)).to.equal(1_500_000n);
    // 1,200만 매출 → 80만 + 96만 = 176만 (구간 내)
    expect(await c.quote(12_000_000n)).to.equal(1_760_000n);
  });

  it("호황 달에는 상한에서 멈춘다 (임대인 상방도 제한)", async () => {
    const { c } = await deployAndActivate();
    expect(await c.quote(50_000_000n)).to.equal(3_500_000n);
  });

  it("매출은 결제 게이트웨이만 게시할 수 있다 (임차인 자가신고 불가)", async () => {
    const { c, tenant, landlord, gateway } = await deployAndActivate();
    await expect(c.connect(tenant).postRevenue(1, 1n, PROOF)).to.be.revertedWithCustomError(c, "NotAuthorized");
    await expect(c.connect(landlord).postRevenue(1, 1n, PROOF)).to.be.revertedWithCustomError(c, "NotAuthorized");
    await expect(c.connect(gateway).postRevenue(1, 20_000_000n, PROOF)).to.emit(c, "RevenuePosted");
  });

  it("정산 원본의 해시가 함께 기록된다 (원본은 체인에 올리지 않는다)", async () => {
    const { c, gateway } = await deployAndActivate();
    await expect(c.connect(gateway).postRevenue(1, 20_000_000n, PROOF))
      .to.emit(c, "RevenuePosted").withArgs(1, 20_000_000n, 2_400_000n, PROOF);
    const p = await c.periodOf(1);
    expect(p.proof).to.equal(PROOF);
    expect(p.postedAt).to.be.greaterThan(0n);
  });

  it("정산: 임대료는 임대인에게, 남은 예치금은 임차인에게 돌아간다", async () => {
    const { c, landlord, tenant, gateway } = await deployAndActivate();
    await c.connect(tenant).fund(1, { value: 3_000_000n });
    await c.connect(gateway).postRevenue(1, 20_000_000n, PROOF); // rent 240만

    const beforeL = await ethers.provider.getBalance(landlord.address);
    await expect(c.connect(gateway).settle(1))
      .to.emit(c, "Settled")
      .withArgs(1, 2_400_000n, 2_400_000n, 0n, 600_000n);
    const afterL = await ethers.provider.getBalance(landlord.address);
    expect(afterL - beforeL).to.equal(2_400_000n);
    expect(await c.escrow(1)).to.equal(0n);
  });

  it("예치금이 모자라면 받은 만큼만 지급하고 미납분이 기록된다", async () => {
    const { c, tenant, gateway } = await deployAndActivate();
    await c.connect(tenant).fund(2, { value: 1_000_000n });
    await c.connect(gateway).postRevenue(2, 20_000_000n, PROOF); // rent 240만
    await c.connect(gateway).settle(2);
    const p = await c.periodOf(2);
    expect(p.paid).to.equal(1_000_000n);
    expect(p.arrears).to.equal(1_400_000n);
    expect(await c.totalArrears()).to.equal(1_400_000n);
  });

  it("이의가 걸리면 정산이 멈추고, 양측 합의로만 풀린다", async () => {
    const { c, landlord, tenant, gateway } = await deployAndActivate();
    await c.connect(tenant).fund(3, { value: 3_000_000n });
    await c.connect(gateway).postRevenue(3, 20_000_000n, PROOF);

    await c.connect(landlord).dispute(3, 25_000_000n);
    await expect(c.settle(3)).to.be.revertedWithCustomError(c, "BadState"); // 정산 차단

    // 임대인 단독으로는 못 푼다
    await c.connect(landlord).agree(3);
    await expect(c.settle(3)).to.be.revertedWithCustomError(c, "BadState");

    // 임차인까지 동의해야 해제
    await expect(c.connect(tenant).agree(3))
      .to.emit(c, "DisputeResolved")
      .withArgs(3, 25_000_000n, 2_800_000n);
    await expect(c.settle(3)).to.emit(c, "Settled");
  });

  it("계약 당사자가 아니면 이의를 걸 수 없다", async () => {
    const { c, gateway, outsider } = await deployAndActivate();
    await c.connect(gateway).postRevenue(4, 20_000_000n, PROOF);
    await expect(c.connect(outsider).dispute(4, 1n)).to.be.revertedWithCustomError(c, "NotAuthorized");
  });

  it("이의 제기 기한(7일)이 지나면 걸 수 없다", async () => {
    const { c, landlord, gateway } = await deployAndActivate();
    await c.connect(gateway).postRevenue(5, 20_000_000n, PROOF);
    await jump(7 * DAY + 1);
    await expect(c.connect(landlord).dispute(5, 25_000_000n))
      .to.be.revertedWithCustomError(c, "WindowClosed");
    // 기한이 지나도 정산은 정상 진행된다
    await expect(c.connect(gateway).settle(5)).to.emit(c, "Settled");
  });

  it("정산이 끝난 달에는 다시 예치할 수 없다 (자금이 묶이는 것을 막는다)", async () => {
    const { c, tenant, gateway } = await deployAndActivate();
    await c.connect(tenant).fund(6, { value: 3_000_000n });
    await c.connect(gateway).postRevenue(6, 20_000_000n, PROOF);
    await c.connect(gateway).settle(6);
    await expect(c.connect(tenant).fund(6, { value: 1_000_000n }))
      .to.be.revertedWithCustomError(c, "BadState");
    expect(await c.escrow(6)).to.equal(0n);
  });

  it("미납분은 나중에 갚을 수 있고, 부분 상환과 초과분 반환이 된다", async () => {
    const { c, landlord, tenant, gateway } = await deployAndActivate();
    await c.connect(tenant).fund(7, { value: 1_000_000n });
    await c.connect(gateway).postRevenue(7, 20_000_000n, PROOF); // rent 240만
    await c.connect(gateway).settle(7);                          // 미납 140만

    // 부분 상환
    await expect(c.connect(tenant).repay(7, { value: 400_000n }))
      .to.emit(c, "Repaid").withArgs(7, 400_000n, 1_000_000n);

    // 남은 100만보다 많이 보내면 초과분은 돌아온다
    const beforeL = await ethers.provider.getBalance(landlord.address);
    await c.connect(tenant).repay(7, { value: 1_500_000n });
    const afterL = await ethers.provider.getBalance(landlord.address);
    expect(afterL - beforeL).to.equal(1_000_000n);

    const p = await c.periodOf(7);
    expect(p.arrears).to.equal(0n);
    expect(p.paid).to.equal(2_400_000n); // 예치 100만 + 상환 140만
    await expect(c.connect(tenant).repay(7, { value: 1n })).to.be.revertedWithCustomError(c, "NothingDue");
  });

  it("처리 중인 달이 남아 있으면 계약을 끝낼 수 없다", async () => {
    const { c, landlord, tenant, gateway } = await deployAndActivate();
    await c.connect(tenant).fund(8, { value: 3_000_000n });
    await c.connect(gateway).postRevenue(8, 20_000_000n, PROOF); // 게시된 채로 남김
    await expect(c.connect(landlord).end()).to.be.revertedWithCustomError(c, "Unfinished").withArgs(8);
    await c.connect(gateway).settle(8);
    await expect(c.connect(landlord).end()).to.emit(c, "Ended");
  });

  it("계약을 끝내면 정산되지 않은 예치금이 임차인에게 돌아온다", async () => {
    const { c, tenant, landlord } = await deployAndActivate();
    await c.connect(tenant).fund(9, { value: 2_000_000n });   // 게시 전 예치
    await c.connect(tenant).fund(10, { value: 500_000n });
    const before = await ethers.provider.getBalance(tenant.address);
    await expect(c.connect(landlord).end()).to.emit(c, "Ended").withArgs(2_500_000n, 0n, 0n);
    const after = await ethers.provider.getBalance(tenant.address);
    expect(after - before).to.equal(2_500_000n); // 임대인이 종료해서 임차인은 가스를 쓰지 않았다
    expect(await c.escrow(9)).to.equal(0n);
    expect(await ethers.provider.getBalance(await c.getAddress())).to.equal(0n);
  });

  it("종료 후에도 미납분은 남고, 갚을 수 있다", async () => {
    const { c, tenant, landlord, gateway } = await deployAndActivate();
    await c.connect(tenant).fund(11, { value: 1_000_000n });
    await c.connect(gateway).postRevenue(11, 20_000_000n, PROOF);
    await c.connect(gateway).settle(11);                        // 미납 140만
    await c.connect(landlord).end();                            // 보증금 없음 → 그대로 남는다

    expect(await c.totalArrears()).to.equal(1_400_000n);
    await expect(c.connect(tenant).fund(12, { value: 1n })).to.be.revertedWithCustomError(c, "BadState");
    await expect(c.connect(tenant).repay(11, { value: 1_400_000n }))
      .to.emit(c, "Repaid").withArgs(11, 1_400_000n, 0n);
    expect(await c.totalArrears()).to.equal(0n);
  });

  // ---------------- 보증금 ----------------

  it("종료 시 보증금에서 미납분을 회수하고 나머지를 돌려준다", async () => {
    const { c, landlord, tenant, gateway } = await deployAndActivate();
    await c.connect(tenant).payDeposit({ value: T.deposit });
    expect(await c.depositPaid()).to.equal(T.deposit);

    await c.connect(tenant).fund(1, { value: 1_000_000n });
    await c.connect(gateway).postRevenue(1, 20_000_000n, PROOF); // 임대료 240만
    await c.connect(gateway).settle(1);                          // 미납 140만
    expect(await c.totalArrears()).to.equal(1_400_000n);

    const beforeT = await ethers.provider.getBalance(tenant.address);
    // 회수 금액은 이벤트로 확인한다. 임대인이 직접 종료를 호출하면 가스비가 섞여
    // 잔액 비교로는 확인할 수 없다 (이 프로토타입은 1 wei = 1 원이라 회수액이 가스비보다 작다).
    await expect(c.connect(landlord).end())
      .to.emit(c, "Ended").withArgs(0n, 1_400_000n, T.deposit - 1_400_000n);
    const afterT = await ethers.provider.getBalance(tenant.address);

    // 임차인은 가스를 쓰지 않았으므로 남은 보증금이 정확히 들어온다
    expect(afterT - beforeT).to.equal(T.deposit - 1_400_000n);
    expect(await c.totalArrears()).to.equal(0n);
    expect(await c.depositPaid()).to.equal(0n);
    expect(await ethers.provider.getBalance(await c.getAddress())).to.equal(0n);
  });

  it("보증금보다 미납이 크면 보증금을 다 쓰고 나머지는 채무로 남는다", async () => {
    const { c, landlord, tenant, gateway } = await deployAndActivate();
    await c.connect(tenant).payDeposit({ value: 1_000_000n });   // 보증금 100만만 납입
    await c.connect(gateway).postRevenue(1, 20_000_000n, PROOF); // 예치 0 → 미납 240만
    await c.connect(gateway).settle(1);
    await expect(c.connect(landlord).end())
      .to.emit(c, "Ended").withArgs(0n, 1_000_000n, 0n);
    expect(await c.totalArrears()).to.equal(1_400_000n);         // 240만 − 100만
  });

  it("보증금은 임차인만 넣을 수 있고, 종료 후에는 넣을 수 없다", async () => {
    const { c, landlord, tenant } = await deployAndActivate();
    await expect(c.connect(landlord).payDeposit({ value: 1n })).to.be.revertedWithCustomError(c, "NotAuthorized");
    await c.connect(tenant).payDeposit({ value: 500_000n });
    await c.connect(tenant).end();
    await expect(c.connect(tenant).payDeposit({ value: 1n })).to.be.revertedWithCustomError(c, "BadState");
  });

  // ---------------- 조정인 ----------------

  it("조정인을 지정하지 않으면 조정 절차 자체가 없다", async () => {
    const { c, tenant, gateway, outsider } = await deployAndActivate();
    expect(await c.mediator()).to.equal(NO_MEDIATOR);
    await c.connect(gateway).postRevenue(1, 20_000_000n, PROOF);
    await c.connect(tenant).dispute(1, 15_000_000n);
    await jump(15 * DAY);
    await expect(c.connect(outsider).mediate(1, 18_000_000n)).to.be.revertedWithCustomError(c, "NotAuthorized");
  });

  it("조정인은 교착이 14일 지난 뒤에만 개입할 수 있다", async () => {
    const { c, tenant, gateway, mediator } = await deployAndActivate({ withMediator: true });
    expect(await c.mediator()).to.equal(mediator.address);
    await c.connect(tenant).fund(1, { value: 3_000_000n });
    await c.connect(gateway).postRevenue(1, 20_000_000n, PROOF);
    await c.connect(tenant).dispute(1, 15_000_000n);

    // 아직 이르다
    await expect(c.connect(mediator).mediate(1, 18_000_000n)).to.be.revertedWithCustomError(c, "TooEarly");

    await jump(14 * DAY + 1);
    await expect(c.connect(mediator).mediate(1, 18_000_000n))
      .to.emit(c, "Mediated").withArgs(1, 18_000_000n, 2_240_000n);
    await expect(c.connect(gateway).settle(1)).to.emit(c, "Settled");
  });

  it("은행(게이트웨이)과 당사자는 조정인이 될 수 없다", async () => {
    const [landlord, tenant, gateway] = await ethers.getSigners();
    const F = await ethers.getContractFactory("RevenueLease");
    const c = await F.deploy(landlord.address, tenant.address, gateway.address);
    for (const bad of [gateway.address, landlord.address, tenant.address]) {
      const digest = digestOf(await c.getAddress(), T, bad);
      const sigL = await landlord.signMessage(ethers.getBytes(digest));
      const sigT = await tenant.signMessage(ethers.getBytes(digest));
      await expect(
        c.activate(T.baseRent, T.pctBps, T.floorRent, T.capRent, T.totalPeriods, T.deposit, bad, sigL, sigT)
      ).to.be.revertedWithCustomError(c, "BadTerms");
    }
  });

  it("양측이 서명하지 않은 조정인은 지정될 수 없다", async () => {
    const [landlord, tenant, gateway, , mediatorAcct] = await ethers.getSigners();
    const F = await ethers.getContractFactory("RevenueLease");
    const c = await F.deploy(landlord.address, tenant.address, gateway.address);
    // 양측은 "조정인 없음"에 서명했는데, 제출은 조정인을 끼워 넣었다
    const signed = digestOf(await c.getAddress(), T, NO_MEDIATOR);
    const sigL = await landlord.signMessage(ethers.getBytes(signed));
    const sigT = await tenant.signMessage(ethers.getBytes(signed));
    await expect(
      c.activate(T.baseRent, T.pctBps, T.floorRent, T.capRent, T.totalPeriods, T.deposit, mediatorAcct.address, sigL, sigT)
    ).to.be.revertedWithCustomError(c, "NotAuthorized");
  });
});
