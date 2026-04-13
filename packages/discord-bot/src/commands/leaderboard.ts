import { ChatInputCommandInteraction } from 'discord.js';
import type { BotContext } from '../index';

const DEFAULT_WINDOW_DAYS = 7;
const TOP_N = 10;

export async function handleLeaderboard(interaction: ChatInputCommandInteraction, ctx: BotContext): Promise<void> {
  const days = interaction.options.getInteger('days') ?? DEFAULT_WINDOW_DAYS;
  const sinceMs = Date.now() - days * 24 * 60 * 60 * 1000;

  const rows = ctx.walletService.getLeaderboard(sinceMs).slice(0, TOP_N);

  if (rows.length === 0) {
    await interaction.reply({
      content: `no activity in the last ${days}d`,
      ephemeral: true,
    });
    return;
  }

  const lines = rows.map((r, i) => {
    const handle = r.userId.startsWith('discord:') ? `<@${r.userId.slice(8)}>` : r.userId;
    const vol = formatLamports(r.harvestVolume);
    const open = r.openPositions > 0 ? ` · ${r.openPositions} open` : '';
    return `\`${String(i + 1).padStart(2)}\` ${handle} · ${r.harvestCount} fills · ${vol}${open}`;
  });

  const header = `**leaderboard — last ${days}d**`;
  await interaction.reply({
    content: [header, ...lines].join('\n'),
    allowedMentions: { parse: [] },
  });
}

function formatLamports(amount: bigint): string {
  // Harvest volume is mixed tokens (SOL + CRANK + others). Show raw counts
  // instead of guessing decimals — the fill count is the real signal.
  if (amount === 0n) return '0';
  const s = amount.toString();
  if (s.length > 9) return `${s.slice(0, -9)} (≈SOL)`;
  return s;
}
