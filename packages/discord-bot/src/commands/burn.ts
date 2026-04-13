import { ChatInputCommandInteraction } from 'discord.js';
import { BN } from '@coral-xyz/anchor';
import { PublicKey } from '@solana/web3.js';
import {
  BANK_MINT_PROGRAM_ID, BANK_MINT, CRANK_MINT,
  TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID,
  getBankConfigPDA, getRoverAuthorityPDA, deriveATA, formatAmount,
  buildSetupTx, signAndSendLegacy, withUserLock,
  computeCurve, ppbToPct,
} from '@crankbot/core-sdk';
import { formatError } from '../formatter';
import type { BotContext } from '../index';

async function handleBurnStatus(interaction: ChatInputCommandInteraction, ctx: BotContext): Promise<void> {
  await interaction.deferReply({ ephemeral: false });
  try {
    // Read current CRANK supply (byte offset 36, 8 bytes LE in Mint account)
    const crankMintInfo = await ctx.connection.getAccountInfo(CRANK_MINT);
    if (!crankMintInfo || crankMintInfo.data.length < 44) {
      await interaction.editReply(formatError('CRANK mint account missing or malformed'));
      return;
    }
    const currentSupply = crankMintInfo.data.readBigUInt64LE(36);

    // Read BANK supply for reference
    const bankMintInfo = await ctx.connection.getAccountInfo(BANK_MINT);
    const bankSupply = bankMintInfo && bankMintInfo.data.length >= 44
      ? bankMintInfo.data.readBigUInt64LE(36)
      : 0n;

    // Read rover authority for initial_crank_supply + burn_enabled
    const [roverAuthority] = getRoverAuthorityPDA();
    const roverAccount = await ctx.coreProgram.account.roverAuthority.fetch(roverAuthority);
    const initialSupply = BigInt(roverAccount.initialCrankSupply?.toString() || '0');
    const burnEnabled = roverAccount.burnEnabled === true;

    if (initialSupply === 0n) {
      await interaction.editReply(
        '**Burn curve not initialized.** Admin must run `initialize_burn_curve`.\n' +
        `CRANK supply: ${formatAmount(currentSupply, 6)}\n` +
        `BANK supply:  ${formatAmount(bankSupply, 6)}`,
      );
      return;
    }

    const { burnRatioPpb, protocolSkimPpb, traderSolFracPpb } = computeCurve(currentSupply, initialSupply, burnEnabled);
    const remainingPct = Number((currentSupply * 10000n) / initialSupply) / 100;

    const killSwitch = burnEnabled ? '🟢 on' : '🔴 off';
    const phase =
      remainingPct >= 75 ? 'magnesium (100% burn)'
      : remainingPct >= 1 ? 'dimming (curve transition)'
      : 'embers (full SOL yield)';

    await interaction.editReply(
      `**Burn curve status** — ${phase}\n` +
      `\n` +
      `CRANK supply:   ${formatAmount(currentSupply, 6)} (${remainingPct.toFixed(2)}% of initial)\n` +
      `BANK supply:    ${formatAmount(bankSupply, 6)}\n` +
      `Initial CRANK:  ${formatAmount(initialSupply, 6)}\n` +
      `\n` +
      `burn_ratio:      ${ppbToPct(burnRatioPpb)}  →  SOL → CRANK buys → burn → BANK\n` +
      `trader_sol:      ${ppbToPct(traderSolFracPpb)}  →  direct SOL yield to traders\n` +
      `protocol_skim:   ${ppbToPct(protocolSkimPpb)}  →  protocol wallet\n` +
      `\n` +
      `kill switch:    ${killSwitch}`,
    );
  } catch (e: any) {
    await interaction.editReply(formatError(e.message?.slice(0, 200) || 'unknown error'));
  }
}

export async function handleBurn(interaction: ChatInputCommandInteraction, ctx: BotContext): Promise<void> {
  const userId = `discord:${interaction.user.id}`;
  const amountStr = interaction.options.getString('amount', false)?.trim() ?? '';

  // /burn (no arg) or /burn status → show protocol burn curve state
  if (!amountStr || amountStr.toLowerCase() === 'status') {
    await handleBurnStatus(interaction, ctx);
    return;
  }

  const amountFloat = parseFloat(amountStr);
  if (isNaN(amountFloat) || amountFloat <= 0) {
    await interaction.reply({
      content: formatError('invalid amount.', '/burn 1000000  or  /burn status'),
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
