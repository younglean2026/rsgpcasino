# RSGP CASINO

Apostas PvP 1x1 em **$RSGP** na **Base**. Um jogador abre a aposta escolhendo valor e lado (CITIZEN ou VICEROYS), outro entra no lado oposto com o mesmo valor, o **Chainlink VRF v2.5** sorteia o lado vencedor e quem ganhar leva **100% do pote**.

```
rsgp-casino/
├── contracts/          ← contrato Solidity (Hardhat)
│   ├── contracts/RSGPCasino.sol
│   ├── test/           ← 8 testes automatizados
│   ├── scripts/deploy.js
│   └── .env.example
└── site/               ← site (Vite + viem), conexão com Rabby
    ├── src/config.js   ← ÚNICO arquivo que você precisa editar
    ├── src/main.js
    ├── src/style.css
    └── public/rsgp.png
```

---

## Quanto custa pra você

**Só o deploy do contrato** (centavos na Base). Mais nada:

- **Sem taxa da casa.** O vencedor recebe 2x o valor apostado.
- **Sem assinatura de VRF pra manter.** O contrato usa o modo *direct funding*: quem **entra** na aposta paga a taxa do VRF em ETH na própria transação (na Base fica na casa de centavos). O excesso enviado volta pra carteira na mesma transação.
- **VRF no modo mais barato possível:** pede 1 único número, com 1 confirmação, e o callback só grava o resultado (limite de 50.000 de gás). O pagamento do prêmio é feito numa transação separada (`settle`), clicando em "Claim" no site.
- **Sem dono no contrato.** Ninguém, nem você, consegue mexer nos fundos. Se o VRF não responder em 24h, qualquer um pode reembolsar os dois jogadores.

---

## 1. Pré-requisitos

