const CONFIG = window.HASH_BROKER_CONFIG;
const ZERO = "0x0000000000000000000000000000000000000000";
const READY = !CONFIG.DEMO_MODE
  && CONFIG.CONTRACT_ADDRESS !== ZERO
  && CONFIG.STAKING_ADDRESS !== ZERO;

const SELECTORS = Object.freeze({
  collectionTotalSupply: "0x18160ddd",
  tokensOfOwner: "0x8462151c",
  isApprovedForAll: "0xe985e9c5",
  setApprovalForAll: "0xa22cb465",
  stakedTokens: "0xa5b39cfb",
  totalStaked: "0x817b1cd2",
  stakingOpen: "0x38760298",
  rewardTokenCount: "0xabb06b95",
  rewardTokenAt: "0x79f5ecb7",
  earned: "0x211dc32d",
  rewardInfo: "0xcbecf6b5",
  stake: "0x0fbf0a93",
  unstake: "0xe449f341",
  unstakeAll: "0x35322f37",
  claim: "0x1e83409a",
  claimAll: "0xd1058e59"
});

const $ = (id) => document.getElementById(id);
const elements = {
  connect: $("connectButton"),
  status: $("stakingStatus"),
  statusDot: $("stakingDot"),
  terminalState: $("terminalState"),
  totalTop: $("totalStakedTop"),
  walletCount: $("walletCount"),
  stakedCount: $("userStakedCount"),
  activePools: $("activePools"),
  networkStaked: $("networkStaked"),
  ownedGrid: $("ownedGrid"),
  stakedGrid: $("stakedGrid"),
  selectOwnedAll: $("selectOwnedAll"),
  selectStakedAll: $("selectStakedAll"),
  selectedOwned: $("selectedOwned"),
  selectedStaked: $("selectedStaked"),
  approve: $("approveButton"),
  stake: $("stakeButton"),
  unstake: $("unstakeButton"),
  unstakeAll: $("unstakeAllButton"),
  claimAll: $("claimAllButton"),
  rewards: $("rewardGrid"),
  log: $("stakingLog"),
  toast: $("toast")
};

let account = null;
let ownedTokenIds = [];
let stakedTokenIds = [];
let selectedOwned = new Set();
let selectedStaked = new Set();
let approved = false;
let stakingOpen = false;
let stakingActivated = false;
let mintedSupply = 0n;
let pendingRewards = [];
let busy = false;
let toastTimer = null;
let refreshTimer = null;

function stripHex(value) { return value.startsWith("0x") ? value.slice(2) : value; }
function padWord(value) { return stripHex(value).padStart(64, "0"); }
function encodeAddress(value) { return padWord(value.toLowerCase()); }
function encodeUint(value) { return BigInt(value).toString(16).padStart(64, "0"); }
function decodeUint(value, wordIndex = 0) {
  const clean = stripHex(value);
  const word = clean.slice(wordIndex * 64, (wordIndex + 1) * 64) || "0";
  return BigInt(`0x${word}`);
}
function decodeAddress(value, wordIndex = 0) {
  const clean = stripHex(value);
  return `0x${clean.slice(wordIndex * 64 + 24, (wordIndex + 1) * 64)}`;
}
function decodeUintArray(value) {
  const clean = stripHex(value);
  if (clean.length < 128) return [];
  const offset = Number(BigInt(`0x${clean.slice(0, 64)}`));
  const start = offset * 2;
  const length = Number(BigInt(`0x${clean.slice(start, start + 64)}`));
  const items = [];
  for (let index = 0; index < length; index += 1) {
    const position = start + 64 + index * 64;
    items.push(BigInt(`0x${clean.slice(position, position + 64)}`));
  }
  return items;
}
function encodeUintArray(selector, values) {
  return selector
    + encodeUint(32)
    + encodeUint(values.length)
    + values.map(encodeUint).join("");
}

