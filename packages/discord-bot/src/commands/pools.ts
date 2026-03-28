import { ChatInputCommandInteraction } from 'discord.js';
import { formatPoolsList } from '../formatter';
import type { BotContext } from '../index';
import * as fs from 'fs';
import * as path from 'path';

export async function handlePools(interaction: ChatInputCommandInteraction, ctx: BotContext): Promise<void> {
  const configPath = process.env.POOL_CONFIG_PATH || path.join(__dirname, '..', '..', '..', '..', 'curator.json');

  let pools: any[] = [];
  try {
    if (fs.existsSync(configPath)) {
      const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      pools = raw.pools || [];
    }
  } catch { /* no config */ }

  const text = formatPoolsList(pools.map(p => ({
    label: p.label,
    id: p.id,
    displayMode: p.displayMode,
    binStep: p.binStep,
  })));

  await interaction.reply({ content: text, ephemeral: true });
}
