import { ChatInputCommandInteraction } from 'discord.js';
import type { BotContext } from '../index';

export async function handleDeposit(interaction: ChatInputCommandInteraction, ctx: BotContext): Promise<void> {
  const userId = `discord:${interaction.user.id}`;
  const address = ctx.walletService.getDepositAddress(userId);

  if (!address) {
    await interaction.reply({
      content: 'No vault found. Run `/start wallet:<your-solana-address>` first.',
      ephemeral: true,
    });
    return;
  }

  const withdrawAddr = ctx.walletService.getWithdrawAddress(userId);

  let content = `**Deposit address:**\n\`${address}\`\n\nSend **SOL** to this address. Minimum **0.05 SOL** to open positions.\n\nTo trade tokens, use \`/buy\` — you'll be prompted to enable each token on your vault.\n`;

  if (withdrawAddr) {
    content += `\nWithdrawals → \`${withdrawAddr.slice(0, 4)}...${withdrawAddr.slice(-4)}\` (enforced on-chain)`;
  }

  await interaction.reply({ content, ephemeral: true });
}
