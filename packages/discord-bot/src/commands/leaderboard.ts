import { ChatInputCommandInteraction } from 'discord.js';
import type { BotContext } from '../index';
import { loadPoolRegistry } from '@crankbot/core-sdk';

const DEFAULT_WINDOW_DAYS = 7;
const TOP_N = 10;

export async function handleLeaderboard(interaction: ChatInputCommandInteraction, ctx: BotContext): Promise<void> {
  const days = interaction.options.getInteger('days') ?? DEFAULT_WINDOW_DAYS;
  const tokenArg = interaction.options.getString('token')?.trim().toUpperCase();
  const sinceMs = Date.now() - days * 24 * 60 * 60 * 1000;

  // Resolve optional token filter → set of LbPair addresses.
  let lbPairFilter: Set<string> | undefined;
  let filterLabel = '';
  if (tokenArg) {
    const pools = loadPoolRegistry();
    const matchingAddresses = pools
      .filter(p => p.tokenX.toUpperCase() === tokenArg || p.tokenY.toUpperCase() === tokenArg)
      .map(p => p.address);
    if (matchingAddresses.length === 0) {
      await interaction.reply({
        content: `no pools matching "${tokenArg}". try /pools.`,
        ephemeral: true,
      });
      return;
    }
    lbPairFilter = new Set(matchingAddresses);
    filterLabel = ` · ${tokenArg}`;
  }

  const allRows = ctx.walletService.getLeaderboard(sinceMs, lbPairFilter);
  const rows = allRows.slice(0, TOP_N);

  if (rows.length === 0) {
    await interaction.reply({
      content: `no activity in the last ${days}d${filterLabel}`,
      ephemeral: true,
    });
    return;
  }

  const callerDiscordId = `discord:${interaction.user.id}`;
  const callerIdx = allRows.findIndex(r => r.userId === callerDiscordId);
  const callerInTop = callerIdx >= 0 && callerIdx < TOP_N;

  const lines = rows.map((r, i) => {
    const handle = r.userId.startsWith('discord:') ? `<@${r.userId.slice(8)}>` : r.userId;
    const open = r.openPositions > 0 ? ` · ${r.openPositions} open` : '';
    const you = callerIdx === i ? ' ← you' : '';
    return `\`${String(i + 1).padStart(2)}\` ${handle} · ${r.harvestCount} fills${open}${you}`;
  });

  // Rank stripe: if the caller is outside top 10 but in the list, append their
  // row. If they aren't in the list at all, say so.
  if (!callerInTop) {
    if (callerIdx >= 0) {
      const me = allRows[callerIdx];
      const open = me.openPositions > 0 ? ` · ${me.openPositions} open` : '';
      lines.push('');
      lines.push(`\`${String(callerIdx + 1).padStart(2)}\` <@${interaction.user.id}> · ${me.harvestCount} fills${open} ← you`);
    } else {
      lines.push('');
      lines.push(`_You're unranked in this window — open or fill a position to get on the board._`);
    }
  }

  const header = `**leaderboard — last ${days}d${filterLabel}**`;
  await interaction.reply({
    content: [header, ...lines].join('\n'),
    allowedMentions: { parse: [] },
  });
}
