import { ChatInputCommandInteraction } from 'discord.js';
import type { BotContext } from '../index';

const WINDOWS = [
  { label: '24h', ms: 24 * 60 * 60 * 1000 },
  { label: '7d', ms: 7 * 24 * 60 * 60 * 1000 },
  { label: '30d', ms: 30 * 24 * 60 * 60 * 1000 },
];

export async function handleStats(interaction: ChatInputCommandInteraction, ctx: BotContext): Promise<void> {
  const scope = interaction.options.getString('scope') ?? 'me';
  const now = Date.now();

  if (scope === 'me') {
    // Personal stats, ephemeral.
    const userId = `discord:${interaction.user.id}`;
    const vaultPda = ctx.walletService.getDepositAddress(userId);

    if (!vaultPda) {
      await interaction.reply({
        content: 'No vault registered. Run `/start` first.',
        ephemeral: true,
      });
      return;
    }

    const lines = [`**your stats** · <@${interaction.user.id}>`];
    for (const w of WINDOWS) {
      const usd = ctx.walletService.getUserVolumeUsd(vaultPda, now - w.ms);
      lines.push(`\`${w.label.padEnd(4)}\` · $${fmtUsd(usd)}`);
    }
    const allTime = ctx.walletService.getUserVolumeUsd(vaultPda, 0);
    lines.push(`\`all \` · $${fmtUsd(allTime)}`);

    await interaction.reply({ content: lines.join('\n'), ephemeral: true });
    return;
  }

  // Global stats, public.
  const totalUsers = ctx.walletService.getTotalRegisteredUsers();
  const activeUsers = ctx.walletService.getActiveUserCount();
  const totalFills = ctx.walletService.getTotalHarvestCount();
  const openPositions = ctx.walletService.getTotalOpenPositions();

  const lines = ['**crank.money — protocol stats**'];
  for (const w of WINDOWS) {
    const usd = ctx.walletService.getTotalVolumeUsd(now - w.ms);
    lines.push(`\`${w.label.padEnd(4)}\` · $${fmtUsd(usd)}`);
  }
  const allTime = ctx.walletService.getTotalVolumeUsd(0);
  lines.push(`\`all \` · $${fmtUsd(allTime)}`);
  lines.push('');
  lines.push(`\`users     \` · ${activeUsers} active / ${totalUsers} registered`);
  lines.push(`\`fills     \` · ${totalFills}`);
  lines.push(`\`open pos  \` · ${openPositions}`);

  await interaction.reply({
    content: lines.join('\n'),
    allowedMentions: { parse: [] },
  });
}

function fmtUsd(n: number): string {
  if (n === 0) return '0';
  if (n >= 1000) return n.toLocaleString('en-US', { maximumFractionDigits: 0 });
  if (n >= 10) return n.toFixed(0);
  if (n >= 1) return n.toFixed(2);
  return n.toFixed(4);
}
