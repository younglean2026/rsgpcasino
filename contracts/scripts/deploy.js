// Deploy do RSGPCasino.
//   npx hardhat run scripts/deploy.js --network baseSepolia   (teste)
//   npx hardhat run scripts/deploy.js --network base          (produção)
const { ethers, network } = require("hardhat");

// Endereços oficiais do Chainlink VRF v2.5 "Direct funding" (docs.chain.link/vrf/v2-5/supported-networks)
const WRAPPERS = {
  base: "0xb0407dbe851f8318bd31404A49e658143C982F23",
  baseSepolia: "0x7a1BaC17Ccc5b313516C5E16fb24f7659aA5ebed",
};

// Token $RSGP na Base
const RSGP_BASE = "0x44B63aF715D5ef02CC3646a6CE96875e11d69E85";

async function main() {
  const wrapper = WRAPPERS[network.name];
  if (!wrapper) throw new Error(`Rede não suportada: ${network.name}`);

  // Na Base Sepolia não existe RSGP: informe um token de teste em TEST_TOKEN (ou o script cria um).
  let token = network.name === "base" ? RSGP_BASE : process.env.TEST_TOKEN;
  if (!token) {
    console.log("Sem TEST_TOKEN: criando um RSGP de teste (MockRSGP) na testnet...");
    const mock = await (await ethers.getContractFactory("MockRSGP")).deploy();
    await mock.waitForDeployment();
    token = await mock.getAddress();
    const [me] = await ethers.getSigners();
    await (await mock.mint(me.address, ethers.parseEther("10000000"))).wait();
    console.log("MockRSGP:", token, "(10M mintados pra você; qualquer um pode chamar mint)");
  }

  const callbackGas = Number(process.env.CALLBACK_GAS_LIMIT || 50000);
  const minBet = ethers.parseEther(process.env.MIN_BET || "100");

  const Casino = await ethers.getContractFactory("RSGPCasino");
  const casino = await Casino.deploy(wrapper, token, callbackGas, minBet);
  await casino.waitForDeployment();
  const addr = await casino.getAddress();

  console.log("\n✅ RSGPCasino:", addr);
  console.log("   rede:", network.name, "| token:", token, "| callbackGas:", callbackGas, "| aposta mínima:", process.env.MIN_BET || "100");
  console.log("\nCole no site (site/src/config.js):");
  console.log(`   CASINO_ADDRESS: "${addr}"`);
  console.log(`   TOKEN_ADDRESS:  "${token}"`);
  console.log("\nVerificar no Basescan (opcional):");
  console.log(`   npx hardhat verify --network ${network.name} ${addr} ${wrapper} ${token} ${callbackGas} ${minBet}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
