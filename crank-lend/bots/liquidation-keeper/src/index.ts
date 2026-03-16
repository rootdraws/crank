import { Connection } from "@solana/web3.js";
import { CONFIG } from "./config";
import { HealthMonitor } from "./health-monitor";
import { updateKeeperOracle } from "./keeper-oracle";
import { PokeBot } from "./poke-bot";

async function main() {
  console.log("=== Crank-Lend Liquidation Keeper ===");
  console.log(`RPC: ${CONFIG.rpcUrl}`);
  console.log(`Keeper: ${CONFIG.keeperKeypair.publicKey.toBase58()}`);

  const connection = new Connection(CONFIG.rpcUrl, "confirmed");

  // --- Keeper Oracle Updater ---
  // Periodically fetch CRANK price from Pumpswap and post to the on-chain keeper oracle
  if (CONFIG.keeperOracleAccount) {
    console.log(
      `[Main] Keeper oracle: ${CONFIG.keeperOracleAccount.toBase58()}`
    );
    setInterval(async () => {
      try {
        const price = await fetchCrankPrice(connection);
        if (price !== null) {
          await updateKeeperOracle(
            connection,
            CONFIG.keeperKeypair,
            CONFIG.crankLendProgramId,
            CONFIG.keeperOracleAccount!,
            price,
            price * 0.02 // 2% confidence
          );
        }
      } catch (err) {
        console.error("[Main] Oracle update error:", err);
      }
    }, CONFIG.pollIntervalMs);
  }

  // --- Poke Bot ---
  // Keep the Meteora DLMM oracle fresh with dust trades
  if (CONFIG.meteoraDlmmPool) {
    const pokeBot = new PokeBot(
      connection,
      CONFIG.keeperKeypair,
      CONFIG.meteoraDlmmPool,
      60_000
    );
    pokeBot.start();
  }

  // --- Health Monitor & Liquidator ---
  if (CONFIG.crankLendGroup) {
    const monitor = new HealthMonitor(
      connection,
      CONFIG.crankLendProgramId,
      CONFIG.crankLendGroup
    );

    console.log("[Main] Starting health monitoring loop...");
    setInterval(async () => {
      try {
        const liquidatable = await monitor.findLiquidatableAccounts(
          CONFIG.liquidationThreshold
        );

        for (const account of liquidatable) {
          console.log(
            `[Main] Liquidatable account: ${account.account.toBase58()}, health: ${account.healthFactor}`
          );
          // TODO: Execute liquidation via the liquidator vault program
          // 1. Build the execute_liquidation instruction with all required accounts
          // 2. Sign and send the transaction
        }
      } catch (err) {
        console.error("[Main] Health monitoring error:", err);
      }
    }, CONFIG.pollIntervalMs);
  }

  // Keep the process running
  console.log("[Main] Bot running. Press Ctrl+C to stop.");
  await new Promise(() => {});
}

/**
 * Fetch the current CRANK/USD price from Pumpswap.
 * In production, this reads the pool's reserve balances and computes the spot price,
 * or uses an API endpoint if available.
 */
async function fetchCrankPrice(_connection: Connection): Promise<number | null> {
  if (!CONFIG.pumpswapPool) return null;

  // TODO: Implement Pumpswap price fetching
  // 1. Fetch the Pumpswap pool account
  // 2. Read reserve_x (CRANK) and reserve_y (SOL) balances
  // 3. Compute price = reserve_y / reserve_x (in SOL terms)
  // 4. Multiply by SOL/USD price (from Pyth or another source)
  //
  // For now, return null (skip oracle updates until implemented)
  console.log("[PriceFetch] Pumpswap price fetch not yet implemented");
  return null;
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
