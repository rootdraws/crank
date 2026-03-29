import { ChatInputCommandInteraction } from 'discord.js';
import { PublicKey } from '@solana/web3.js';
import type { BotContext } from '../index';

export async function handleSetWithdraw(interaction: ChatInputCommandInteraction, ctx: BotContext): Promise<void> {
  const userId = `discord:${interaction.user.id}`;
  const address = interaction.options.getString('address', true);

  let pubkey: PublicKey;
  try {
    pubkey = new PublicKey(address);
  } catch {
    await interaction.reply({ content: 'Invalid Solana address.', ephemeral: true });
    return;
  }

  const result = ctx.walletService.setWithdrawAddress(userId, pubkey.toBase58());

  if (!result.ok) {
    await interaction.reply({ content: result.error!, ephemeral: true });
    return;
  }

  await interaction.reply({
    content: `Withdraw address locked to \`${pubkey.toBase58().slice(0, 8)}...${pubkey.toBase58().slice(-4)}\`\nAll withdrawals will go to this address. This cannot be changed.`,
    ephemeral: true,
  });
}
