import { ChatInputCommandInteraction } from 'discord.js';
import { PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import {
  GAUGE_VOTER_PROGRAM_ID, BANK_MINT, TOKEN_PROGRAM_ID,
  getGaugeConfigPDA, getPoolGaugePDA, deriveATA,
  loadGauges, buildPriorityFeeIxs, signAndSend, withUserLock,
} from '@crankbot/core-sdk';
import { formatError } from '../formatter';
import type { BotContext } from '../index';

// vote discriminator from gauge-voter IDL
const VOTE_DISC = Buffer.from([227, 110, 155, 23, 136, 126, 172, 25]);

export async function handleVote(interaction: ChatInputCommandInteraction, ctx: BotContext): Promise<void> {
  const userId = `discord:${interaction.user.id}`;
  const allocationStr = interaction.options.getString('allocation');

  const pubkey = ctx.walletService.getUserPublicKey(userId);
  if (!pubkey) {
    await interaction.reply({ content: formatError('run /start first to create your wallet.'), ephemeral: true });
    return;
  }

  const gauges = loadGauges();
  const gaugeEntries = Object.entries(gauges); // [["SOL", "HTvj..."], ["CRANK", "9R9g..."]]

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
    // Single token = 100% to that pair
    allocations = [{ token: parts[0].toUpperCase(), pct: 100 }];
  } else if (parts.length % 2 === 0) {
    // Pairs of TOKEN PCT
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

  try {
    const sig = await withUserLock(lockKey, async () => {
      const keypair = ctx.walletService.getOrCreate(userId);
      const user = keypair.publicKey;

      const [gaugeConfig] = getGaugeConfigPDA();
      const bankTokenProgram = TOKEN_PROGRAM_ID;
      const userBankAta = deriveATA(BANK_MINT, user, bankTokenProgram, false);

      // Build desired_allocations: Vec<PoolAllocation { lb_pair: Pubkey, weight_bps: u16 }>
      const allocLen = resolved.length;
      const dataLen = 8 + 4 + (allocLen * 34);
      const data = Buffer.alloc(dataLen);
      let offset = 0;

      VOTE_DISC.copy(data, offset); offset += 8;
      data.writeUInt32LE(allocLen, offset); offset += 4;
      for (const a of resolved) {
        a.lbPair.toBuffer().copy(data, offset); offset += 32;
        data.writeUInt16LE(a.weightBps, offset); offset += 2;
      }

      // PoolGauge PDAs as remaining_accounts
      const remainingAccounts = resolved.map(a => {
        const [gaugePDA] = getPoolGaugePDA(a.lbPair);
        return { pubkey: gaugePDA, isSigner: false, isWritable: true };
      });

      const ix = new TransactionInstruction({
        programId: GAUGE_VOTER_PROGRAM_ID,
        keys: [
          { pubkey: user, isSigner: true, isWritable: false },
          { pubkey: gaugeConfig, isSigner: false, isWritable: false },
          { pubkey: BANK_MINT, isSigner: false, isWritable: false },
          { pubkey: userBankAta, isSigner: false, isWritable: false },
          { pubkey: bankTokenProgram, isSigner: false, isWritable: false },
          ...remainingAccounts,
        ],
        data,
      });

      const priorityIxs = await buildPriorityFeeIxs(ctx.connection);
      const { blockhash, lastValidBlockHeight } = await ctx.connection.getLatestBlockhash();
      const msg = new TransactionMessage({
        payerKey: user,
        recentBlockhash: blockhash,
        instructions: [...priorityIxs, ix],
      }).compileToV0Message();
      const vtx = new VersionedTransaction(msg);

      return await signAndSend(vtx, keypair, ctx.connection, blockhash, lastValidBlockHeight);
    });

    const summary = resolved.map(a => `${a.token}: ${a.weightBps / 100}%`).join('\n');
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
