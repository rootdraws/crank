import { ChatInputCommandInteraction } from 'discord.js';
import { PublicKey } from '@solana/web3.js';
import {
  GAUGE_VOTER_PROGRAM_ID, BANK_MINT, TOKEN_PROGRAM_ID,
  getGaugeConfigPDA, getPoolGaugePDA, deriveATA,
  loadGauges, withUserLock,
} from '@crankbot/core-sdk';
import { formatError } from '../formatter';
import type { BotContext } from '../index';

export async function handleVote(interaction: ChatInputCommandInteraction, ctx: BotContext): Promise<void> {
  const userId = `discord:${interaction.user.id}`;
  const allocationStr = interaction.options.getString('allocation');

  const vaultPda = ctx.walletService.getVaultPda(userId);
  if (!vaultPda) {
    await interaction.reply({ content: formatError('run /start first to create your vault.'), ephemeral: true });
    return;
  }

  const gauges = loadGauges();
  const gaugeEntries = Object.entries(gauges);

  if (gaugeEntries.length === 0) {
    await interaction.reply({ content: formatError('no gauges registered.'), ephemeral: true });
    return;
  }

  // No allocation = show current on-chain gauge weights
  if (!allocationStr) {
    await interaction.deferReply({ ephemeral: true });
    let msg = '**Gauge weights:**\n\n';
    for (const [token, addr] of gaugeEntries) {
      try {
        const [gaugePDA] = getPoolGaugePDA(new PublicKey(addr));
        const gaugeAccount = await ctx.connection.getAccountInfo(gaugePDA);
        if (gaugeAccount && gaugeAccount.data.length >= 48) {
          const weightBps = Buffer.from(gaugeAccount.data).readBigUInt64LE(40);
          msg += `${token}: ${(Number(weightBps) / 100).toFixed(1)}%\n`;
        }
      } catch { /* skip */ }
    }
    msg += '\nUsage: `/vote SOL` or `/vote SOL 50 CRANK 50`';
    await interaction.editReply(msg);
    return;
  }

  // Parse allocations
  const parts = allocationStr.trim().split(/\s+/);
  let allocations: { token: string; pct: number }[];

  if (parts.length === 1) {
    allocations = [{ token: parts[0].toUpperCase(), pct: 100 }];
  } else if (parts.length % 2 === 0) {
    allocations = [];
    for (let i = 0; i < parts.length; i += 2) {
      const token = parts[i].toUpperCase();
      const pct = parseInt(parts[i + 1], 10);
      if (isNaN(pct) || pct < 0) {
        await interaction.reply({ content: formatError(`"${parts[i + 1]}" is not a valid percentage.`), ephemeral: true });
        return;
      }
      allocations.push({ token, pct });
    }
  } else {
    await interaction.reply({
      content: formatError('use `/vote SOL` or `/vote SOL 50 CRANK 50`.'),
      ephemeral: true,
    });
    return;
  }

  const total = allocations.reduce((s, a) => s + a.pct, 0);
  if (total !== 100) {
    await interaction.reply({ content: formatError(`allocations must sum to 100, got ${total}.`), ephemeral: true });
    return;
  }

  // Resolve each token to its gauge address
  const resolved: { lbPair: PublicKey; weightBps: number; token: string }[] = [];
  for (const alloc of allocations) {
    const gaugeAddr = gauges[alloc.token];
    if (!gaugeAddr) {
      const available = gaugeEntries.map(([t]) => t).join(', ');
      await interaction.reply({
        content: formatError(`no gauge for "${alloc.token}".`, `available: ${available}`),
        ephemeral: true,
      });
      return;
    }
    resolved.push({
      lbPair: new PublicKey(gaugeAddr),
      weightBps: alloc.pct * 100,
      token: alloc.token,
    });
  }

  await interaction.deferReply({ ephemeral: false });
  const lockKey = `${userId}:vote`;
  const bot = ctx.botKeypair;

  try {
    const sig = await withUserLock(lockKey, async () => {
      const [gaugeConfig] = getGaugeConfigPDA();
      const vaultBankAta = deriveATA(BANK_MINT, vaultPda, TOKEN_PROGRAM_ID, true);

      // Build desired_allocations for the CPI wrapper
      const desiredAllocations = resolved.map(a => ({
        lbPair: a.lbPair,
        weightBps: a.weightBps,
      }));

      // PoolGauge PDAs as remaining_accounts
      const remainingAccounts = resolved.map(a => {
        const [gaugePDA] = getPoolGaugePDA(a.lbPair);
        return { pubkey: gaugePDA, isSigner: false, isWritable: true };
      });

      return await ctx.coreProgram.methods
        .vaultVote(desiredAllocations)
        .accounts({
          caller: bot.publicKey,
          config: ctx.configPDA,
          userVault: vaultPda,
          gaugeConfig,
          bankMintAccount: BANK_MINT,
          vaultBankAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          gaugeVoterProgram: GAUGE_VOTER_PROGRAM_ID,
        })
        .remainingAccounts(remainingAccounts)
        .signers([bot])
        .rpc();
    });

    const summary = resolved.map(a => `${a.token}: ${a.weightBps / 100}%`).join('\n');

    // Save votes in wallet service
    const voteMap: Record<string, number> = {};
    for (const a of resolved) voteMap[a.lbPair.toBase58()] = a.weightBps / 100;
    ctx.walletService.setVotes(vaultPda.toBase58(), voteMap);

    await interaction.editReply(`Vote submitted on-chain.\n\n${summary}\n\ntx: \`${sig}\``);
  } catch (e: any) {
    const errMsg = e.message?.slice(0, 200) || 'unknown error';
    if (interaction.deferred) {
      await interaction.editReply(formatError(errMsg));
    } else {
      await interaction.reply({ content: formatError(errMsg), ephemeral: true });
    }
  }
}
