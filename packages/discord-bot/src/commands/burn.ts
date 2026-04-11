import { ChatInputCommandInteraction } from 'discord.js';
import { BN } from '@coral-xyz/anchor';
import {
  BANK_MINT_PROGRAM_ID, BANK_MINT, CRANK_MINT,
  TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID,
  getBankConfigPDA, deriveATA, formatAmount,
  buildSetupTx, signAndSendLegacy, withUserLock,
} from '@crankbot/core-sdk';
import { formatError } from '../formatter';
import type { BotContext } from '../index';

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

  const amount = BigInt(Math.round(amountFloat * 1e6));
  const vaultPda = ctx.walletService.getVaultPda(userId);
  if (!vaultPda) {
    await interaction.reply({ content: 'No vault found. Run `/start` first.', ephemeral: true });
    return;
  }

  await interaction.deferReply({ ephemeral: false });
  const lockKey = `${userId}:burn`;
  const bot = ctx.botKeypair;

  try {
    const sig = await withUserLock(lockKey, async () => {
      const crankTokenProgram = TOKEN_2022_PROGRAM_ID;
      const bankTokenProgram = TOKEN_PROGRAM_ID;

      // ATAs owned by the vault PDA
      const vaultCrankAta = deriveATA(CRANK_MINT, vaultPda, crankTokenProgram, true);
      const vaultBankAta = deriveATA(BANK_MINT, vaultPda, bankTokenProgram, true);
      const [bankConfig] = getBankConfigPDA();

      // Ensure vault's BANK ATA exists (bot pays)
      const setupTx = await buildSetupTx(
        ctx.connection, bot.publicKey,
        [{ ata: vaultBankAta, owner: vaultPda, mint: BANK_MINT, tokenProgram: bankTokenProgram }],
        []
      );
      if (setupTx) {
        await signAndSendLegacy(setupTx, bot, ctx.connection);
      }

      // Call vault_burn_and_mint via the core program (CPI to bank-mint)
      return await ctx.coreProgram.methods
        .vaultBurnAndMint(new BN(amount.toString()))
        .accounts({
          caller: bot.publicKey,
          config: ctx.configPDA,
          userVault: vaultPda,
          bankConfig,
          crankMint: CRANK_MINT,
          bankMint: BANK_MINT,
          vaultCrankAta,
          vaultBankAta,
          crankTokenProgram,
          bankTokenProgram,
          bankMintProgram: BANK_MINT_PROGRAM_ID,
        })
        .signers([bot])
        .rpc();
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
