/**
 * enable-token.ts
 *
 * Handles the "Enable $TOKEN" button interaction.
 * Creates token ATAs on the user's vault so they can deposit and trade.
 */

import { ButtonInteraction } from 'discord.js';
import { PublicKey, Transaction } from '@solana/web3.js';
import {
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, KNOWN_TOKENS } from '@crankbot/core-sdk';
import type { BotContext } from '../index';

/**
 * Button customId format: enable_token:<mint>
 */
export async function handleEnableToken(interaction: ButtonInteraction, ctx: BotContext): Promise<void> {
  const userId = `discord:${interaction.user.id}`;
  const mint58 = interaction.customId.split(':')[1];
  if (!mint58) {
    await interaction.reply({ content: 'Invalid token.', ephemeral: true });
    return;
  }

  const vaultPda = ctx.walletService.getVaultPda(userId);
  if (!vaultPda) {
    await interaction.reply({ content: 'No vault found. Run `/start` first.', ephemeral: true });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  const mint = new PublicKey(mint58);
  const symbol = KNOWN_TOKENS[mint58] || mint58.slice(0, 6) + '...';

  try {
    // Resolve token program from on-chain mint
    const mintInfo = await ctx.connection.getAccountInfo(mint);
    if (!mintInfo) {
      await interaction.editReply(`Token mint not found on-chain.`);
      return;
    }
    const tokenProgram = mintInfo.owner.equals(TOKEN_2022_PROGRAM_ID)
      ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;

    const ata = getAssociatedTokenAddressSync(mint, vaultPda, true, tokenProgram);

    // Check if already exists
    const ataInfo = await ctx.connection.getAccountInfo(ata);
    if (ataInfo) {
      await interaction.editReply(`**$${symbol}** is already enabled on your vault.`);
      return;
    }

    // Create ATA
    const tx = new Transaction().add(
      createAssociatedTokenAccountIdempotentInstruction(
        ctx.botKeypair.publicKey, ata, vaultPda, mint, tokenProgram,
      ),
    );
    tx.feePayer = ctx.botKeypair.publicKey;
    tx.recentBlockhash = (await ctx.connection.getLatestBlockhash()).blockhash;
    tx.sign(ctx.botKeypair);
    await ctx.connection.sendRawTransaction(tx.serialize());

    await interaction.editReply(
      `**$${symbol}** enabled on your vault.\n\n` +
      `To trade $${symbol}, send it to your vault first:\n` +
      `\`${vaultPda.toBase58()}\`\n\n` +
      `Then run your \`/sell\` or \`/buy\` command again.`
    );
  } catch (e: any) {
    console.error(`[enable-token] Error for ${userId}:`, e.message?.slice(0, 200));
    await interaction.editReply(`Failed to enable $${symbol}: ${e.message?.slice(0, 100)}`);
  }
}
