/**
 * /proposals — Path B governance proposal lifecycle inspection.
 *
 * Subcommands:
 *   /proposals pending — list in-flight proposals (pending, inserted, voted)
 *   /proposals failed  — list recent failed/cancelled proposals (debug surface)
 *
 * Read-only: pulls from local DB. The orchestrator's reconciler keeps that in
 * sync with on-chain governance state at startup + periodically.
 */

import { ChatInputCommandInteraction } from 'discord.js';
import type { BotContext } from '../index';

export async function handleProposals(interaction: ChatInputCommandInteraction, ctx: BotContext): Promise<void> {
  const sub = interaction.options.getSubcommand(false);
  switch (sub) {
    case 'pending': return handleProposalsPending(interaction, ctx);
    case 'failed':  return handleProposalsFailed(interaction, ctx);
    default:
      await interaction.reply({ content: 'Use `/proposals pending` or `/proposals failed`.', ephemeral: true });
  }
}

async function handleProposalsPending(interaction: ChatInputCommandInteraction, ctx: BotContext): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  if (!ctx.treasury) {
    await interaction.editReply('Treasury matching (Path B) is not active on this bot.');
    return;
  }

  const recs = ctx.walletService.listProposalsByStatus('pending', 'inserted', 'voted');
  const queued = ctx.treasury.orchestrator.pendingCount();

  if (recs.length === 0 && queued === 0) {
    await interaction.editReply('No in-flight proposals.');
    return;
  }

  recs.sort((a, b) => b.created_at - a.created_at);

  const lines = [`**In-flight: ${recs.length} on-chain, ${queued} queued in worker**`, ''];
  for (const r of recs.slice(0, 20)) {
    const ageS = Math.max(0, Math.floor((Date.now() - r.created_at) / 1000));
    const ago = ageS < 60 ? `${ageS}s` : ageS < 3600 ? `${Math.floor(ageS / 60)}m` : `${Math.floor(ageS / 3600)}h`;
    const pdaShort = r.proposal_pda.length > 16 ? r.proposal_pda.slice(0, 12) + '…' : r.proposal_pda;
    lines.push(`\`${pdaShort}\` ${r.kind}/${r.status} retries=${r.retry_count} (${ago} ago)`);
  }
  if (recs.length > 20) lines.push(`…and ${recs.length - 20} more`);
  await interaction.editReply(lines.join('\n'));
}

async function handleProposalsFailed(interaction: ChatInputCommandInteraction, ctx: BotContext): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  if (!ctx.treasury) {
    await interaction.editReply('Treasury matching (Path B) is not active on this bot.');
    return;
  }

  const recs = ctx.walletService.listProposalsByStatus('failed', 'cancelled');
  if (recs.length === 0) {
    await interaction.editReply('No failed proposals.');
    return;
  }

  recs.sort((a, b) => b.updated_at - a.updated_at);

  const lines = [`**Recent failures: ${recs.length}**`, ''];
  for (const r of recs.slice(0, 15)) {
    const ageS = Math.max(0, Math.floor((Date.now() - r.updated_at) / 1000));
    const ago = ageS < 60 ? `${ageS}s` : ageS < 3600 ? `${Math.floor(ageS / 60)}m` : `${Math.floor(ageS / 3600)}h`;
    const reason = (r.last_error ?? '').slice(0, 80);
    lines.push(`\`${r.proposal_pda.slice(0, 12)}…\` ${r.kind}/${r.status} (${ago} ago) — ${reason}`);
  }
  if (recs.length > 15) lines.push(`…and ${recs.length - 15} more`);
  await interaction.editReply(lines.join('\n'));
}
