import { ChatInputCommandInteraction } from 'discord.js';
import { PublicKey, SystemProgram, Transaction } from '@solana/web3.js';
import {
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import { CRANK_MINT, TOKEN_2022_PROGRAM_ID, WalletAlreadyClaimedError } from '@crankbot/core-sdk';
import type { BotContext } from '../index';

/**
 * Pre-create the vault's CRANK ATA so users can deposit CRANK immediately
 * without hitting the "Enable $TOKEN" button flow. crank.money is
 * CRANK-centric — every vault needs this ATA anyway. Non-blocking: any error
 * is logged and swallowed so vault creation still reports success.
 */
async function ensureCrankAta(ctx: BotContext, vaultPda: PublicKey): Promise<void> {
  try {
    const ata = getAssociatedTokenAddressSync(CRANK_MINT, vaultPda, true, TOKEN_2022_PROGRAM_ID);
    const info = await ctx.connection.getAccountInfo(ata);
    if (info) return;
    const tx = new Transaction().add(
      createAssociatedTokenAccountIdempotentInstruction(
        ctx.botKeypair.publicKey, ata, vaultPda, CRANK_MINT, TOKEN_2022_PROGRAM_ID,
      ),
    );
    tx.feePayer = ctx.botKeypair.publicKey;
    tx.recentBlockhash = (await ctx.connection.getLatestBlockhash()).blockhash;
    tx.sign(ctx.botKeypair);
    await ctx.connection.sendRawTransaction(tx.serialize());
  } catch (e: any) {
    console.error('[start] Failed to pre-create CRANK ATA:', e.message?.slice(0, 120));
  }
}

export async function handleStart(interaction: ChatInputCommandInteraction, ctx: BotContext): Promise<void> {
  const userId = `discord:${interaction.user.id}`;
  const walletArg = interaction.options.getString('wallet');

  // If already registered, verify vault exists on-chain before trusting local DB
  const existingVault = ctx.walletService.getVaultPda(userId);
  if (existingVault) {
    const acctInfo = await ctx.connection.getAccountInfo(existingVault);
    const programOwned = acctInfo && acctInfo.owner.equals(ctx.coreProgramId);

    if (programOwned) {
      await interaction.reply({
        content:
          `Your vault is already set up.\n\n` +
          `**Deposit address:** \`${existingVault.toBase58()}\`\n\n` +
          `Send SOL to your vault, then use \`/buy\` to open positions.`,
        ephemeral: true,
      });
      return;
    }

    // Local DB says registered but vault not initialized on-chain — fix it
    await interaction.deferReply({ ephemeral: true });
    try {
      const ownerWallet = ctx.walletService.getOwnerWallet(userId)!;
      const tx = await ctx.coreProgram.methods
        .createVault()
        .accounts({
          payer: ctx.botKeypair.publicKey,
          owner: ownerWallet,
          userVault: existingVault,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      await ensureCrankAta(ctx, existingVault);

      await interaction.editReply({
        content:
          `Vault initialized!\n\n` +
          `**Deposit address:** \`${existingVault.toBase58()}\`\n` +
          `**Withdraw wallet:** \`${ownerWallet.toBase58()}\`\n\n` +
          `Send at least **0.05 SOL** to your deposit address, then use \`/buy\` to open positions.\n` +
          `All withdrawals go to your wallet automatically — enforced on-chain.`,
      });
      return;
    } catch (e: any) {
      // Can't recover — wipe local registration so user can retry clean
      ctx.walletService.removeUser(userId);
      await interaction.editReply({
        content: `Vault was registered but not created on-chain. Registration cleared — please run \`/start\` again.`,
      });
      return;
    }
  }

  // Require wallet address for new registration
  if (!walletArg) {
    await interaction.reply({
      content:
        `Welcome to crank.money! To get started, provide your Solana wallet address:\n\n` +
        `\`/start wallet:<your-solana-address>\`\n\n` +
        `This is the wallet you'll withdraw to. It cannot be changed.`,
      ephemeral: true,
    });
    return;
  }

  // Validate wallet address
  let ownerWallet: PublicKey;
  try {
    ownerWallet = new PublicKey(walletArg);
  } catch {
    await interaction.reply({
      content: 'Invalid Solana wallet address. Please provide a valid base58 public key.',
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  // Create vault on-chain FIRST, then register locally
  const [vaultPda] = PublicKey.findProgramAddressSync(
    [Buffer.from('user_vault'), ownerWallet.toBuffer()],
    ctx.coreProgramId,
  );

  try {
    const tx = await ctx.coreProgram.methods
      .createVault()
      .accounts({
        payer: ctx.botKeypair.publicKey,
        owner: ownerWallet,
        userVault: vaultPda,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    // On-chain succeeded — now save locally
    try {
      ctx.walletService.registerUser(userId, ownerWallet);
    } catch (e: any) {
      if (e instanceof WalletAlreadyClaimedError) {
        await interaction.editReply({
          content:
            `That wallet is already bound to another account. ` +
            `If you believe this is a mistake, ask an operator to unbind it.`,
        });
        return;
      }
      throw e;
    }

    await ensureCrankAta(ctx, vaultPda);

    await interaction.editReply({
      content:
        `Vault created!\n\n` +
        `**Deposit address:** \`${vaultPda.toBase58()}\`\n` +
        `**Withdraw wallet:** \`${ownerWallet.toBase58()}\`\n\n` +
        `Send SOL to your vault, then use \`/buy\` to open positions.\n` +
        `All withdrawals go to your wallet automatically — enforced on-chain.`,
    });
  } catch (e: any) {
    await interaction.editReply({
      content: `Failed to create vault: ${e.message?.slice(0, 100)}`,
    });
  }
}
