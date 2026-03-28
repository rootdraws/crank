import { ChatInputCommandInteraction } from 'discord.js';
import type { BotContext } from '../index';

export async function handleVote(interaction: ChatInputCommandInteraction, ctx: BotContext): Promise<void> {
  const userId = `discord:${interaction.user.id}`;
  const allocationStr = interaction.options.getString('allocation');

  const pubkey = ctx.walletService.getUserPublicKey(userId);
  if (!pubkey) {
    await interaction.reply({ content: 'Run /start first to create your wallet.', ephemeral: true });
    return;
  }

  if (!allocationStr) {
    const votes = ctx.walletService.getVotes(pubkey.toBase58());
    if (Object.keys(votes).length === 0) {
      await interaction.reply({ content: 'No active votes.\nUsage: /vote SOL 50 CRANK 50', ephemeral: true });
    } else {
      let msg = 'Your vote allocations:\n\n';
      for (const [pool, pct] of Object.entries(votes)) {
        msg += `${pool.slice(0, 8)}...: ${pct}%\n`;
      }
      await interaction.reply({ content: msg, ephemeral: true });
    }
    return;
  }

  const parts = allocationStr.trim().split(/\s+/);
  if (parts.length % 2 !== 0) {
    await interaction.reply({ content: '🦧 pairs of POOL PCT expected.\n   e.g. /vote SOL 50 CRANK 50', ephemeral: true });
    return;
  }

  const allocations: Record<string, number> = {};
  for (let i = 0; i < parts.length; i += 2) {
    const pool = parts[i];
    const pct = parseInt(parts[i + 1], 10);
    if (isNaN(pct)) {
      await interaction.reply({ content: `🦧 "${parts[i + 1]}" is not a number.`, ephemeral: true });
      return;
    }
    allocations[pool] = pct;
  }

  const total = Object.values(allocations).reduce((s, p) => s + p, 0);
  if (total !== 100) {
    await interaction.reply({ content: `🦧 allocations must sum to 100, got ${total}.`, ephemeral: true });
    return;
  }

  ctx.walletService.setVotes(pubkey.toBase58(), allocations);
  const summary = Object.entries(allocations).map(([p, pct]) => `${p}: ${pct}%`).join('\n');
  await interaction.reply({ content: `Votes saved.\n\n${summary}`, ephemeral: true });
}
