const PROJECT_ID = "4f71172824a0ea69b0270161482356fe";
let resolveReady;
const readyPromise = new Promise((resolve) => { resolveReady = resolve; });
let openImpl = async () => {};

window.HASH_BROKER_WALLET = {
  projectId: PROJECT_ID,
  ready: false,
  provider: null,
  address: null,
  open: async (options = { view: "Connect" }) => {
    await readyPromise;
    return openImpl(options);
  }
};

async function bootWallet() {
  try {
    const [{ createAppKit }, { EthersAdapter }] = await Promise.all([
      import("https://esm.sh/@reown/appkit@latest?bundle"),
      import("https://esm.sh/@reown/appkit-adapter-ethers@latest?bundle")
    ]);
    const chain = {
      id: 4663,
      caipNetworkId: "eip155:4663",
      chainNamespace: "eip155",
      name: "Robinhood Chain",
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: ["https://rpc.mainnet.chain.robinhood.com/"] } },
      blockExplorers: { default: { name: "Robinhood Chain Explorer", url: "https://robinhoodchain.blockscout.com" } }
    };
    const modal = createAppKit({
      adapters: [new EthersAdapter()],
      networks: [chain],
      defaultNetwork: chain,
      projectId: PROJECT_ID,
      metadata: {
        name: "Hash Broker",
        description: "Proof-of-work Hash Brokers on Robinhood Chain",
        url: window.location.origin,
        icons: [`${window.location.origin}/favicon.svg`]
      },
      themeMode: "dark",
      themeVariables: { "--w3m-accent": "#27e0c1", "--w3m-border-radius-master": "2px" },
      features: { analytics: true, email: false, socials: [] }
    });
    openImpl = (options = { view: "Connect" }) => modal.open(options);
    modal.subscribeProvider((state) => {
      window.HASH_BROKER_WALLET.provider = state.provider || null;
      window.HASH_BROKER_WALLET.address = state.address || null;
      window.HASH_BROKER_WALLET.ready = true;
      window.dispatchEvent(new CustomEvent("hashbroker:wallet", { detail: state }));
    });
    window.HASH_BROKER_WALLET.ready = true;
    resolveReady();
    window.dispatchEvent(new Event("hashbroker:wallet-ready"));
  } catch (error) {
    console.warn("WalletConnect unavailable; MetaMask fallback remains enabled.", error);
    window.HASH_BROKER_WALLET.ready = true;
    resolveReady();
    window.dispatchEvent(new Event("hashbroker:wallet-ready"));
  }
}

bootWallet();
