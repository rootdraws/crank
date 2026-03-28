import { ChatInputCommandInteraction } from 'discord.js';
import { handleOpenPosition } from './buy';
import type { BotContext } from '../index';

export async function handleSell(interaction: ChatInputCommandInteraction, ctx: BotContext): Promise<void> {
  await handleOpenPosition(interaction, ctx, 'Sell');
}
