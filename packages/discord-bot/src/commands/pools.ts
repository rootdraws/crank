import { ChatInputCommandInteraction } from 'discord.js';
import { loadPoolRegistry, parseLbPairFull, binToPrice, fetchDexScreenerPrice } from '@crankbot/core-sdk';
import { formatPoolsList } from '../formatter';
import type { BotContext } from '../index';

export async function handlePools(interaction: ChatInputCommandInteraction, ctx: BotContext): Promise<void> {
  const pools = loadPoolRegistry();

  await interaction.deferReply({ ephemeral: true });

  // Fetch current price for each pair (deduplicated by buyToken)
  const seen = new Set<string>();
  const priceMap = new Map<string, number>();
  const mcMap = new Map<string, number>();

  for (const p of pools) {
    const key = p.buyToken.toUpperCase();
    if (seen.has(key)) continue;
    seen.add(key);

    try {
      if (p.priceSource === 'dexscreener') {
        // External price for tokens without DLMM liquidity
        const data = await fetchDexScreenerPrice(p.mintX);
        if (data) {
          priceMap.set(key, data.priceUsd);
          if (p.displayMode === 'mc' && data.marketCap) {
            mcMap.set(key, data.marketCap);
          } else if (p.displayMode === 'mc' && p.supply) {
            mcMap.set(key, data.priceUsd * p.supply);
          }
        }
      } else {
        // Default: read from DLMM pool activeId
        const subInfo = ctx.subscriber?.getPoolInfo?.(p.address);
        let activeId: number;
        let binStep: number;

        if (subInfo) {
          activeId = subInfo.activeId;
          binStep = subInfo.binStep;
        } else {
          const poolData = await parseLbPairFull(ctx.connection, p.address);
          activeId = poolData.activeId;
          binStep = poolData.binStep;
        }

        const price = binToPrice(activeId, binStep, p.decimalsX, p.decimalsY);
        priceMap.set(key, price);
        if (p.displayMode === 'mc' && p.supply) {
          mcMap.set(key, price * p.supply);
        }
      }
    } catch { /* skip */ }
  }

  const text = formatPoolsList(pools.map(p => ({
    label: p.label,
    id: p.id,
    displayMode: p.displayMode,
    binStep: p.binStep,
    example: p.example,
    buyToken: p.buyToken,
    currentPrice: priceMap.get(p.buyToken.toUpperCase()),
    currentMc: mcMap.get(p.buyToken.toUpperCase()),
  })));

  await interaction.editReply(text);
}
