import {
  createPublicClient,
  createWalletClient,
  custom,
  http,
  formatUnits,
  parseUnits,
  formatEther,
  BaseError,
  ContractFunctionRevertedError,
  UserRejectedRequestError,
  zeroAddress,
} from "viem";
import { base, baseSepolia } from "viem/chains";
import { CONFIG } from "./config.js";
import { CASINO_ABI, ERC20_ABI } from "./abi.js";

// ───────────────────────── setup ─────────────────────────
const CHAIN = CONFIG.NETWORK === "base" ? base : baseSepolia;
const EXPLORER = CHAIN.blockExplorers.default.url;
const CASINO = CONFIG.CASINO_ADDRESS;
const TOKEN = CONFIG.TOKEN_ADDRESS;
const CONFIGURED = CASINO && CASINO !== zeroAddress;

const STATUS = { NONE: 0, OPEN: 1, ROLLING: 2, DECIDED: 3, PAID: 4, CANCELLED: 5 };
const STUCK_SECONDS = 24 * 3600;

const publicClient = createPublicClient({ chain: CHAIN, transport: http(CONFIG.RPC_URL || undefined) });

const state = {
  provider: null,
  wallet: null,
  account: null,
  decimals: 18,
  minBet: 0n,
  games: [], // { id, creator, amount, joiner, creatorSide, status, winningSide, updatedAt }
  seen: new Map(), // id -> status (para disparar a revelação)
  watchingId: null, // aposta que o overlay está acompanhando
  balance: 0n,
  busy: false,
};

const $ = (id) => document.getElementById(id);
const sideName = (s) => CONFIG.SIDES[Number(s)].name;
const sideClass = (s) => CONFIG.SIDES[Number(s)].className;
const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "");
const same = (a, b) => a && b && a.toLowerCase() === b.toLowerCase();
const fmt = (v, max = 2) =>
  Number(formatUnits(v, state.decimals)).toLocaleString("en-US", { maximumFractionDigits: max });
const fmtEth = (v) => {
  const n = Number(formatEther(v));
  return n === 0 ? "0" : n < 0.000001 ? "<0.000001" : n.toLocaleString("en-US", { maximumSignificantDigits: 3 });
};

// ───────────────────────── carteira (EIP-6963, prioriza Rabby) ─────────────────────────
const announced = new Map();
window.addEventListener("eip6963:announceProvider", (e) => {
  announced.set(e.detail.info.rdns, e.detail);
  refreshConnectLabel();
});
window.dispatchEvent(new Event("eip6963:requestProvider"));

function pickProvider() {
  return announced.get("io.rabby")?.provider || [...announced.values()][0]?.provider || window.ethereum || null;
}

function refreshConnectLabel() {
  const btn = $("connectBtn");
  if (state.account) {
    btn.textContent = short(state.account);
    btn.classList.add("is-connected");
    return;
  }
  btn.classList.remove("is-connected");
  btn.textContent = announced.has("io.rabby") || window.ethereum?.isRabby ? "Connect Rabby" : "Connect wallet";
}

async function connect(silent = false) {
  const provider = pickProvider();
  if (!provider) {
    if (!silent)
      toast(
        "No wallet found. On desktop install the Rabby extension. On mobile, open this page inside the Rabby app's browser.",
        "error",
        9000
      );
    return;
  }
  try {
    const accounts = await provider.request({ method: silent ? "eth_accounts" : "eth_requestAccounts" });
    if (!accounts?.length) return;
    state.provider = provider;
    state.account = accounts[0];
    state.wallet = createWalletClient({ chain: CHAIN, transport: custom(provider), account: state.account });
    if (!state._listening && provider.on) {
      provider.on("accountsChanged", (a) => {
        state.account = a[0] || null;
        if (state.account)
          state.wallet = createWalletClient({ chain: CHAIN, transport: custom(provider), account: state.account });
        state.seen.clear();
        refreshConnectLabel();
        refresh();
      });
      provider.on("chainChanged", () => refreshNetTag());
      state._listening = true;
    }
    refreshConnectLabel();
    await refreshNetTag();
    await refresh();
  } catch (e) {
    if (!silent) toast(niceError(e), "error");
  }
}

async function currentChainId() {
  if (!state.provider) return null;
  return parseInt(await state.provider.request({ method: "eth_chainId" }), 16);
}

