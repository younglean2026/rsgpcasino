const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const CALLBACK_GAS = 50_000;

describe("RSGPCasino", () => {
  async function setup() {
    const [deployer, alice, bob, carol] = await ethers.getSigners();
    const token = await (await ethers.getContractFactory("MockRSGP")).deploy();
    const wrapper = await (await ethers.getContractFactory("MockVRFWrapper")).deploy();
    const casino = await (await ethers.getContractFactory("RSGPCasino")).deploy(
      await wrapper.getAddress(),
      await token.getAddress(),
      CALLBACK_GAS,
      ethers.parseEther("100")
    );
    const amt = ethers.parseEther("1000");
    for (const s of [alice, bob, carol]) {
      await token.mint(s.address, ethers.parseEther("100000"));
      await token.connect(s).approve(await casino.getAddress(), ethers.MaxUint256);
    }
    return { deployer, alice, bob, carol, token, wrapper, casino, amt };
  }

  it("fluxo completo: criar, entrar, VRF decide, settle paga 2x", async () => {
    const { alice, bob, carol, token, wrapper, casino, amt } = await setup();
    await casino.connect(alice).createGame(amt, 0);
    const fee = await wrapper.fee();

    const bobEthBefore = await ethers.provider.getBalance(bob.address);
    const tx = await casino.connect(bob).joinGame(0, { value: fee * 3n }); // paga a mais
    const rc = await tx.wait();
    const gasCost = rc.gasUsed * rc.gasPrice;
    // troco devolvido: só gastou fee + gás
    expect(await ethers.provider.getBalance(bob.address)).to.equal(bobEthBefore - fee - gasCost);
    expect((await casino.getGame(0)).status).to.equal(2n);

    // VRF devolve número ímpar => lado 1 (bob) ganha
    const fulfillTx = await wrapper.fulfill(1, 7, CALLBACK_GAS);
    await fulfillTx.wait();
    const g = await casino.getGame(0);
    expect(g.status).to.equal(3n);
    expect(g.winningSide).to.equal(1n);

    const before = await token.balanceOf(bob.address);
    await casino.connect(carol).settle(0); // qualquer um pode pagar
    expect(await token.balanceOf(bob.address)).to.equal(before + amt * 2n);
    expect((await casino.getGame(0)).status).to.equal(4n);
    await expect(casino.settle(0)).to.be.revertedWithCustomError(casino, "WrongStatus");
  });

  it("criador ganha quando o lado sorteado é o dele", async () => {
    const { alice, bob, token, wrapper, casino, amt } = await setup();
    await casino.connect(alice).createGame(amt, 0);
    await casino.connect(bob).joinGame(0, { value: await wrapper.fee() });
    await wrapper.fulfill(1, 42, CALLBACK_GAS);
    const before = await token.balanceOf(alice.address);
    await casino.settle(0);
    expect(await token.balanceOf(alice.address)).to.equal(before + amt * 2n);
  });

  it("callback do VRF cabe com folga no limite de gás", async () => {
    const { alice, bob, wrapper, casino, amt } = await setup();
    await casino.connect(alice).createGame(amt, 1);
    await casino.connect(bob).joinGame(0, { value: await wrapper.fee() });
    const rc = await (await wrapper.fulfill(1, 3, CALLBACK_GAS)).wait();
    console.log("      gás total do fulfill (inclui overhead do mock):", rc.gasUsed.toString());
    expect((await casino.getGame(0)).status).to.equal(3n);
  });

  it("cancelar devolve os RSGP do criador", async () => {
    const { alice, bob, token, casino, amt } = await setup();
    const before = await token.balanceOf(alice.address);
    await casino.connect(alice).createGame(amt, 0);
    await expect(casino.connect(bob).cancelGame(0)).to.be.revertedWithCustomError(casino, "NotCreator");
    await casino.connect(alice).cancelGame(0);
    expect(await token.balanceOf(alice.address)).to.equal(before);
  });

  it("bloqueia: lado inválido, valor baixo, jogar contra si mesmo, taxa baixa", async () => {
    const { alice, bob, wrapper, casino, amt } = await setup();
    await expect(casino.connect(alice).createGame(amt, 2)).to.be.revertedWithCustomError(casino, "BadSide");
    await expect(casino.connect(alice).createGame(1, 0)).to.be.revertedWithCustomError(casino, "BadAmount");
    await casino.connect(alice).createGame(amt, 0);
    await expect(casino.connect(alice).joinGame(0, { value: await wrapper.fee() })).to.be.revertedWithCustomError(
      casino,
      "SelfPlay"
    );
    await expect(casino.connect(bob).joinGame(0, { value: 1 })).to.be.revertedWithCustomError(casino, "VrfFeeTooLow");
  });

  it("refundStuck devolve os dois depois de 24h sem resposta do VRF", async () => {
    const { alice, bob, token, wrapper, casino, amt } = await setup();
    const a0 = await token.balanceOf(alice.address);
    const b0 = await token.balanceOf(bob.address);
    await casino.connect(alice).createGame(amt, 0);
    await casino.connect(bob).joinGame(0, { value: await wrapper.fee() });
    await expect(casino.refundStuck(0)).to.be.revertedWithCustomError(casino, "TooEarly");
    await time.increase(24 * 3600 + 1);
    await casino.refundStuck(0);
    expect(await token.balanceOf(alice.address)).to.equal(a0);
    expect(await token.balanceOf(bob.address)).to.equal(b0);
    // resposta atrasada do VRF é ignorada
    await wrapper.fulfill(1, 1, CALLBACK_GAS);
    expect((await casino.getGame(0)).status).to.equal(5n);
  });

  it("só o wrapper pode entregar o número aleatório", async () => {
    const { alice, bob, wrapper, casino, amt } = await setup();
    await casino.connect(alice).createGame(amt, 0);
    await casino.connect(bob).joinGame(0, { value: await wrapper.fee() });
    await expect(casino.connect(alice).rawFulfillRandomWords(1, [1])).to.be.revertedWithCustomError(
      casino,
      "OnlyVRFWrapperCanFulfill"
    );
  });

  it("getGames pagina a lista", async () => {
    const { alice, casino, amt } = await setup();
    for (let i = 0; i < 5; i++) await casino.connect(alice).createGame(amt, i % 2);
    expect(await casino.gamesCount()).to.equal(5n);
    expect((await casino.getGames(3, 10)).length).to.equal(2);
    expect((await casino.getGames(9, 10)).length).to.equal(0);
  });
});
