import { ChatInputCommandInteraction } from 'discord.js';
import { PublicKey } from '@solana/web3.js';
import type { BotContext } from '../index';

export async function handleStart(interaction: ChatInputCommandInteraction, ctx: BotContext): Promise<void> {
  const userId = `discord:${interaction.user.id}`;
  const walletArg = interaction.options.getString('wallet');

  // If already registered, show existing vault
  const existingVault = ctx.walletService.getVaultPda(userId);
  if (existingVault) {
    await interaction.reply({
      content:
        `Your vault is already set up.\n\n` +
        `**Deposit address:** \`${existingVault.toBase58()}\`\n\n` +
        `Send SOL here to fund your vault, then use \`/buy\` to open positions.`,
      ephemeral: true,
    });
    return;
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

  // Register user and derive vault PDA
  const { vaultPda } = ctx.walletService.registerUser(userId, ownerWallet);

  // Create vault on-chain (bot pays rent)
  try {
    await interaction.deferReply({ ephemeral: true });
    const { signAndSendLegacy } = await import('@crankbot/core-sdk');
    const { Transaction, SystemProgram } = await import('@solana/web3.js');

    // Call create_vault instruction
    const tx = await ctx.coreProgram.methods
      .createVault()
      .accounts({
        payer: ctx.botKeypair.publicKey,
        owner: ownerWallet,
        userVault: vaultPda,
        systemProgram: SystemProgram.programId,
      })
      .signers([ctx.botKeypair])
      .rpc();

    await interaction.editReply({
      content:
        `Vault created!\n\n` +
        `**Deposit address:** \`${vaultPda.toBase58()}\`\n` +
        `**Withdraw wallet:** \`${ownerWallet.toBase58()}\`\n\n` +
        `Send SOL to your deposit address, then use \`/buy\` to open positions.\n` +
        `All withdrawals go to your wallet automatically — enforced on-chain.`,
    });
  } catch (e: any) {
    await interaction.editReply({
      content: `Failed to create vault: ${e.message?.slice(0, 100)}`,
    });
  }
}