function shortAddress(value) { return `${value.slice(0, 6)}…${value.slice(-4)}`; }
function shortNumber(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return value.toString();
  if (number >= 1e9) return `${(number / 1e9).toFixed(2)}B`;
  if (number >= 1e6) return `${(number / 1e6).toFixed(2)}M`;
  if (number >= 1e3) return `${(number / 1e3).toFixed(1)}K`;
  return number.toLocaleString();
}
function formatUnits(value, decimals = 18, precision = 4) {
  const scale = 10n ** BigInt(decimals);
  const whole = value / scale;
  const fraction = (value % scale).toString().padStart(decimals, "0").slice(0, precision).replace(/0+$/, "");
  return fraction ? `${whole.toLocaleString()}.${fraction}` : whole.toLocaleString();
}

function setLog(message) { elements.log.innerHTML = `<span>&gt;</span> ${message}`; }
function showToast(message, error = false) {
  clearTimeout(toastTimer);
  elements.toast.textContent = message;
  elements.toast.classList.toggle("error", error);
  elements.toast.classList.add("show");
  toastTimer = setTimeout(() => elements.toast.classList.remove("show"), 5200);
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
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })
  });
  const payload = await response.json();
  if (payload.error) throw new Error(payload.error.message);
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

async function contractCall(to, data, usePublicRpc = false) {
  const params = [{ to, data }, "latest"];
  return usePublicRpc ? publicRpc("eth_call", params) : rpc("eth_call", params);
}

async function waitForReceipt(transactionHash) {
  for (;;) {
    const receipt = await rpc("eth_getTransactionReceipt", [transactionHash]);
    if (receipt) return receipt;
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
}

async function sendTransaction(to, data, pendingMessage, successMessage) {
  if (!account || busy) return;
  busy = true;
  updateButtons();
  setLog(pendingMessage);
  try {
    const transactionHash = await rpc("eth_sendTransaction", [{ from: account, to, data }]);
    setLog(`Transaction ${transactionHash.slice(0, 12)}… submitted. Waiting for confirmation.`);
    const receipt = await waitForReceipt(transactionHash);
    if (receipt.status !== "0x1") throw new Error("The transaction reverted.");
    showToast(successMessage);
    setLog(successMessage);
    await refreshAccount();
  } catch (error) {
    showToast(error.shortMessage || error.message || "Transaction was not completed.", true);
    setLog("Transaction cancelled or failed. Your NFTs remain unchanged.");
  } finally {
    busy = false;
    updateButtons();
  }
}

async function connectWallet() {
  try {
    if (window.HASH_BROKER_WALLET?.open) {
      await window.HASH_BROKER_WALLET.open({ view: "Connect" });
      if (window.HASH_BROKER_WALLET.address) account = window.HASH_BROKER_WALLET.address;
    }
    const accounts = await rpc("eth_requestAccounts");
    await switchNetwork();
    account = accounts[0];
    elements.connect.textContent = shortAddress(account);
    if (!READY) {
      setLog("Wallet connected. Staking activates after the contracts and reward pools are configured.");
      renderAll();
      return;
    }
    setLog("Wallet connected. Loading your Hash Brokers and reward balances…");
    await refreshAccount();
  } catch (error) {
    showToast(error.message || "Wallet connection failed.", true);
  }
}

window.addEventListener("hashbroker:wallet", () => {
  const address = window.HASH_BROKER_WALLET?.address;
  if (!address) return;
  account = address;
  elements.connect.textContent = shortAddress(address);
  if (READY) refreshAccount().catch(() => {});
});

function tokenCard(tokenId, selection, group) {
  const label = document.createElement("label");
  label.className = "broker-card";
  const input = document.createElement("input");
  input.type = "checkbox";
  input.checked = selection.has(tokenId.toString());
  input.addEventListener("change", () => {
    const key = tokenId.toString();
    if (input.checked) selection.add(key); else selection.delete(key);
    label.classList.toggle("selected", input.checked);
    updateSelectionCounters();
    updateButtons();
  });
  label.classList.toggle("selected", input.checked);

  const icon = document.createElement("span");
  icon.className = "broker-card-icon";
  icon.textContent = "#";
  const copy = document.createElement("span");
  copy.className = "broker-card-copy";
  const name = document.createElement("strong");
  name.textContent = `HASH BROKER #${tokenId}`;
  const state = document.createElement("small");
  state.textContent = group === "staked" ? "EARNING REWARDS" : "READY TO STAKE";
  copy.append(name, state);
  label.append(input, icon, copy);
  return label;
}

function renderTokenGrid(container, tokenIds, selection, group) {
  container.replaceChildren();
  if (!tokenIds.length) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = account
      ? (group === "staked" ? "No Hash Brokers are staked." : "No unstaked Hash Brokers found in this wallet.")
      : "Connect your wallet to load Hash Brokers.";
    container.append(empty);
    return;
  }
  tokenIds.forEach((tokenId) => container.append(tokenCard(tokenId, selection, group)));
}

