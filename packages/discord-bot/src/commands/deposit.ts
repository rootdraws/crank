import { ChatInputCommandInteraction } from 'discord.js';
import type { BotContext } from '../index';

export async function handleDeposit(interaction: ChatInputCommandInteraction, ctx: BotContext): Promise<void> {
  const userId = `discord:${interaction.user.id}`;
  const address = ctx.walletService.getDepositAddress(userId);

  await interaction.reply({
    content: `Your deposit address:\n\`${address}\`\n\nWe recommend 0.5 SOL for rent + gas.`,
    ephemeral: true,
  });
}
