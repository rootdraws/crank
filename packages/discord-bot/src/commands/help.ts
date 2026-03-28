import { ChatInputCommandInteraction } from 'discord.js';
import type { BotContext } from '../index';

export async function handleHelp(interaction: ChatInputCommandInteraction, ctx: BotContext): Promise<void> {
  await interaction.reply({
    content:
      '**CrankBot** — automated DLMM range orders\n\n' +
      '`/start` — create your wallet\n' +
      '`/balance` — show token balances\n' +
      '`/deposit` — show deposit address\n' +
      '`/buy SOL 84 to 74 1000 USDC` — open buy position\n' +
      '`/sell SOL 98 to 115 10 SOL` — open sell position\n' +
      '`/positions` — view open positions\n' +
      '`/close ID` — close a position\n' +
      '`/withdraw SOL 0.5 ADDRESS` — sweep to wallet\n' +
      '`/pools` — show covered pools\n' +
      '`/vote SOL 50 CRANK 50` — allocate vote weight\n' +
      '`/burn 1000000` — burn CRANK\n' +
      '`/claim` — claim pending $PEGGED\n',
    ephemeral: true,
  });
}