function renderRewardCards() {
  elements.rewards.replaceChildren();
  const rewards = pendingRewards.length
    ? pendingRewards
    : CONFIG.REWARD_TOKENS.map((token) => ({ ...token, earned: 0n, rate: 0n, available: 0n, active: false }));

  rewards.forEach((reward) => {
    const card = document.createElement("article");
    card.className = "reward-card";
    card.style.setProperty("--token-color", reward.color || "#27e0c1");

    const header = document.createElement("div");
    header.className = "reward-card-header";
    const symbol = document.createElement("strong");
    symbol.textContent = `$${reward.symbol}`;
    const status = document.createElement("span");
    status.textContent = reward.active ? "ACTIVE" : "PENDING";
    status.className = reward.active ? "pool-active" : "";
    header.append(symbol, status);

    const amount = document.createElement("p");
    amount.className = "reward-amount";
    amount.textContent = formatUnits(reward.earned || 0n, reward.decimals);

    const rate = document.createElement("p");
    rate.className = "reward-rate";
    const daily = (reward.rate || 0n) * 86400n * BigInt(stakedTokenIds.length);
    rate.textContent = reward.active
      ? `${formatUnits(daily, reward.decimals)} / DAY FOR YOUR STAKE`
      : "RATE SET AT LAUNCH";

    const reserve = document.createElement("p");
    reserve.className = "reward-reserve";
    reserve.textContent = reward.active
      ? `POOL ${formatUnits(reward.available || 0n, reward.decimals)}`
      : "POOL NOT CONFIGURED";

    const claim = document.createElement("button");
    claim.className = "mini-claim";
    claim.type = "button";
    claim.textContent = "CLAIM";
    claim.disabled = busy || !account || !reward.active || reward.earned === 0n;
    claim.addEventListener("click", () => {
      const data = SELECTORS.claim + encodeAddress(reward.address);
      sendTransaction(CONFIG.STAKING_ADDRESS, data, `Claiming $${reward.symbol}…`, `$${reward.symbol} claimed.`);
    });

    card.append(header, amount, rate, reserve, claim);
    elements.rewards.append(card);
  });
}

function updateSelectionCounters() {
  elements.selectedOwned.textContent = selectedOwned.size;
  elements.selectedStaked.textContent = selectedStaked.size;
}

function updateButtons() {
  const canTransact = READY && account && !busy;
  elements.approve.disabled = !canTransact || approved || !stakingActivated;
  elements.approve.textContent = approved ? "APPROVED" : "APPROVE STAKING";
  elements.stake.disabled = !canTransact || !stakingOpen || !approved || selectedOwned.size === 0;
  elements.unstake.disabled = !canTransact || selectedStaked.size === 0;
  elements.unstakeAll.disabled = !canTransact || stakedTokenIds.length === 0;
  elements.claimAll.disabled = !canTransact || !pendingRewards.some((reward) => reward.earned > 0n);
}

function renderAll() {
  elements.walletCount.textContent = ownedTokenIds.length;
  elements.stakedCount.textContent = stakedTokenIds.length;
  renderTokenGrid(elements.ownedGrid, ownedTokenIds, selectedOwned, "owned");
  renderTokenGrid(elements.stakedGrid, stakedTokenIds, selectedStaked, "staked");
  renderRewardCards();
  updateSelectionCounters();
  updateButtons();
}

