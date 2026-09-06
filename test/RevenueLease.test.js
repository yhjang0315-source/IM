const { expect } = require("chai");
const { ethers } = require("hardhat");

// 프로토타입 단위: 1 wei = 1 원
const T = {
  baseRent: 800_000n,      // 기본료 80만
  pctBps: 800,             // 매출 8%
  floorRent: 1_500_000n,   // 하한 150만
  capRent: 3_500_000n,     // 상한 350만
  totalPeriods: 12,
};

async function deployAndActivate() {
  const [landlord, tenant, gateway, outsider] = await ethers.getSigners();
  const F = await ethers.getContractFactory("RevenueLease");
  const c = await F.deploy(landlord.address, tenant.address, gateway.address);
  await c.waitForDeployment();

  const digest = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["address", "uint256", "uint16", "uint256", "uint256", "uint16"],
      [await c.getAddress(), T.baseRent, T.pctBps, T.floorRent, T.capRent, T.totalPeriods]
    )
  );
  const sigL = await landlord.signMessage(ethers.getBytes(digest));
  const sigT = await tenant.signMessage(ethers.getBytes(digest));
  await c.activate(T.baseRent, T.pctBps, T.floorRent, T.capRent, T.totalPeriods, sigL, sigT);
  return { c, landlord, tenant, gateway, outsider };
}

describe("RevenueLease", function () {
  it("양측 서명이 있어야만 조건이 확정된다", async () => {
    const [landlord, tenant, gateway, outsider] = await ethers.getSigners();
    const F = await ethers.getContractFactory("RevenueLease");
    const c = await F.deploy(landlord.address, tenant.address, gateway.address);
    const digest = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ["address", "uint256", "uint16", "uint256", "uint256", "uint16"],
        [await c.getAddress(), T.baseRent, T.pctBps, T.floorRent, T.capRent, T.totalPeriods]
      )
    );
    const sigL = await landlord.signMessage(ethers.getBytes(digest));
    const sigBad = await outsider.signMessage(ethers.getBytes(digest));
    await expect(
      c.activate(T.baseRent, T.pctBps, T.floorRent, T.capRent, T.totalPeriods, sigL, sigBad)
    ).to.be.revertedWithCustomError(c, "NotAuthorized");
  });

  it("확정된 조건은 두 번 활성화할 수 없다 (변경 함수 자체가 없음)", async () => {
    const { c, landlord, tenant } = await deployAndActivate();
    const digest = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ["address", "uint256", "uint16", "uint256", "uint256", "uint16"],
        [await c.getAddress(), 5_000_000n, T.pctBps, T.floorRent, T.capRent, T.totalPeriods]
      )
    );
    const sigL = await landlord.signMessage(ethers.getBytes(digest));
    const sigT = await tenant.signMessage(ethers.getBytes(digest));
    await expect(
      c.activate(5_000_000n, T.pctBps, T.floorRent, T.capRent, T.totalPeriods, sigL, sigT)
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
    await expect(c.connect(tenant).postRevenue(1, 1n)).to.be.revertedWithCustomError(c, "NotAuthorized");
    await expect(c.connect(landlord).postRevenue(1, 1n)).to.be.revertedWithCustomError(c, "NotAuthorized");
    await expect(c.connect(gateway).postRevenue(1, 20_000_000n)).to.emit(c, "RevenuePosted");
  });

  it("정산: 임대료는 임대인에게, 남은 예치금은 임차인에게 돌아간다", async () => {
    const { c, landlord, tenant, gateway } = await deployAndActivate();
    await c.connect(tenant).fund(1, { value: 3_000_000n });
    await c.connect(gateway).postRevenue(1, 20_000_000n); // rent 240만

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
    await c.connect(gateway).postRevenue(2, 20_000_000n); // rent 240만
    await c.connect(gateway).settle(2);
    const p = await c.periodOf(2);
    expect(p.paid).to.equal(1_000_000n);
    expect(p.arrears).to.equal(1_400_000n);
  });

  it("이의가 걸리면 정산이 멈추고, 양측 합의로만 풀린다", async () => {
    const { c, landlord, tenant, gateway } = await deployAndActivate();
    await c.connect(tenant).fund(3, { value: 3_000_000n });
    await c.connect(gateway).postRevenue(3, 20_000_000n);

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
    await c.connect(gateway).postRevenue(4, 20_000_000n);
    await expect(c.connect(outsider).dispute(4, 1n)).to.be.revertedWithCustomError(c, "NotAuthorized");
  });
});
