import { ChatInputCommandInteraction } from 'discord.js';
import { PublicKey } from '@solana/web3.js';
import {
  parseLbPairFull, loadPoolRegistry, fetchDexScreenerPrice,
} from '@crankbot/core-sdk';
import { formatPositionsList, PositionDisplayData } from '../formatter';
import type { BotContext } from '../index';

export async function handlePositions(interaction: ChatInputCommandInteraction, ctx: BotContext): Promise<void> {
  const userId = `discord:${interaction.user.id}`;

  await interaction.deferReply({ ephemeral: true });

  const dbPositions = ctx.walletService.getOpenPositions(userId);

  if (dbPositions.length === 0) {
    await interaction.editReply('No open positions.\n\n/buy or /sell to open one.');
    return;
  }

  // Enrich with on-chain data (active bin for fill %)
  const pools = loadPoolRegistry();
  const positions: PositionDisplayData[] = [];
  const poolCache = new Map<string, any>();
  const quoteUsdCache = new Map<string, number>();

  for (const p of dbPositions) {
    let poolData = poolCache.get(p.lb_pair);
    if (!poolData) {
      try {
        poolData = await parseLbPairFull(ctx.connection, p.lb_pair);
        poolCache.set(p.lb_pair, poolData);
      } catch {
        poolData = { activeId: 0, binStep: 10 };
      }
    }

    const poolConfig = pools.find(pc => pc.address === p.lb_pair);
    const decimalsX = poolConfig?.decimalsX ?? 9;
    const decimalsY = poolConfig?.decimalsY ?? 6;

    // Fetch quote token USD price for mcap display (cached per mint)
    let quoteTokenUsdPrice = 1.0;
    if (poolConfig?.displayMode === 'mc' && poolConfig.mintY) {
      const isStable = ['USDC', 'USDT'].includes((poolConfig.quoteToken ?? '').toUpperCase());
      if (!isStable) {
        if (quoteUsdCache.has(poolConfig.mintY)) {
          quoteTokenUsdPrice = quoteUsdCache.get(poolConfig.mintY)!;
        } else {
          const qData = await fetchDexScreenerPrice(poolConfig.mintY).catch(() => null);
          quoteTokenUsdPrice = qData?.priceUsd ?? 1.0;
          quoteUsdCache.set(poolConfig.mintY, quoteTokenUsdPrice);
        }
      }
    }

    positions.push({
      positionPda: p.position_pda,
      lbPair: p.lb_pair,
      poolName: poolConfig?.label ?? p.lb_pair.slice(0, 8) + '...',
      side: p.side as 'Buy' | 'Sell',
      minBinId: p.min_bin_id,
      maxBinId: p.max_bin_id,
      activeBinId: poolData.activeId,
      binStep: poolConfig?.binStep ?? poolData.binStep,
      decimalsX,
      decimalsY,
      initialAmount: BigInt(p.initial_amount),
      harvestedAmount: ctx.walletService.getHarvestedTotal(p.position_pda),
      tokenSymbol: p.side === 'Buy'
        ? (poolConfig?.buyToken ?? 'TOKEN')
        : (poolConfig?.quoteToken ?? 'SOL'),
      quoteSymbol: p.side === 'Buy'
        ? (poolConfig?.quoteToken ?? 'SOL')
        : (poolConfig?.buyToken ?? 'TOKEN'),
      quoteDecimals: p.side === 'Buy' ? decimalsX : decimalsY,
      createdAt: p.created_at,
      displayMode: poolConfig?.displayMode as 'price' | 'mc' | undefined,
      supply: poolConfig?.supply,
      quoteTokenUsdPrice,
    });
  }

  const text = formatPositionsList(positions);
  await interaction.editReply(text);
}
