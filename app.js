import { HashBrokerMiner } from "./miner.js";

const CONFIG = window.HASH_BROKER_CONFIG;
const SELECTORS = {
  totalSupply: "0x18160ddd",
  challenge: "0xd2ef7398",
  currentDifficulty: "0x5c062d6c",
  mine: "0xe43e322c"
};

const $ = (id) => document.getElementById(id);
const elements = {
  connect: $("connectButton"),
  mine: $("mineButton"),
  runState: $("runState"),
  network: $("networkStatus"),
  mintedTop: $("mintedTop"),
  minted: $("mintedCount"),
  difficulty: $("difficultyStat"),
  bestBits: $("bestBits"),
  candidateBits: $("candidateBits"),
  targetBits: $("targetBits"),
  bestHash: $("bestHash"),
  hashrate: $("hashrate"),
  hashes: $("hashesTried"),
  expected: $("expectedWait"),
  chance: $("chanceMinute"),
  gpu: $("gpuName"),
  log: $("terminalLog"),
  toast: $("toast"),
  portrait: $("portrait"),
  explorer: $("explorerLink"),
  bitMeter: $("bitMeter"),
  targetMeter: $("targetMeter")
};

let account = null;
let difficulty = 36;
let challenge = "0x" + "42".repeat(32);
let miner = null;
let mining = false;
let toastTimer = null;
let stateTimer = null;

function createMeters() {
  for (let i = 0; i < 52; i++) {
    elements.bitMeter.append(document.createElement("i"));
    const target = document.createElement("i");
    target.classList.add("on");
    elements.targetMeter.append(target);
  }
  paintMeters(0, difficulty);
}

function paintMeters(best, target) {
  [...elements.bitMeter.children].forEach((node, index) => node.classList.toggle("on", index < best));
  [...elements.targetMeter.children].forEach((node, index) => {
    node.classList.toggle("on", index < target);
    node.style.opacity = index < target ? "1" : ".16";
  });
}

function setLog(message) {
  elements.log.innerHTML = `<span>&gt;</span> ${message}`;
}

function showToast(message, error = false) {
  clearTimeout(toastTimer);
  elements.toast.textContent = message;
  elements.toast.classList.toggle("error", error);
  elements.toast.classList.add("show");
  toastTimer = setTimeout(() => elements.toast.classList.remove("show"), 5200);
}

function shortAddress(address) {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function formatRate(rate) {
  if (!Number.isFinite(rate) || rate <= 0) return "0 H/s";
  if (rate >= 1e9) return `${(rate / 1e9).toFixed(2)} GH/s`;
  if (rate >= 1e6) return `${(rate / 1e6).toFixed(1)} MH/s`;
  if (rate >= 1e3) return `${(rate / 1e3).toFixed(1)} KH/s`;
  return `${Math.round(rate)} H/s`;
}

function formatCount(value) {
  if (value >= 1e12) return `${(value / 1e12).toFixed(2)}T`;
  if (value >= 1e9) return `${(value / 1e9).toFixed(2)}B`;
  if (value >= 1e6) return `${(value / 1e6).toFixed(2)}M`;
  return Math.round(value).toLocaleString();
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds)) return "—";
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))} sec`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} min`;
  if (seconds < 86400) return `${(seconds / 3600).toFixed(1)} hr`;
  return `${(seconds / 86400).toFixed(1)} days`;
}

function updateDifficulty(next) {
  difficulty = Number(next);
  elements.difficulty.textContent = `${difficulty} BITS`;
  elements.targetBits.textContent = `${difficulty} LEADING ZERO BITS`;
  elements.bestBits.textContent = `0 / ${difficulty} BITS`;
  elements.candidateBits.textContent = `0 / ${difficulty} BITS`;
  paintMeters(0, difficulty);
}

async function rpc(method, params = []) {
  const provider = window.HASH_BROKER_WALLET?.provider || window.ethereum;
  if (!provider) throw new Error("Connect a wallet with WalletConnect or MetaMask first.");
  return provider.request({ method, params });
}

async function publicRpc(method, params = []) {
  const response = await fetch(CONFIG.RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params })
  });
  if (!response.ok) throw new Error(`Robinhood RPC returned ${response.status}.`);
  const payload = await response.json();
  if (payload.error) throw new Error(payload.error.message || "Robinhood RPC request failed.");
  return payload.result;
}

