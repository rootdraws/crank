/**
 * /treasury — Path B (treasury-matched governance) read-only inspection.
 *
 * Subcommands:
 *   /treasury status     — vault balances, uncommitted capacity, payout/match config
 *   /treasury positions  — list open treasury-matched positions
 *
 * No-ops cleanly when ctx.treasury is undefined (Path B disabled).
 */

import { ChatInputCommandInteraction } from 'discord.js';
import { PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import { CRANK_MINT, NATIVE_MINT, loadPoolRegistry, TOKEN_PROGRAM_ID } from '@crankbot/core-sdk';
import type { BotContext } from '../index';

const PAYOUT_BPS_OFFSET = 220;
const MATCH_RATIO_BPS_OFFSET = 222;

export async function handleTreasury(interaction: ChatInputCommandInteraction, ctx: BotContext): Promise<void> {
  const sub = interaction.options.getSubcommand(false);
  switch (sub) {
    case 'status':    return handleTreasuryStatus(interaction, ctx);
    case 'positions': return handleTreasuryPositions(interaction, ctx);
    default:
      await interaction.reply({ content: 'Use `/treasury status` or `/treasury positions`.', ephemeral: true });
  }
}

async function handleTreasuryStatus(interaction: ChatInputCommandInteraction, ctx: BotContext): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  if (!ctx.treasury) {
    await interaction.editReply('Treasury matching (Path B) is not active on this bot.');
    return;
  }

  const treasuryVault = ctx.treasury.treasuryUserVault;

  // Balances: native SOL + CRANK ATA
  const [solLamports, crankBal] = await Promise.all([
    ctx.connection.getBalance(treasuryVault).catch(() => 0),
    (async () => {
      try {
        const ata = getAssociatedTokenAddressSync(CRANK_MINT, treasuryVault, true, TOKEN_PROGRAM_ID);
        const r = await ctx.connection.getTokenAccountBalance(ata);
        return BigInt(r.value.amount);
      } catch { return 0n; }
    })(),
  ]);

  const sol = (solLamports / 1e9).toFixed(4);
  const crank = (Number(crankBal) / 1e6).toFixed(0);

  // Open commitments across pools — sum matched_amount per output mint
  const openPositions = ctx.walletService.listOpenTreasuryPositions();
  let openCount = openPositions.length;
  let solCommitted = 0n;
  let crankCommitted = 0n;
  for (const p of openPositions) {
    const amt = BigInt(p.matched_amount);
    // matched_amount is in DEPOSIT mint units. side='Sell' → deposit X (CRANK typically),
    // side='Buy' → deposit Y (SOL typically). Best-effort categorize.
    if (p.side === 'Buy') solCommitted += amt;
    else crankCommitted += amt;
  }
  const solCommittedDisplay = (Number(solCommitted) / 1e9).toFixed(4);
  const crankCommittedDisplay = (Number(crankCommitted) / 1e6).toFixed(0);

  // On-chain Config: payout_bps (offset 220), match_ratio_bps (offset 222)
  let payoutBps = 0;
  let matchRatioBps = 0;
  try {
    const info = await ctx.connection.getAccountInfo(ctx.configPDA);
    if (info && info.data.length >= MATCH_RATIO_BPS_OFFSET + 2) {
      payoutBps = info.data.readUInt16LE(PAYOUT_BPS_OFFSET);
      matchRatioBps = info.data.readUInt16LE(MATCH_RATIO_BPS_OFFSET);
    }
  } catch { /* best-effort */ }

  const payoutPct = (payoutBps / 100).toFixed(2);
  const matchRatio = (matchRatioBps / 10000).toFixed(2);

  const lines = [
    `**Treasury status**`,
    ``,
    `Vault: \`${treasuryVault.toBase58()}\``,
    `SOL:   ${sol}  (committed in open matches: ${solCommittedDisplay})`,
    `CRANK: ${crank}  (committed: ${crankCommittedDisplay})`,
    ``,
    `Open matched positions: ${openCount}`,
    `Pending in-flight queue: ${ctx.treasury.orchestrator.pendingCount()}`,
    ``,
    `Config:`,
    `  payout to proposer:  ${payoutPct}%  (${payoutBps} bps)`,
    `  treasury match ratio: ${matchRatio}x  (${matchRatioBps} bps)`,
  ];
  await interaction.editReply(lines.join('\n'));
}

async function handleTreasuryPositions(interaction: ChatInputCommandInteraction, ctx: BotContext): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  if (!ctx.treasury) {
    await interaction.editReply('Treasury matching (Path B) is not active on this bot.');
    return;
  }

  const open = ctx.walletService.listOpenTreasuryPositions();
  if (open.length === 0) {
    await interaction.editReply('No open treasury-matched positions.');
    return;
  }

  // Sort newest first
  open.sort((a, b) => b.opened_at - a.opened_at);

  const pools = loadPoolRegistry();
  const poolName = (lb: string): string => {
    const p = pools.find(pc => pc.address === lb);
    return p ? `${p.buyToken}/${p.quoteToken}` : lb.slice(0, 8) + '…';
  };

  const lines = [`**Open treasury matches: ${open.length}**`, ''];
  for (const p of open.slice(0, 20)) {
    const ageMin = Math.max(0, Math.floor((Date.now() - p.opened_at) / 60_000));
    const amt = p.side === 'Buy'
      ? `${(Number(p.matched_amount) / 1e9).toFixed(3)} SOL`
      : `${(Number(p.matched_amount) / 1e6).toFixed(0)} CRANK`;
    lines.push(
      `\`${p.treasury_position_pda.slice(0, 8)}…\` ${p.side} ${poolName(p.lb_pair)} bins ${p.min_bin_id}→${p.max_bin_id} ${amt} (${ageMin}m ago, proposer ${p.proposer_user_id.replace('discord:', '@')})`,
    );
  }
  if (open.length > 20) lines.push(`…and ${open.length - 20} more`);
  await interaction.editReply(lines.join('\n'));
}
