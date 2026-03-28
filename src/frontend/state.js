export const state = {
  // Wallet
  connected: false,
  publicKey: null,
  connection: null,

  // Pool
  poolAddress: null,
  activeBin: null,
  binStep: 10,
  currentPrice: null,
  tokenXSymbol: 'TOKEN',
  tokenYSymbol: 'SOL',
  tokenXMint: null,
  tokenYMint: null,
  tokenXDecimals: 9,
  tokenYDecimals: 9,

  // Side
  side: 'buy',

  // Positions (fetched from chain in prod, mock for demo)
  positions: [],

  // Pool discovery
  tokenMint: null,
  discoveredDlmmPools: [],
  discoveredDammPools: [],

  // Navigation
  currentPage: 0,
  currentSubPage: 'monke',
  activePoolOrbital: 0,

  // Burn
  crankBalance: 0n,

  // Ghost fields (assigned elsewhere, never declared in original state literal)
  monkeStateData: null,
  monkeNfts: null,
  currentNftIndex: 0,
  nftCarouselIdx: 0,
  selectedMonkeMint: null,
  peggedExchangeRate: null,
  peggedReserveAvailable: null,
  peggedUserBalance: null,
};