async function loadRewardState() {
  const countResult = await contractCall(CONFIG.STAKING_ADDRESS, SELECTORS.rewardTokenCount);
  const count = Number(decodeUint(countResult));
  const rewards = [];
  for (let index = 0; index < count; index += 1) {
    const addressResult = await contractCall(
      CONFIG.STAKING_ADDRESS,
      SELECTORS.rewardTokenAt + encodeUint(index)
    );
    const address = decodeAddress(addressResult);
    const metadata = CONFIG.REWARD_TOKENS.find(
      (token) => token.address.toLowerCase() === address.toLowerCase()
    ) || { symbol: `TOKEN ${index + 1}`, decimals: 18, color: "#27e0c1" };
    const [earnedResult, infoResult] = await Promise.all([
      contractCall(CONFIG.STAKING_ADDRESS, SELECTORS.earned + encodeAddress(account) + encodeAddress(address)),
      contractCall(CONFIG.STAKING_ADDRESS, SELECTORS.rewardInfo + encodeAddress(address))
    ]);
    rewards.push({
      ...metadata,
      address,
      earned: decodeUint(earnedResult),
      rate: decodeUint(infoResult, 0),
      available: decodeUint(infoResult, 1),
      active: decodeUint(infoResult, 2) === 1n
    });
  }
  pendingRewards = rewards;
  elements.activePools.textContent = `${rewards.filter((reward) => reward.active).length} / 8`;
}

async function refreshAccount() {
  if (!READY || !account) return;
  const [ownedResult, stakedResult, approvedResult, totalResult, openResult, mintedResult] = await Promise.all([
    contractCall(CONFIG.CONTRACT_ADDRESS, SELECTORS.tokensOfOwner + encodeAddress(account)),
    contractCall(CONFIG.STAKING_ADDRESS, SELECTORS.stakedTokens + encodeAddress(account)),
    contractCall(
      CONFIG.CONTRACT_ADDRESS,
      SELECTORS.isApprovedForAll + encodeAddress(account) + encodeAddress(CONFIG.STAKING_ADDRESS)
    ),
    contractCall(CONFIG.STAKING_ADDRESS, SELECTORS.totalStaked),
    contractCall(CONFIG.STAKING_ADDRESS, SELECTORS.stakingOpen),
    contractCall(CONFIG.CONTRACT_ADDRESS, SELECTORS.collectionTotalSupply)
  ]);

  ownedTokenIds = decodeUintArray(ownedResult);
  stakedTokenIds = decodeUintArray(stakedResult);
  approved = decodeUint(approvedResult) === 1n;
  stakingOpen = decodeUint(openResult) === 1n;
  mintedSupply = decodeUint(mintedResult);
  stakingActivated = mintedSupply >= BigInt(CONFIG.STAKE_ACTIVATION_SUPPLY || 1000);
  const total = decodeUint(totalResult);
  elements.totalTop.textContent = shortNumber(total);
  elements.networkStaked.textContent = shortNumber(total);
  const live = stakingOpen && stakingActivated;
  elements.status.textContent = live ? "STAKING LIVE" : stakingActivated ? "WAITING FOR LAUNCH" : `ACTIVATES AT ${mintedSupply.toLocaleString()} / ${CONFIG.STAKE_ACTIVATION_SUPPLY.toLocaleString()}`;
  elements.terminalState.textContent = live ? "ONLINE" : "LOCKED";
  elements.statusDot.classList.toggle("paused", !live);
  setActivationCopy();

  const ownedKeys = new Set(ownedTokenIds.map(String));
  const stakedKeys = new Set(stakedTokenIds.map(String));
  selectedOwned = new Set([...selectedOwned].filter((id) => ownedKeys.has(id)));
  selectedStaked = new Set([...selectedStaked].filter((id) => stakedKeys.has(id)));
  await loadRewardState();
  renderAll();
}

async function refreshPublicState() {
  if (!READY) return;
  try {
    const [totalResult, openResult, mintedResult] = await Promise.all([
      contractCall(CONFIG.STAKING_ADDRESS, SELECTORS.totalStaked, true),
      contractCall(CONFIG.STAKING_ADDRESS, SELECTORS.stakingOpen, true),
      contractCall(CONFIG.CONTRACT_ADDRESS, SELECTORS.collectionTotalSupply, true)
    ]);
    const total = decodeUint(totalResult);
    stakingOpen = decodeUint(openResult) === 1n;
    mintedSupply = decodeUint(mintedResult);
    stakingActivated = mintedSupply >= BigInt(CONFIG.STAKE_ACTIVATION_SUPPLY || 1000);
    elements.totalTop.textContent = shortNumber(total);
    elements.networkStaked.textContent = shortNumber(total);
    const live = stakingOpen && stakingActivated;
    elements.status.textContent = live ? "STAKING LIVE" : stakingActivated ? "WAITING FOR LAUNCH" : `ACTIVATES AT ${mintedSupply.toLocaleString()} / ${CONFIG.STAKE_ACTIVATION_SUPPLY.toLocaleString()}`;
    elements.terminalState.textContent = live ? "ONLINE" : "LOCKED";
    elements.statusDot.classList.toggle("paused", !live);
    setActivationCopy();
  } catch (_) {
    elements.status.textContent = "ROBINHOOD CHAIN";
  }
}