async function refreshNetTag() {
  const tag = $("netTag");
  const id = await currentChainId();
  if (id == null) return (tag.hidden = true);
  tag.hidden = false;
  if (id === CHAIN.id) {
    tag.textContent = CHAIN.name;
    tag.classList.remove("wrong");
  } else {
    tag.textContent = `Switch to ${CHAIN.name}`;
    tag.classList.add("wrong");
  }
}

async function ensureChain() {
  if ((await currentChainId()) === CHAIN.id) return;
  const hex = "0x" + CHAIN.id.toString(16);
  try {
    await state.provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hex }] });
  } catch (e) {
    if (e?.code === 4902) {
      await state.provider.request({
        method: "wallet_addEthereumChain",
        params: [
          {
            chainId: hex,
            chainName: CHAIN.name,
            nativeCurrency: CHAIN.nativeCurrency,
            rpcUrls: CHAIN.rpcUrls.default.http,
            blockExplorerUrls: [EXPLORER],
          },
        ],
      });
    } else throw e;
  }
  await refreshNetTag();
}

// ───────────────────────── leitura on-chain ─────────────────────────
async function loadStatic() {
  if (!CONFIGURED) return;
  try {
    const [dec, minBet] = await Promise.all([
      publicClient.readContract({ address: TOKEN, abi: ERC20_ABI, functionName: "decimals" }),
      publicClient.readContract({ address: CASINO, abi: CASINO_ABI, functionName: "minBet" }),
    ]);
    state.decimals = Number(dec);
    state.minBet = minBet;
    $("createHint").textContent = `Minimum ${fmt(minBet)} RSGP. Your RSGP stays in the contract until someone takes the other side. Cancel any time before that.`;
  } catch (e) {
    console.error(e);
  }
}

async function loadGames() {
  const count = await publicClient.readContract({ address: CASINO, abi: CASINO_ABI, functionName: "gamesCount" });
  const n = Number(count);
  const start = Math.max(0, n - CONFIG.GAMES_TO_LOAD);
  if (n === 0) return [];
  const raw = await publicClient.readContract({
    address: CASINO,
    abi: CASINO_ABI,
    functionName: "getGames",
    args: [BigInt(start), BigInt(n - start)],
  });
  return raw.map((g, i) => ({
    id: start + i,
    creator: g.creator,
    amount: g.amount,
    joiner: g.joiner,
    creatorSide: Number(g.creatorSide),
    status: Number(g.status),
    winningSide: Number(g.winningSide),
    updatedAt: Number(g.updatedAt),
  }));
}

async function quoteFee() {
  const gasPrice = await publicClient.getGasPrice();
  const quoted = await publicClient.readContract({
    address: CASINO,
    abi: CASINO_ABI,
    functionName: "quoteVrfFee",
    args: [(gasPrice * 3n) / 2n],
  });
  return quoted;
}

let refreshing = false;
async function refresh() {
  if (!CONFIGURED || refreshing) return;
  refreshing = true;
  try {
    const [games, fee] = await Promise.all([loadGames(), quoteFee().catch(() => null)]);
    state.games = games;
    if (fee != null) $("vrfFee").textContent = `~${fmtEth(fee)} ETH`;

    if (state.account) {
      const [bal, eth] = await Promise.all([
        publicClient.readContract({ address: TOKEN, abi: ERC20_ABI, functionName: "balanceOf", args: [state.account] }),
        publicClient.getBalance({ address: state.account }),
      ]);
      state.balance = bal;
      $("meAddr").innerHTML = `<a href="${EXPLORER}/address/${state.account}" target="_blank" rel="noopener">${short(state.account)}</a>`;
      $("meRsgp").textContent = fmt(bal);
      $("meEth").textContent = fmtEth(eth);
    }
    render();
    detectReveals();
  } catch (e) {
    console.error(e);
  } finally {
    refreshing = false;
  }
}

// ───────────────────────── render ─────────────────────────
function winnerOf(g) {
  return g.winningSide === g.creatorSide ? g.creator : g.joiner;
}

