import { ChatInputCommandInteraction } from 'discord.js';
import { PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import {
  BANK_MINT_PROGRAM_ID, BANK_MINT, CRANK_MINT,
  TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID,
  getBankConfigPDA, deriveATA, formatAmount,
  buildSetupTx, buildPriorityFeeIxs, signAndSend, signAndSendLegacy, withUserLock,
} from '@crankbot/core-sdk';
import { formatError } from '../formatter';
import type { BotContext } from '../index';

// burn_and_mint discriminator from bank-mint IDL
const BURN_AND_MINT_DISC = Buffer.from([203, 142, 66, 81, 199, 170, 67, 130]);

export async function handleBurn(interaction: ChatInputCommandInteraction, ctx: BotContext): Promise<void> {
  const userId = `discord:${interaction.user.id}`;
  const amountStr = interaction.options.getString('amount', true).trim();

  const amountFloat = parseFloat(amountStr);
  if (isNaN(amountFloat) || amountFloat <= 0) {
    await interaction.reply({
      content: formatError('invalid amount.', '/burn 1000000'),
      ephemeral: true,
    });
    return;
  }

  // CRANK has 6 decimals
  const amount = BigInt(Math.round(amountFloat * 1e6));

  await interaction.deferReply({ ephemeral: false });

  const lockKey = `${userId}:burn`;

  try {
    const sig = await withUserLock(lockKey, async () => {
      const keypair = ctx.walletService.getOrCreate(userId);
      const user = keypair.publicKey;

      // CRANK is Token-2022, BANK is SPL Token
      const crankTokenProgram = TOKEN_2022_PROGRAM_ID;
      const bankTokenProgram = TOKEN_PROGRAM_ID;

      const userCrankAta = deriveATA(CRANK_MINT, user, crankTokenProgram, false);
      const userBankAta = deriveATA(BANK_MINT, user, bankTokenProgram, false);
      const [bankConfig] = getBankConfigPDA();

      // Ensure user's BANK ATA exists
      const setupTx = await buildSetupTx(
        ctx.connection, user,
        [{ ata: userBankAta, owner: user, mint: BANK_MINT, tokenProgram: bankTokenProgram }],
        []
      );

      if (setupTx) {
        await signAndSendLegacy(setupTx, keypair, ctx.connection);
      }

      // Build burn_and_mint instruction
      const data = Buffer.alloc(8 + 8);
      BURN_AND_MINT_DISC.copy(data, 0);
      data.writeBigUInt64LE(amount, 8);

      const ix = new TransactionInstruction({
        programId: BANK_MINT_PROGRAM_ID,
        keys: [
          { pubkey: user, isSigner: true, isWritable: true },
          { pubkey: bankConfig, isSigner: false, isWritable: true },
          { pubkey: CRANK_MINT, isSigner: false, isWritable: true },
          { pubkey: BANK_MINT, isSigner: false, isWritable: true },
          { pubkey: userCrankAta, isSigner: false, isWritable: true },
          { pubkey: userBankAta, isSigner: false, isWritable: true },
          { pubkey: crankTokenProgram, isSigner: false, isWritable: false },
          { pubkey: bankTokenProgram, isSigner: false, isWritable: false },
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

    const humanAmount = formatAmount(amount, 6);
    await interaction.editReply(
      `Burned ${humanAmount} CRANK → minted ${humanAmount} BANK\n` +
      `tx: \`${sig}\``
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
