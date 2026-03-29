import { ChatInputCommandInteraction } from 'discord.js';
import { PublicKey } from '@solana/web3.js';
import {
  parseLbPairFull, loadPoolRegistry,
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
      harvestedAmount: 0n,
      tokenSymbol: p.side === 'Buy'
        ? (poolConfig?.buyToken ?? 'TOKEN')
        : (poolConfig?.quoteToken ?? 'SOL'),
      quoteSymbol: p.side === 'Buy'
        ? (poolConfig?.quoteToken ?? 'SOL')
        : (poolConfig?.buyToken ?? 'TOKEN'),
      quoteDecimals: p.side === 'Buy' ? decimalsY : decimalsX,
      createdAt: p.created_at,
    });
  }

  const text = formatPositionsList(positions);
  await interaction.editReply(text);
}