function setActivationCopy() {
  const note = document.getElementById("activationNote");
  if (!note) return;
  if (stakingActivated) {
    note.textContent = stakingOpen ? "Staking is active — lock your Hash Brokers and start earning." : "The first 1,000 are minted. Staking pools are being prepared.";
  } else {
    note.textContent = `${mintedSupply.toLocaleString()} / ${CONFIG.STAKE_ACTIVATION_SUPPLY.toLocaleString()} minted — staking unlocks automatically after Hash Broker #${CONFIG.STAKE_ACTIVATION_SUPPLY.toLocaleString()}.`;
  }
}

function selectAll(source, selection) {
  const allSelected = source.length > 0 && source.every((tokenId) => selection.has(tokenId.toString()));
  selection.clear();
  if (!allSelected) source.forEach((tokenId) => selection.add(tokenId.toString()));
  renderAll();
}

function initialize() {
  renderAll();
  if (!READY) {
    elements.status.textContent = "PRE-LAUNCH";
    elements.terminalState.textContent = "CONFIG PENDING";
    elements.statusDot.classList.add("paused");
    setLog("Staking interface ready. Add the deployed contracts, token addresses, rates and reserves to activate it.");
  } else {
    refreshPublicState();
  }

  elements.connect.addEventListener("click", connectWallet);
  elements.selectOwnedAll.addEventListener("click", () => selectAll(ownedTokenIds, selectedOwned));
  elements.selectStakedAll.addEventListener("click", () => selectAll(stakedTokenIds, selectedStaked));
  elements.approve.addEventListener("click", () => {
    const data = SELECTORS.setApprovalForAll + encodeAddress(CONFIG.STAKING_ADDRESS) + encodeUint(1);
    sendTransaction(CONFIG.CONTRACT_ADDRESS, data, "Requesting one-time NFT approval…", "Staking contract approved.");
  });
  elements.stake.addEventListener("click", () => {
    const ids = [...selectedOwned].map(BigInt);
    sendTransaction(CONFIG.STAKING_ADDRESS, encodeUintArray(SELECTORS.stake, ids), "Staking selected Hash Brokers…", `${ids.length} Hash Broker${ids.length === 1 ? "" : "s"} staked.`);
  });
  elements.unstake.addEventListener("click", () => {
    const ids = [...selectedStaked].map(BigInt);
    sendTransaction(CONFIG.STAKING_ADDRESS, encodeUintArray(SELECTORS.unstake, ids), "Returning selected Hash Brokers…", `${ids.length} Hash Broker${ids.length === 1 ? "" : "s"} returned.`);
  });
  elements.unstakeAll.addEventListener("click", () => {
    sendTransaction(CONFIG.STAKING_ADDRESS, SELECTORS.unstakeAll, "Returning all staked Hash Brokers…", "All Hash Brokers returned to your wallet.");
  });
  elements.claimAll.addEventListener("click", () => {
    sendTransaction(CONFIG.STAKING_ADDRESS, SELECTORS.claimAll, "Claiming all available rewards…", "Available rewards claimed.");
  });

  if (window.ethereum) {
    window.ethereum.on?.("accountsChanged", (accounts) => {
      account = accounts[0] || null;
      elements.connect.textContent = account ? shortAddress(account) : "CONNECT WALLET";
      if (account) refreshAccount().catch(() => {}); else window.location.reload();
    });
    window.ethereum.on?.("chainChanged", () => window.location.reload());
  }

  refreshTimer = setInterval(() => {
    if (account) refreshAccount().catch(() => {}); else refreshPublicState();
  }, 15000);
  window.addEventListener("beforeunload", () => clearInterval(refreshTimer));
}

initialize();
