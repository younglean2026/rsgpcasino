// Copia o ABI do contrato compilado para o site (site/src/abi.js).
const fs = require("fs");
const path = require("path");

const artifact = require("../artifacts/contracts/RSGPCasino.sol/RSGPCasino.json");
const target = path.join(__dirname, "..", "..", "site", "src", "abi.js");

const src = fs.readFileSync(target, "utf8");
const start = src.indexOf("export const CASINO_ABI = ");
const end = src.indexOf("];\n", start) + 3;
const updated =
  src.slice(0, start) + "export const CASINO_ABI = " + JSON.stringify(artifact.abi, null, 2) + ";\n" + src.slice(end);

fs.writeFileSync(target, updated);
fs.writeFileSync(path.join(__dirname, "..", "abi.json"), JSON.stringify(artifact.abi, null, 1));
console.log("ABI atualizado em", target);