function render() {
  const now = Math.floor(Date.now() / 1000);
  const me = state.account;
  const open = state.games.filter((g) => g.status === STATUS.OPEN).reverse();
  const mine = me ? state.games.filter((g) => same(g.creator, me) || same(g.joiner, me)).reverse() : [];
  const done = state.games.filter((g) => g.status === STATUS.DECIDED || g.status === STATUS.PAID).reverse();

  // placar do quadro
  const wins = [0, 0];
  done.forEach((g) => wins[g.winningSide]++);
  $("wins0").textContent = wins[0];
  $("wins1").textContent = wins[1];
  $("winsLabel0").textContent = wins[0] === 1 ? "win" : "wins";
  $("winsLabel1").textContent = wins[1] === 1 ? "win" : "wins";
  const pot = state.games
    .filter((g) => g.status === STATUS.OPEN || g.status === STATUS.ROLLING || g.status === STATUS.DECIDED)
    .reduce((s, g) => s + g.amount * (g.status === STATUS.OPEN ? 1n : 2n), 0n);
  $("potTotal").textContent = fmt(pot, 0);

  // recorde do usuário
  if (me) {
    let w = 0,
      l = 0;
    mine.forEach((g) => {
      if (g.status === STATUS.DECIDED || g.status === STATUS.PAID) same(winnerOf(g), me) ? w++ : l++;
    });
    $("meRecord").textContent = `${w} won, ${l} lost`;
  }

  // apostas abertas
  $("openList").innerHTML = open.length
    ? open.map((g, i) => openCard(g, i)).join("")
    : `<p class="empty">No open bets. Open the first one and wait for someone brave enough.</p>`;

  // suas apostas
  $("mineList").innerHTML = !me
    ? `<p class="empty">Connect your wallet to see your bets.</p>`
    : mine.length
      ? mine.map((g, i) => myCard(g, i, now)).join("")
      : `<p class="empty">You haven't bet yet. Open one above or take an open bet.</p>`;

  // feed
  $("feedList").innerHTML = done.length
    ? done
        .slice(0, 15)
        .map(
          (g) => `<li>
          <span class="feed-side ${sideClass(g.winningSide)}">${sideName(g.winningSide)}</span>
          <span><span class="addr">${short(winnerOf(g))}</span> took <b>${fmt(g.amount * 2n, 0)}</b> RSGP</span>
          <span class="feed-id">#${g.id}</span></li>`
        )
        .join("")
    : `<li class="empty">No flips yet.</li>`;
}

const tilt = (i) => [-1.6, 1.2, -0.6, 1.8, -1.1, 0.7][i % 6];

function openCard(g, i) {
  const mineFlag = same(g.creator, state.account);
  const other = 1 - g.creatorSide;
  return `<article class="card" style="--tilt:${tilt(i)}deg">
    <span class="pin"></span>
    <header><span class="card-id">#${g.id}</span><span class="card-amt">${fmt(g.amount, 0)} <small>RSGP</small></span></header>
    <p class="card-vs"><span class="chip ${sideClass(g.creatorSide)}">${sideName(g.creatorSide)}</span> by <span class="addr">${short(g.creator)}</span></p>
    <p class="card-pot">Pot: ${fmt(g.amount * 2n, 0)} RSGP</p>
    ${
      mineFlag
        ? `<button class="btn btn-ghost" data-act="cancel" data-id="${g.id}">Cancel bet</button>`
        : `<button class="btn btn-take ${sideClass(other)}" data-act="join" data-id="${g.id}">Take ${sideName(other)}</button>`
    }
  </article>`;
}

