import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";

const AMOUNT = ethers.parseUnits("30", 18);
const INITIAL = ethers.parseUnits("100", 18);

async function deployFixture() {
  const [deployer, buyer, seller, arbiter, stranger] = await ethers.getSigners();

  // 换成你自己的代币合约名
  const token = await ethers.deployContract("HZJToken");
  // deployer 是代币的 owner，所以由它来 mint
  await token.mint(buyer.address, INITIAL);

  const escrow = await ethers.deployContract("Escrow", [arbiter.address]);
  const deadline = (await time.latest()) + 3600;

  return { token, escrow, deployer, buyer, seller, arbiter, stranger, deadline };
}

// 复用：已创建并付款的订单（id = 0）
async function paidOrderFixture() {
  const base = await deployFixture();
  const { token, escrow, buyer, seller, deadline } = base;

  await escrow.connect(buyer).createOrder(seller.address, await token.getAddress(), AMOUNT, deadline, "一本书");
  await token.connect(buyer).approve(await escrow.getAddress(), AMOUNT);
  await escrow.connect(buyer).deposit(0);

  return base;
}

describe("Escrow", function () {
  it("createOrder 记录订单并发出事件", async function () {
    const { token, escrow, buyer, seller, deadline } = await loadFixture(deployFixture);

    await expect(
      escrow.connect(buyer).createOrder(seller.address, await token.getAddress(), AMOUNT, deadline, "一本书"),
    )
      .to.emit(escrow, "OrderCreated")
      .withArgs(0, buyer.address, seller.address, await token.getAddress(), AMOUNT, deadline);

    const order = await escrow.getOrder(0);
    expect(order.buyer).to.equal(buyer.address);
    expect(Number(order.status)).to.equal(0); // Created
    expect(Number(await escrow.orderCount())).to.equal(1);
  });

  it("未 approve 时 deposit 失败", async function () {
    const { token, escrow, buyer, seller, deadline } = await loadFixture(deployFixture);

    await escrow.connect(buyer).createOrder(seller.address, await token.getAddress(), AMOUNT, deadline, "一本书");

    // 换成你自己代币合约里的报错文字
    await expect(escrow.connect(buyer).deposit(0)).to.be.revertedWith("HZJToken: transfer amount exceeds allowance");
  });

  it("approve 后 deposit 成功，代币进入 Escrow，状态变为 Paid", async function () {
    const { token, escrow, buyer, seller, deadline } = await loadFixture(deployFixture);

    await escrow.connect(buyer).createOrder(seller.address, await token.getAddress(), AMOUNT, deadline, "一本书");

    await token.connect(buyer).approve(await escrow.getAddress(), AMOUNT);

    await expect(escrow.connect(buyer).deposit(0)).to.emit(escrow, "OrderPaid").withArgs(0);

    const order = await escrow.getOrder(0);
    expect(Number(order.status)).to.equal(1); // Paid
    expect(await token.balanceOf(await escrow.getAddress())).to.equal(AMOUNT);
    expect(await token.balanceOf(buyer.address)).to.equal(INITIAL - AMOUNT);
  });

  it("非买家调用 confirm 失败", async function () {
    const { escrow, seller, stranger } = await loadFixture(paidOrderFixture);

    await expect(escrow.connect(seller).confirm(0)).to.be.revertedWith("Escrow: caller is not the buyer");

    await expect(escrow.connect(stranger).confirm(0)).to.be.revertedWith("Escrow: caller is not the buyer");
  });

  it("confirm 后卖家收到代币，状态变为 Completed", async function () {
    const { token, escrow, buyer, seller } = await loadFixture(paidOrderFixture);

    await expect(escrow.connect(buyer).confirm(0)).to.emit(escrow, "OrderCompleted").withArgs(0);

    const order = await escrow.getOrder(0);
    expect(Number(order.status)).to.equal(2); // Completed
    expect(await token.balanceOf(seller.address)).to.equal(AMOUNT);
    expect(await token.balanceOf(await escrow.getAddress())).to.equal(0n);
  });

  it("deadline 之前 refund 失败，deadline 之后 refund 成功并退回买家", async function () {
    const { token, escrow, buyer, deadline } = await loadFixture(paidOrderFixture);

    await expect(escrow.connect(buyer).refund(0)).to.be.revertedWith("Escrow: deadline not reached");

    // 把链上时间拨到 deadline 之后
    await time.increaseTo(deadline + 1);

    await expect(escrow.connect(buyer).refund(0)).to.emit(escrow, "OrderRefunded").withArgs(0);

    const order = await escrow.getOrder(0);
    expect(Number(order.status)).to.equal(3); // Refunded
    expect(await token.balanceOf(buyer.address)).to.equal(INITIAL);
    expect(await token.balanceOf(await escrow.getAddress())).to.equal(0n);
  });

  it("非仲裁人调用 resolve 失败", async function () {
    const { escrow, buyer, seller, stranger } = await loadFixture(paidOrderFixture);

    // 先让卖家发起争议，订单进入 Disputed
    await escrow.connect(seller).dispute(0);

    await expect(escrow.connect(buyer).resolve(0, true)).to.be.revertedWith("Escrow: caller is not the arbiter");

    await expect(escrow.connect(stranger).resolve(0, true)).to.be.revertedWith("Escrow: caller is not the arbiter");
  });

  it("dispute 后仲裁人 resolve(false) 退款给买家，状态变为 Refunded", async function () {
    const { token, escrow, buyer, seller, arbiter } = await loadFixture(paidOrderFixture);

    await expect(escrow.connect(seller).dispute(0)).to.emit(escrow, "OrderDisputed").withArgs(0, seller.address);

    expect(Number((await escrow.getOrder(0)).status)).to.equal(4); // Disputed
    expect(await token.balanceOf(await escrow.getAddress())).to.equal(AMOUNT);

    await expect(escrow.connect(arbiter).resolve(0, false)).to.emit(escrow, "OrderResolved").withArgs(0, false);

    const order = await escrow.getOrder(0);
    expect(Number(order.status)).to.equal(3); // Refunded
    expect(await token.balanceOf(buyer.address)).to.equal(INITIAL);
    expect(await token.balanceOf(seller.address)).to.equal(0n);
    expect(await token.balanceOf(await escrow.getAddress())).to.equal(0n);
  });
});
