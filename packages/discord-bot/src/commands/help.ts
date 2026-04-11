import { ChatInputCommandInteraction } from 'discord.js';
import type { BotContext } from '../index';

export async function handleHelp(interaction: ChatInputCommandInteraction, ctx: BotContext): Promise<void> {
  await interaction.reply({ content: '🦧', ephemeral: true });
  await interaction.followUp({
    content:
      '**CrankBot** — Smarter limit orders on Solana.\n\n' +
      '`/start` — create your wallet\n' +
      '`/balance` — show token balances\n' +
      '`/deposit` — show deposit address\n' +
      '`/buy CRANK 15k to 20k 0.5 SOL` — buy the dip\n' +
      '`/sell CRANK 25k to 35k 4000000 CRANK` — sell the rip\n' +
      '`/buy SOL 74 to 78 100 USDC` — buy SOL over a range\n' +
      '`/positions` — view open positions\n' +
      '`/close ID` — close a position\n' +
      '`/withdraw SOL 0.5` — withdraw to your deposit wallet\n' +
      '`/pools` — show covered pools\n' +
      '`/vote SOL 50 CRANK 50` — allocate vote weight\n' +
      '`/burn 1000000` — burn CRANK\n',
    ephemeral: true,
  });
}