function myCard(g, i, now) {
  const me = state.account;
  const mySide = same(g.creator, me) ? g.creatorSide : 1 - g.creatorSide;
  let status = "",
    action = "";
  switch (g.status) {
    case STATUS.OPEN:
      status = "Waiting for someone to take it";
      action = `<button class="btn btn-ghost" data-act="cancel" data-id="${g.id}">Cancel bet</button>`;
      break;
    case STATUS.ROLLING:
      status = "Chainlink is drawing the side…";
      if (now - g.updatedAt > STUCK_SECONDS)
        action = `<button class="btn btn-ghost" data-act="refund" data-id="${g.id}">Refund both</button>`;
      break;
    case STATUS.DECIDED:
      if (same(winnerOf(g), me)) {
        status = `${sideName(g.winningSide)} won. You won.`;
        action = `<button class="btn btn-primary" data-act="settle" data-id="${g.id}">Claim ${fmt(g.amount * 2n, 0)} RSGP</button>`;
      } else status = `${sideName(g.winningSide)} won. You lost.`;
      break;
    case STATUS.PAID:
      status = same(winnerOf(g), me) ? "Won and claimed" : `${sideName(g.winningSide)} won. You lost.`;
      break;
    case STATUS.CANCELLED:
      status = "Cancelled, RSGP returned";
      break;
  }
  const result =
    g.status === STATUS.DECIDED || g.status === STATUS.PAID
      ? same(winnerOf(g), me)
        ? `<span class="verdict win">WIN</span>`
        : `<span class="verdict lose">LOST</span>`
      : "";
  return `<article class="card ${g.status === STATUS.CANCELLED ? "is-dim" : ""}" style="--tilt:${tilt(i + 2)}deg">
    <span class="pin"></span>${result}
    <header><span class="card-id">#${g.id}</span><span class="card-amt">${fmt(g.amount, 0)} <small>RSGP</small></span></header>
    <p class="card-vs">You: <span class="chip ${sideClass(mySide)}">${sideName(mySide)}</span></p>
    <p class="card-status">${status}</p>
    ${action}
  </article>`;
}

// ───────────────────────── revelação ─────────────────────────
function detectReveals() {
  const me = state.account;
  for (const g of state.games) {
    if (!me || !(same(g.creator, me) || same(g.joiner, me))) continue;
    const prev = state.seen.get(g.id);
    state.seen.set(g.id, g.status);
    if (prev === undefined) continue; // primeira carga: não anima
    if (prev !== g.status && g.status === STATUS.ROLLING && state.watchingId == null) showRolling(g.id);
    if ((prev === STATUS.ROLLING || prev === STATUS.OPEN) && g.status === STATUS.DECIDED) showResult(g);
  }
  if (state.watchingId != null) {
    const g = state.games.find((x) => x.id === state.watchingId);
    if (g && g.status >= STATUS.DECIDED) showResult(g);
  }
}

function showRolling(id) {
  state.watchingId = id;
  const ov = $("flipOverlay");
  ov.hidden = false;
  ov.dataset.state = "rolling";
  $("flipCoin").className = "coin coin-spin";
  $("flipTitle").textContent = "The VRF is deciding…";
  $("flipText").textContent = `Bet #${id}: waiting for Chainlink to deliver the random number. Usually under a minute.`;
  $("flipAction").hidden = true;
}

function showResult(g) {
  state.watchingId = null;
  const won = same(winnerOf(g), state.account);
  const ov = $("flipOverlay");
  ov.hidden = false;
  ov.dataset.state = won ? "win" : "lose";
  $("flipCoin").className = `coin coin-land ${sideClass(g.winningSide)}`;
  $("flipTitle").textContent = `${sideName(g.winningSide)}.`;
  if (won) {
    $("flipText").textContent = `You won ${fmt(g.amount * 2n, 0)} RSGP on bet #${g.id}.`;
    const btn = $("flipAction");
    btn.hidden = g.status !== STATUS.DECIDED;
    btn.textContent = `Claim ${fmt(g.amount * 2n, 0)} RSGP`;
    btn.dataset.id = g.id;
  } else {
    $("flipText").textContent = `The coin chose the other side. You lost ${fmt(g.amount, 0)} RSGP on bet #${g.id}.`;
    $("flipAction").hidden = true;
  }
}

$("flipClose").onclick = () => {
  $("flipOverlay").hidden = true;
  state.watchingId = null;
};
$("flipAction").onclick = (e) => act("settle", Number(e.currentTarget.dataset.id));