async function switchNetwork() {
  try {
    await rpc("wallet_switchEthereumChain", [{ chainId: CONFIG.CHAIN_ID_HEX }]);
  } catch (error) {
    if (error.code !== 4902) throw error;
    await rpc("wallet_addEthereumChain", [{
      chainId: CONFIG.CHAIN_ID_HEX,
      chainName: CONFIG.CHAIN_NAME,
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: [CONFIG.RPC_URL],
      blockExplorerUrls: [CONFIG.EXPLORER_URL]
    }]);
  }
}

async function connectWallet() {
  try {
    if (window.HASH_BROKER_WALLET?.open) {
      await window.HASH_BROKER_WALLET.open({ view: "Connect" });
      if (window.HASH_BROKER_WALLET.address) {
        account = window.HASH_BROKER_WALLET.address;
        elements.connect.textContent = shortAddress(account);
      }
    }
    const accounts = await rpc("eth_requestAccounts");
    await switchNetwork();
    account = accounts[0];
    elements.connect.textContent = shortAddress(account);
    elements.mine.textContent = CONFIG.DEMO_MODE ? "TEST GPU" : "START MINING";
    setLog(CONFIG.DEMO_MODE ? "Wallet connected. Contract is in preview mode." : "Wallet connected. Ready to search the current challenge.");
    if (!CONFIG.DEMO_MODE) await refreshState();
  } catch (error) {
    showToast(error.message || "Wallet connection failed.", true);
  }
}

window.addEventListener("hashbroker:wallet", () => {
  const address = window.HASH_BROKER_WALLET?.address;
  if (!address) return;
  account = address;
  elements.connect.textContent = shortAddress(address);
  elements.mine.textContent = CONFIG.DEMO_MODE ? "TEST GPU" : "START MINING";
  if (!CONFIG.DEMO_MODE) refreshState().catch(() => {});
});

async function contractCall(data) {
  return publicRpc("eth_call", [{ to: CONFIG.CONTRACT_ADDRESS, data }, "latest"]);
}

function decodeUint(hex) {
  if (!hex || hex === "0x") throw new Error("The contract returned an empty value.");
  return BigInt(hex);
}

async function refreshState() {
  if (CONFIG.DEMO_MODE) return;
  const [supplyHex, difficultyHex, nextChallenge] = await Promise.all([
    contractCall(SELECTORS.totalSupply),
    contractCall(SELECTORS.currentDifficulty),
    contractCall(SELECTORS.challenge)
  ]);
  const supply = Number(decodeUint(supplyHex));
  const nextDifficulty = Number(decodeUint(difficultyHex));
  elements.minted.textContent = supply.toLocaleString();
  elements.mintedTop.textContent = supply.toLocaleString();

  const challengeChanged = challenge !== nextChallenge;
  const difficultyChanged = difficulty !== nextDifficulty;
  challenge = nextChallenge;
  if (!mining) updateDifficulty(nextDifficulty);

  if (mining && (challengeChanged || difficultyChanged)) {
    miner.stop();
    mining = false;
    setLog("A new broker was mined. Loading the next challenge…");
    updateDifficulty(nextDifficulty);
    setTimeout(() => startMining(), 350);
  }
}

function encodeUint256(value) { return BigInt(value).toString(16).padStart(64, "0"); }

async function submitProof(nonce, proofChallenge) {
  if (CONFIG.DEMO_MODE) {
    showToast("Valid benchmark proof found. Deploy the contract to enable minting.");
    setLog(`Benchmark proof found with nonce ${nonce.toString()}.`);
    return;
  }
  const data = SELECTORS.mine + encodeUint256(nonce) + proofChallenge.slice(2);
  setLog("Proof found. Confirm the mint in MetaMask immediately.");
  showToast("Proof found — confirm the transaction in MetaMask.");
  try {
    const tx = await rpc("eth_sendTransaction", [{
      from: account,
      to: CONFIG.CONTRACT_ADDRESS,
      value: `0x${BigInt(CONFIG.MINT_PRICE_WEI).toString(16)}`,
      data
    }]);
    setLog(`Mint submitted: ${tx.slice(0, 12)}… Waiting for confirmation.`);
    const receipt = await waitForReceipt(tx);
    if (receipt.status === "0x1") {
      showToast("Hash Broker successfully mined and minted.");
      setLog("Broker secured on-chain. Loading the next challenge…");
      await refreshState();
    } else {
      throw new Error("The mint transaction reverted.");
    }
  } catch (error) {
    showToast(error.message || "Mint was not submitted.", true);
    setLog("Proof submission failed or was rejected. Refreshing challenge.");
    await refreshState().catch(() => {});
  }
}

