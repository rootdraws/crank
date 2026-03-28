import { ChatInputCommandInteraction } from 'discord.js';
import { PublicKey } from '@solana/web3.js';
import {
  parseLbPairFull, binToPrice, formatPrice,
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

    positions.push({
      positionPda: p.position_pda,
      lbPair: p.lb_pair,
      poolName: p.lb_pair.slice(0, 8) + '...',
      side: p.side as 'Buy' | 'Sell',
      minBinId: p.min_bin_id,
      maxBinId: p.max_bin_id,
      activeBinId: poolData.activeId,
      binStep: poolData.binStep,
      decimalsX: 9,
      decimalsY: 6,
      initialAmount: BigInt(p.initial_amount),
      harvestedAmount: 0n,
      tokenSymbol: p.side === 'Buy' ? 'TOKEN' : 'SOL',
      quoteSymbol: p.side === 'Buy' ? 'SOL' : 'TOKEN',
      quoteDecimals: p.side === 'Buy' ? 6 : 9,
      createdAt: p.created_at,
    });
  }

  const text = formatPositionsList(positions);
  await interaction.editReply(text);
}
