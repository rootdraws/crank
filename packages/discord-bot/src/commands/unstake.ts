import { ChatInputCommandInteraction } from 'discord.js';
import { PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import {
  PEGGED_MINT, TOKEN_PROGRAM_ID,
  deriveATA, formatAmount,
  buildPriorityFeeIxs, signAndSend, withUserLock,
} from '@crankbot/core-sdk';
import { formatError } from '../formatter';
import type { BotContext } from '../index';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// SPL Stake Pool WithdrawSol variant = 16
// Layout: [16, amount: u64 LE]
const WITHDRAW_SOL_VARIANT = 16;

function loadPoolInfo(): any {
  const filePath = process.env.POOL_INFO_PATH
    || path.resolve(__dirname, '..', '..', '..', '..', 'pool-info.json');
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

export async function handleUnstake(interaction: ChatInputCommandInteraction, ctx: BotContext): Promise<void> {
  const userId = `discord:${interaction.user.id}`;
  const amountStr = interaction.options.getString('amount', true).trim().toLowerCase();

  await interaction.deferReply({ ephemeral: false });

  const lockKey = `${userId}:unstake`;

  try {
    const result = await withUserLock(lockKey, async () => {
      const keypair = ctx.walletService.getOrCreate(userId);
      const user = keypair.publicKey;

      const peggedTokenProgram = TOKEN_PROGRAM_ID; // $PEGGED is SPL Token
      const userPeggedAta = deriveATA(PEGGED_MINT, user, peggedTokenProgram, false);

      // Resolve amount
      let amount: bigint;
      if (amountStr === 'all') {
        const ataAccount = await ctx.connection.getAccountInfo(userPeggedAta);
        if (!ataAccount) throw new Error('no $PEGGED balance');
        amount = Buffer.from(ataAccount.data).readBigUInt64LE(64);
        if (amount === 0n) throw new Error('$PEGGED balance is 0');
      } else {
        const amountFloat = parseFloat(amountStr);
        if (isNaN(amountFloat) || amountFloat <= 0) throw new Error('invalid amount');
        amount = BigInt(Math.round(amountFloat * 1e9)); // $PEGGED has 9 decimals
      }

      // Load stake pool info
      const info = loadPoolInfo();
      const stakePool = new PublicKey(info.pool);
      const withdrawAuthority = new PublicKey(info.withdrawAuthority);
      const reserveStake = new PublicKey(info.reserveStake);
      const managerFeeAccount = new PublicKey(info.managerFeeAccount);
      const splStakePoolProgram = new PublicKey(info.program);

      // Check reserve has enough SOL for instant withdrawal
      const reserveBalance = await ctx.connection.getBalance(reserveStake);
      const reserveRent = 2_282_880; // stake account rent exemption
      const reserveAvailable = reserveBalance - reserveRent;
      // Rough estimate: $PEGGED ≈ SOL 1:1 (LST)
      if (reserveAvailable < Number(amount) / 1e9 * 1e9 * 0.9) {
        throw new Error('stake pool reserve too low for instant withdrawal — try a smaller amount or wait for next epoch');
      }

      // Build WithdrawSol instruction
      // Accounts: https://github.com/solana-labs/solana-program-library/blob/master/stake-pool/program/src/instruction.rs
      const data = Buffer.alloc(9);
      data[0] = WITHDRAW_SOL_VARIANT;
      data.writeBigUInt64LE(amount, 1);

      const ix = new TransactionInstruction({
        programId: splStakePoolProgram,
        keys: [
          { pubkey: stakePool, isSigner: false, isWritable: true },          // stake_pool
          { pubkey: withdrawAuthority, isSigner: false, isWritable: false },  // withdraw_authority
          { pubkey: user, isSigner: true, isWritable: true },                // user_transfer_authority
          { pubkey: userPeggedAta, isSigner: false, isWritable: true },      // burn_from (user's pool token ATA)
          { pubkey: reserveStake, isSigner: false, isWritable: true },       // reserve_stake
          { pubkey: user, isSigner: false, isWritable: true },               // sol_destination
          { pubkey: managerFeeAccount, isSigner: false, isWritable: true },  // manager_fee_account
          { pubkey: PEGGED_MINT, isSigner: false, isWritable: true },        // pool_mint
          { pubkey: new PublicKey('SysvarC1ock11111111111111111111111111111111'), isSigner: false, isWritable: false },
          { pubkey: new PublicKey('SysvarStakeHistory1111111111111111111111111'), isSigner: false, isWritable: false },
          { pubkey: new PublicKey('Stake11111111111111111111111111111111111111'), isSigner: false, isWritable: false },
          { pubkey: peggedTokenProgram, isSigner: false, isWritable: false }, // token_program
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

      const sig = await signAndSend(vtx, keypair, ctx.connection, blockhash, lastValidBlockHeight);

      return { sig, amount };
    });

    const humanAmount = formatAmount(result.amount, 9);
    await interaction.editReply(
      `Unstaked ${humanAmount} $PEGGED → SOL\n` +
      `tx: \`${result.sig}\``
    );
  } catch (e: any) {
    const errMsg = e.message?.slice(0, 200) || 'unknown error';
    if (interaction.deferred) {
      await interaction.editReply(formatError(errMsg));
    } else {
      await interaction.reply({ content: formatError(errMsg), ephemeral: true });
    }
  }
}
