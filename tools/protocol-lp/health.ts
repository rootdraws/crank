/**
 * tools/protocol-lp/health.ts
 *
 * Minimal HTTP health endpoint for PM2 monitoring.
 */

import http from 'http';
import { CONFIG } from './config';
import { getState } from './state';

let startTime = Date.now();
let lastPollData: Record<string, any> = {};

export function updateHealthData(data: Record<string, any>) {
  lastPollData = data;
}

export function startHealthServer(): void {
  const server = http.createServer((req, res) => {
    if (req.url === '/health' && req.method === 'GET') {
      const state = getState();
      const sellCount = Object.values(state.positions).filter(p => p.side === 'sell' && p.status === 'active').length;
      const buyCount = Object.values(state.positions).filter(p => p.side === 'buy' && p.status === 'active').length;
      const exhaustedCount = Object.values(state.positions).filter(p => p.status === 'exhausted').length;

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'ok',
        uptime: Math.floor((Date.now() - startTime) / 1000),
        wallet: CONFIG.wallet.publicKey.toBase58(),
        pool: CONFIG.poolAddressStr,
        dryRun: CONFIG.dryRun,
        positions: { sell: sellCount, buy: buyCount, exhausted: exhaustedCount },
        totals: {
          solHarvested: (state.totalSolHarvested / 1e9).toFixed(4),
          solDeployed: (state.totalSolDeployed / 1e9).toFixed(4),
          cycleCount: state.cycleCount,
        },
        lastHarvest: state.harvests[state.harvests.length - 1]?.timestamp ?? null,
        lastDeploy: state.deployments[state.deployments.length - 1]?.timestamp ?? null,
        ...lastPollData,
      }, null, 2));
    } else {
      res.writeHead(404);
      res.end('Not found');
    }
  });

  server.listen(CONFIG.healthPort, () => {
    console.log(`Health server on :${CONFIG.healthPort}/health`);
  });
}
