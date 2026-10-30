require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config();

const PK = process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [];

module.exports = {
  solidity: {
    version: "0.8.24",
    settings: { optimizer: { enabled: true, runs: 1000 }, evmVersion: "cancun" },
  },
  networks: {
    base: {
      url: process.env.BASE_RPC_URL || "https://mainnet.base.org",
      chainId: 8453,
      accounts: PK,
    },
    baseSepolia: {
      url: process.env.BASE_SEPOLIA_RPC_URL || "https://sepolia.base.org",
      chainId: 84532,
      accounts: PK,
    },
  },
  etherscan: {
    // Uma única chave do Etherscan (v2) serve pro Basescan também
    apiKey: process.env.ETHERSCAN_API_KEY || "",
  },
  sourcify: { enabled: false },
};
