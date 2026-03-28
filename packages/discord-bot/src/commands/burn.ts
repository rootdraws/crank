import { ChatInputCommandInteraction } from 'discord.js';
import type { BotContext } from '../index';

export async function handleBurn(interaction: ChatInputCommandInteraction, ctx: BotContext): Promise<void> {
  await interaction.reply({
    content: '🦧 burn not yet wired. bCRANK minter contract coming soon.',
    ephemeral: true,
  });
}