// ───────────────────────── escrita ─────────────────────────
async function send(label, request) {
  const hash = await state.wallet.writeContract(request);
  toast(`${label}: sent. Waiting for confirmation…`, "info", 60000, hash);
  const rc = await publicClient.waitForTransactionReceipt({ hash });
  if (rc.status !== "success") throw new Error(`${label} failed on-chain.`);
  return rc;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const readAllowance = () =>
  publicClient.readContract({
    address: TOKEN,
    abi: ERC20_ABI,
    functionName: "allowance",
    args: [state.account, CASINO],
  });

// O RPC público da Base reparte as chamadas entre vários nós, e alguns ficam
// 1–2 blocos atrás. Logo depois do Approve a simulação pode cair num nó que
// ainda não viu a aprovação, então tentamos de novo por alguns segundos.
async function simulate(params, tries = 8) {
  for (let i = 1; ; i++) {
    try {
      return await publicClient.simulateContract({ account: state.account, ...params });
    } catch (e) {
      if (i >= tries || !/allowance/i.test(e?.message || "")) throw e;
      await sleep(1500);
    }
  }
}

async function ensureAllowance(amount) {
  if ((await readAllowance()) >= amount) return;
  const { request } = await simulate({
    address: TOKEN,
    abi: ERC20_ABI,
    functionName: "approve",
    args: [CASINO, amount],
  });
  await send("Approve RSGP", request);
  for (let i = 0; i < 15 && (await readAllowance()) < amount; i++) await sleep(1000);
}

async function guard(fn) {
  if (!CONFIGURED) return toast("Site not configured yet: set CASINO_ADDRESS in src/config.js.", "error");
  if (!state.account) await connect();
  if (!state.account) return;
  if (state.busy) return;
  state.busy = true;
  document.body.classList.add("is-busy");
  try {
    await ensureChain();
    await fn();
  } catch (e) {
    console.error(e);
    toast(niceError(e), "error", 8000);
  } finally {
    state.busy = false;
    document.body.classList.remove("is-busy");
    refresh();
  }
}

async function createBet() {
  await guard(async () => {
    const raw = $("amountInput").value.replace(/,/g, "").trim();
    if (!raw || Number(raw) <= 0) throw new Error("Type an amount first.");
    const amount = parseUnits(raw, state.decimals);
    if (amount < state.minBet) throw new Error(`Minimum bet is ${fmt(state.minBet)} RSGP.`);
    if (amount > state.balance) throw new Error("You don't have that much RSGP.");
    const side = Number(document.querySelector('input[name="side"]:checked').value);

    await ensureAllowance(amount);
    const { request } = await simulate({
      address: CASINO,
      abi: CASINO_ABI,
      functionName: "createGame",
      args: [amount, side],
    });
    await send("Open bet", request);
    $("amountInput").value = "";
    toast(`Bet opened on ${sideName(side)}. Now wait for a taker.`, "ok");
  });
}

async function act(kind, id) {
  await guard(async () => {
    const g = state.games.find((x) => x.id === id);
    if (kind === "join") {
      if (g.amount > state.balance) throw new Error("You don't have enough RSGP for this bet.");
      await ensureAllowance(g.amount);
      const fee = await quoteFee();
      const value = (fee * BigInt(Math.round(CONFIG.VRF_FEE_BUFFER * 100))) / 100n;
      const { request } = await simulate({
        address: CASINO,
        abi: CASINO_ABI,
        functionName: "joinGame",
        args: [BigInt(id)],
        value,
      });
      state.seen.set(id, STATUS.OPEN);
      showRolling(id);
      try {
        await send("Take bet", request);
        toast("Bet taken. Chainlink is drawing the side.", "ok");
      } catch (e) {
        $("flipOverlay").hidden = true;
        state.watchingId = null;
        throw e;
      }
    } else {
      const fn = { cancel: "cancelGame", settle: "settle", refund: "refundStuck" }[kind];
      const { request } = await publicClient.simulateContract({
        account: state.account,
        address: CASINO,
        abi: CASINO_ABI,
        functionName: fn,
        args: [BigInt(id)],
      });
      await send({ cancel: "Cancel bet", settle: "Claim", refund: "Refund" }[kind], request);
      toast(
        { cancel: "Bet cancelled. RSGP returned.", settle: "Claimed. RSGP is in your wallet.", refund: "Refunded." }[kind],
        "ok"
      );
      if (kind === "settle") $("flipOverlay").hidden = true;
    }
  });
}

function niceError(e) {
  if (e instanceof BaseError) {
    if (e.walk((x) => x instanceof UserRejectedRequestError)) return "Cancelled in the wallet.";
    const rev = e.walk((x) => x instanceof ContractFunctionRevertedError);
    const name = rev?.data?.errorName;
    const map = {
      WrongStatus: "That bet already moved on. Refreshing.",
      SelfPlay: "You can't take your own bet.",
      VrfFeeTooLow: "Gas jumped while you were signing. Try again.",
      BadAmount: `Minimum bet is ${fmt(state.minBet)} RSGP.`,
      BadSide: "Pick a side.",
      NotCreator: "Only whoever opened the bet can cancel it.",
      TooEarly: "Refund unlocks 24h after the bet was taken.",
      ERC20InsufficientBalance: "Not enough RSGP.",
      ERC20InsufficientAllowance: "Approval missing. Try again.",
    };
    if (name && map[name]) return map[name];
    if (/insufficient funds/i.test(e.message)) return "Not enough ETH on Base for gas.";
    return e.shortMessage || e.message;
  }
  if (e?.code === 4001) return "Cancelled in the wallet.";
  return e?.message || "Something failed.";
}

// ───────────────────────── toast ─────────────────────────
let toastTimer;
function toast(msg, kind = "info", ms = 5000, hash) {
  const t = $("toast");
  t.className = `toast show ${kind}`;
  t.innerHTML = hash
    ? `${msg} <a href="${EXPLORER}/tx/${hash}" target="_blank" rel="noopener">view tx</a>`
    : msg;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = "toast"), ms);
}

