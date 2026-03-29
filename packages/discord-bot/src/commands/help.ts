import { ChatInputCommandInteraction } from 'discord.js';
import type { BotContext } from '../index';

export async function handleHelp(interaction: ChatInputCommandInteraction, ctx: BotContext): Promise<void> {
  await interaction.reply({
    content:
      '**CrankBot** — Smarter limit orders on Solana. 🦧\n\n' +
      '`/start` — create your wallet\n' +
      '`/balance` — show token balances\n' +
      '`/deposit` — show deposit address\n' +
      '`/buy SOL 84 to 74 1000 USDC` — buy SOL over a range\n' +
      '`/buy CRANK 45mmc to 22mmc 2 SOL` — buy using mcap\n' +
      '`/sell SOL 98 to 115 10 SOL` — sell SOL over a range\n' +
      '`/positions` — view open positions\n' +
      '`/close ID` — close a position\n' +
      '`/setwithdraw ADDRESS` — lock your withdrawal address (one-time)\n' +
      '`/withdraw SOL 0.5` — funds can only go to your wallet\n' +
      '`/pools` — show covered pools\n' +
      '`/vote SOL 50 CRANK 50` — allocate vote weight\n' +
      '`/burn 1000000` — burn CRANK\n' +
      '`/claim` — claim pending $PEGGED\n' +
      '`/unstake 0.5` — unstake $PEGGED → SOL\n',
    ephemeral: true,
  });
}
