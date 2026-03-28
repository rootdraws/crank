import { ChatInputCommandInteraction } from 'discord.js';
import type { BotContext } from '../index';

export async function handleClaim(interaction: ChatInputCommandInteraction, ctx: BotContext): Promise<void> {
  await interaction.reply({
    content: '🦧 claim not yet wired. emissions distribution coming soon.',
    ephemeral: true,
  });
}