async function waitForReceipt(txHash) {
  for (;;) {
    const receipt = await rpc("eth_getTransactionReceipt", [txHash]);
    if (receipt) return receipt;
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
}

function updateProgress({ totalHashes, bestBits, bestHash, hashrate }) {
  elements.hashrate.textContent = formatRate(hashrate);
  elements.hashes.textContent = formatCount(totalHashes);
  elements.bestBits.textContent = `${bestBits} / ${difficulty} BITS`;
  elements.candidateBits.textContent = `${bestBits} / ${difficulty} BITS`;
  elements.bestHash.textContent = bestHash || "Waiting for the first GPU candidate…";
  paintMeters(bestBits, difficulty);

  const meanSeconds = 2 ** difficulty / hashrate;
  const chancePerMinute = (1 - Math.exp(-(hashrate * 60) / 2 ** difficulty)) * 100;
  elements.expected.textContent = formatDuration(meanSeconds);
  elements.chance.textContent = chancePerMinute < .01 ? "<0.01%" : `${chancePerMinute.toFixed(2)}%`;
}

async function startMining() {
  if (mining) {
    miner?.stop();
    mining = false;
    elements.runState.textContent = "IDLE";
    elements.mine.textContent = CONFIG.DEMO_MODE ? "TEST GPU" : "START MINING";
    elements.mine.classList.remove("stop");
    elements.portrait.classList.remove("searching");
    setLog("Mining stopped locally.");
    return;
  }

  if (!CONFIG.DEMO_MODE && !account) {
    await connectWallet();
    if (!account) return;
  }

  try {
    elements.mine.disabled = true;
    setLog("Requesting a high-performance WebGPU adapter…");
    if (!miner) {
      miner = new HashBrokerMiner({
        onProgress: updateProgress,
        onFound: ({ nonce, challenge: foundChallenge }) => {
          mining = false;
          elements.runState.textContent = "PROOF FOUND";
          elements.mine.textContent = CONFIG.DEMO_MODE ? "TEST AGAIN" : "START MINING";
          elements.mine.classList.remove("stop");
          elements.portrait.classList.remove("searching");
          submitProof(nonce, foundChallenge);
        },
        onError: (error) => {
          mining = false;
          showToast(error.message, true);
          setLog(error.message);
        }
      });
      const gpuName = await miner.init();
      elements.gpu.textContent = gpuName.toUpperCase();
    }

    const jobAccount = account || "0x1111111111111111111111111111111111111111";
    miner.setJob({ address: jobAccount, challenge, difficulty });
    mining = true;
    elements.runState.textContent = CONFIG.DEMO_MODE ? "BENCHMARKING" : "SEARCHING";
    elements.mine.textContent = "STOP";
    elements.mine.classList.add("stop");
    elements.portrait.classList.add("searching");
    elements.mine.disabled = false;
    setLog(CONFIG.DEMO_MODE ? "GPU benchmark active. Searching a 36-bit sample proof." : "GPU active. Keep this tab open and watch for the MetaMask confirmation.");
    miner.start().catch((error) => {
      mining = false;
      showToast(error.message, true);
      setLog(error.message);
    });
  } catch (error) {
    mining = false;
    elements.mine.disabled = false;
    showToast(error.message || "Unable to start WebGPU.", true);
    setLog(error.message || "Unable to start WebGPU.");
  }
}

function initialize() {
  createMeters();
  elements.explorer.href = CONFIG.DEMO_MODE
    ? CONFIG.EXPLORER_URL
    : `${CONFIG.EXPLORER_URL}/address/${CONFIG.CONTRACT_ADDRESS}`;
  elements.network.textContent = CONFIG.DEMO_MODE ? "PREVIEW · ROBINHOOD CHAIN" : "ROBINHOOD CHAIN · LIVE";
  elements.connect.addEventListener("click", connectWallet);
  elements.mine.addEventListener("click", startMining);

  if (window.ethereum) {
    window.ethereum.on?.("accountsChanged", (accounts) => {
      account = accounts[0] || null;
      elements.connect.textContent = account ? shortAddress(account) : "CONNECT WALLET";
      if (mining) startMining();
    });
    window.ethereum.on?.("chainChanged", () => window.location.reload());
  }

  if (!CONFIG.DEMO_MODE) {
    refreshState().catch(() => {
      elements.minted.textContent = "—";
      elements.mintedTop.textContent = "—";
    });
  }
  stateTimer = setInterval(() => refreshState().catch(() => {}), 8000);
  window.addEventListener("beforeunload", () => clearInterval(stateTimer));
}

initialize();
