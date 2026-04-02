import { ChatInputCommandInteraction } from 'discord.js';
import type { BotContext } from '../index';

export async function handleDeposit(interaction: ChatInputCommandInteraction, ctx: BotContext): Promise<void> {
  const userId = `discord:${interaction.user.id}`;
  const address = ctx.walletService.getDepositAddress(userId);
  const withdrawAddr = ctx.walletService.getWithdrawAddress(userId);

  let content = `Your deposit address:\n\`${address}\`\n\n`;
  if (withdrawAddr) {
    content += `Withdrawals → \`${withdrawAddr.slice(0, 4)}...${withdrawAddr.slice(-4)}\``;
  } else {
    content += `Send SOL from your wallet — that wallet becomes your withdraw address.`;
  }

  await interaction.reply({ content, ephemeral: true });
}