1. **Node.js 20 ou mais novo** → https://nodejs.org (versão LTS).
2. **VS Code** com o terminal integrado (`Ctrl + '`).
3. **Uma carteira NOVA só pra deploy** (crie uma conta nova na Rabby e exporte a chave privada). Nunca use a chave da sua carteira principal.
4. **Um pouco de ETH na Base** nessa carteira (US$ 1–2 sobra pro deploy).
   Pra testar antes, pegue ETH de teste da **Base Sepolia** num faucet (ex.: https://www.alchemy.com/faucets/base-sepolia).

Abra a pasta `rsgp-casino` no VS Code (Arquivo → Abrir Pasta).

---

## 2. Testar o contrato no seu PC

```bash
cd contracts
npm install
npm test
```

Deve aparecer **8 passing**.

---

## 3. Deploy na testnet (recomendado antes)

```bash
cd contracts
cp .env.example .env      # no Windows: copy .env.example .env
```

Abra o `.env` e cole a chave privada da carteira de deploy em `PRIVATE_KEY`. Depois:

```bash
npm run deploy:testnet
```

Na testnet não existe RSGP, então o script cria um **RSGP de teste** e manda 10 milhões pra você. No final ele imprime algo assim:

```
✅ RSGPCasino: 0xABC...
Cole no site (site/src/config.js):
   CASINO_ADDRESS: "0xABC..."
   TOKEN_ADDRESS:  "0xDEF..."
```

Guarde esses dois endereços.

---

## 4. Rodar o site

Abra `site/src/config.js` e preencha:

```js
NETWORK: "baseSepolia",            // na testnet
CASINO_ADDRESS: "0xABC...",        // do passo anterior
TOKEN_ADDRESS: "0xDEF...",         // na testnet, o RSGP de teste
```

Depois:

```bash
cd site
npm install
npm run dev
```

Abra **http://localhost:5173** no navegador com a extensão da Rabby. Pra testar uma aposta inteira você precisa de **duas carteiras** (uma abre, a outra entra). Mande RSGP de teste da carteira de deploy pra uma segunda conta da Rabby.

> **No celular:** o comando `npm run dev` mostra também um endereço "Network" (ex.: `http://192.168.0.10:5173`). Com o celular no mesmo Wi-Fi, abra esse endereço **dentro do navegador do app da Rabby**.

---

## 5. Deploy de verdade (Base mainnet)

1. No `contracts/.env`, mantenha a mesma `PRIVATE_KEY` (com ETH na Base mainnet).
2. Rode:
   ```bash
   cd contracts
   npm run deploy:base
   ```
   Na mainnet o script já usa o **$RSGP oficial** (`0x44B63aF715D5ef02CC3646a6CE96875e11d69E85`) e o **VRF Wrapper oficial da Chainlink na Base** (`0xb0407dbe851f8318bd31404A49e658143C982F23`).
3. No `site/src/config.js`:
   ```js
   NETWORK: "base",
   CASINO_ADDRESS: "0x...",   // o novo endereço
   TOKEN_ADDRESS: "0x44B63aF715D5ef02CC3646a6CE96875e11d69E85",
   RPC_URL: "",               // recomendo colar um RPC grátis da Alchemy/QuickNode aqui
   ```
4. **(Opcional, mas passa confiança)** Verifique o código no Basescan: crie uma API key grátis em etherscan.io, coloque em `ETHERSCAN_API_KEY` no `.env` e rode o comando `npx hardhat verify ...` que o script de deploy imprimiu.

Opções do deploy (no `.env`):
- `MIN_BET=100` → aposta mínima em RSGP (evita spam de apostas minúsculas).
- `CALLBACK_GAS_LIMIT=50000` → não precisa mexer. O callback usa ~15–20 mil de gás; 50 mil dá margem de segurança.

---

## 6. Colocar o site no ar (grátis)

```bash
cd site
npm run build
```

Isso gera a pasta `site/dist`. Qualquer hospedagem estática serve:

- **Vercel** (mais fácil): crie conta → "Add New Project" → importe a pasta `site` (ou suba pro GitHub) → Framework: *Vite* → Deploy.
- **Netlify**: arraste a pasta `dist` em https://app.netlify.com/drop.
- **Cloudflare Pages**: build command `npm run build`, output `dist`.

Como não tem backend, você não paga servidor.

---

## Personalizar

Tudo em `site/src/config.js`:

| Opção | O que faz |
|---|---|
| `SIDES` | Nomes e frase de cada lado. O contrato só conhece "lado 0" e "lado 1". |
| `QUICK_AMOUNTS` | Botões de valor rápido no formulário. |
| `GAMES_TO_LOAD` | Quantas apostas recentes o site lê. |
| `VRF_FEE_BUFFER` | Folga na taxa do VRF (o que sobra volta pra carteira). |

Cores e fontes ficam no topo de `site/src/style.css` (`:root`). Os textos do site estão em inglês pra comunidade gringa; dá pra trocar direto no `index.html` e no `main.js`.

---

## Como o contrato funciona

| Função | Quem chama | O que faz |
|---|---|---|
| `createGame(valor, lado)` | Quem abre | Deposita os RSGP e abre a aposta. |
| `cancelGame(id)` | Só quem abriu | Cancela antes de alguém entrar e devolve os RSGP. |
| `joinGame(id)` + ETH | Quem entra | Deposita o mesmo valor no lado oposto e paga o VRF. |
| *(Chainlink)* | VRF | Sorteia o lado: número aleatório par = lado 0, ímpar = lado 1. |
| `settle(id)` | Qualquer um | Paga 2x o valor ao vencedor. |
| `refundStuck(id)` | Qualquer um | Se o VRF não responder em 24h, devolve os dois. |

O site sempre faz duas transações quando falta aprovação do token: **Approve** (libera só o valor exato da aposta) e depois a ação.

---

## Segurança e avisos

- O contrato foi testado (8 testes, incluindo reembolso e proteção contra chamadas falsas do VRF), mas **não passou por auditoria profissional**. Comece com apostas pequenas.
- Use sempre uma carteira separada pro deploy e **nunca** suba o arquivo `.env` pra internet (ele já está no `.gitignore`).
- O site diz no rodapé que é **feito pela comunidade, sem ligação com o Cambria**. Mantenha isso: usar o nome ou a marca deles como se fosse oficial pode te trazer problema com o time.
- Apostas com dinheiro são reguladas em muitos países, inclusive no Brasil. Veja se é permitido onde você e seus jogadores estão antes de divulgar.
