import { ChatInputCommandInteraction } from 'discord.js';
import type { BotContext } from '../index';

export async function handleStart(interaction: ChatInputCommandInteraction, ctx: BotContext): Promise<void> {
  const userId = `discord:${interaction.user.id}`;
  const keypair = ctx.walletService.getOrCreate(userId);
  const address = keypair.publicKey.toBase58();

  await interaction.reply({
    content:
      `\`${address}\`\n\n` +
      `Deposit a minimum of 0.5 SOL from your designated withdraw wallet to start.`,
    ephemeral: true,
  });
}