// ───────────────────────── barbantes do quadro ─────────────────────────
function drawStrings() {
  const svg = $("strings");
  const board = $("board").getBoundingClientRect();
  const coinPin = $("coinStage").querySelector(".pin").getBoundingClientRect();
  const pins = [$("clip0"), $("clip1")].map((el) => el.querySelector(".pin").getBoundingClientRect());
  const cx = coinPin.left + coinPin.width / 2 - board.left;
  const cy = coinPin.top + coinPin.height / 2 - board.top;
  svg.setAttribute("viewBox", `0 0 ${board.width} ${board.height}`);
  svg.innerHTML = pins
    .map((p) => {
      const x = p.left + p.width / 2 - board.left;
      const y = p.top + p.height / 2 - board.top;
      const sag = Math.max(24, Math.abs(x - cx) * 0.18);
      return `<path d="M${x},${y} Q${(x + cx) / 2},${Math.max(y, cy) + sag} ${cx},${cy}" />`;
    })
    .join("");
}

// ───────────────────────── init ─────────────────────────
function init() {
  CONFIG.SIDES.forEach((s, i) => {
    document.querySelectorAll(`[data-side-name="${i}"]`).forEach((el) => (el.textContent = s.name));
    document.querySelectorAll(`[data-side-tag="${i}"]`).forEach((el) => (el.textContent = s.tagline));
  });
  $("contractLink").href = `${EXPLORER}/address/${CASINO}`;
  $("tokenLink").href = `${EXPLORER}/token/${TOKEN}`;

  $("quickAmounts").innerHTML = CONFIG.QUICK_AMOUNTS.map(
    (v) => `<button type="button" class="btn btn-chip" data-quick="${v}">${v.toLocaleString("en-US")}</button>`
  ).join("");
  $("quickAmounts").onclick = (e) => {
    const v = e.target.dataset.quick;
    if (v) $("amountInput").value = v;
  };
  $("maxBtn").onclick = () => {
    if (state.balance > 0n) $("amountInput").value = formatUnits(state.balance, state.decimals);
  };
  $("connectBtn").onclick = () => connect();
  $("netTag").onclick = () => state.provider && ensureChain().catch((e) => toast(niceError(e), "error"));
  $("createBtn").onclick = createBet;
  document.body.addEventListener("click", (e) => {
    const b = e.target.closest("[data-act]");
    if (b) act(b.dataset.act, Number(b.dataset.id));
  });

  drawStrings();
  window.addEventListener("resize", drawStrings);
  document.fonts?.ready.then(drawStrings);
  refreshConnectLabel();

  if (!CONFIGURED) {
    $("openList").innerHTML = `<p class="empty">Contract not configured. Deploy it and set CASINO_ADDRESS in src/config.js.</p>`;
    $("mineList").innerHTML = "";
    $("feedList").innerHTML = "";
  }

  loadStatic().then(refresh);
  setTimeout(() => connect(true), 300); // reconecta sem popup se já autorizado
  setInterval(() => !document.hidden && refresh(), 6000);
  document.addEventListener("visibilitychange", () => !document.hidden && refresh());
}

init();
