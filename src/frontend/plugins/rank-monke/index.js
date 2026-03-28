import { registerPlugin } from '../../plugin-loader.js';
import {
  initBurnFireCanvas, renderMonkeList, renderRoster, renderGlobalStats,
  handleFeedMonke, handleFeedGoose, handleClaimAll, handleClaimMonke,
  handleMonkeBurnLookup, handleMintPegged, handleRedeemPegged,
  updatePeggedEstimates, showSubPage, fetchSMBNfts, loadPeggedSection,
  ensureBurnFireRunning, updateUserMonkeStats, enrichNftsWithBurnData,
  renderCarouselFrame, selectMonke, highlightMonkeRow,
} from './rank.js';

export {
  initBurnFireCanvas, renderMonkeList, renderRoster, renderGlobalStats,
  handleFeedMonke, handleFeedGoose, handleClaimAll, handleClaimMonke,
  handleMonkeBurnLookup, handleMintPegged, handleRedeemPegged,
  updatePeggedEstimates, showSubPage, fetchSMBNfts, loadPeggedSection,
  ensureBurnFireRunning, updateUserMonkeStats, enrichNftsWithBurnData,
  renderCarouselFrame, selectMonke, highlightMonkeRow,
};

const plugin = {
  id: 'rank-monke',
  label: 'Monke Rank',
  pageIndex: 2,

  register(ctx) {},

  mount(container) {
    initBurnFireCanvas();
    renderMonkeList();
    renderRoster();
    renderGlobalStats();
    loadPeggedSection();
  },

  unmount() {},

  onWalletConnect(data) {
    fetchSMBNfts();
    renderMonkeList();
    renderGlobalStats();
    loadPeggedSection();
  },

  onWalletDisconnect() {
    renderMonkeList();
    renderGlobalStats();
  },
};

registerPlugin(plugin);
export default plugin;
