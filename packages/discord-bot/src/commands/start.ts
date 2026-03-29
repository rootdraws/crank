import { ChatInputCommandInteraction } from 'discord.js';
import type { BotContext } from '../index';

export async function handleStart(interaction: ChatInputCommandInteraction, ctx: BotContext): Promise<void> {
  const userId = `discord:${interaction.user.id}`;
  const keypair = ctx.walletService.getOrCreate(userId);
  const address = keypair.publicKey.toBase58();

  await interaction.reply({
    content:
      `Your deposit address:\n\`${address}\`\n\n` +
      `Send at least 0.5 SOL to cover rent + gas for trading.\n` +
      `/balance to check funds · /deposit to see this again`,
    ephemeral: true,
  });
}
