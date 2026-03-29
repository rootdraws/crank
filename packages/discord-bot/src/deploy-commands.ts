/**
 * deploy-commands.ts
 *
 * One-time script to register slash commands with the Discord API.
 * Run: npx tsx packages/discord-bot/src/deploy-commands.ts
 *
 * If DISCORD_GUILD_ID is set, registers guild-scoped (instant).
 * Otherwise registers global (takes up to 1hr to propagate).
 */

import { REST, Routes, SlashCommandBuilder } from 'discord.js';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.join(__dirname, '..', '..', '..', '.env') });

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const GUILD_ID = process.env.DISCORD_GUILD_ID;

if (!TOKEN || !CLIENT_ID) {
  console.error('DISCORD_TOKEN and DISCORD_CLIENT_ID required in .env');
  process.exit(1);
}

const commands = [
  new SlashCommandBuilder()
    .setName('start')
    .setDescription('Create your custodial wallet and get a deposit address'),

  new SlashCommandBuilder()
    .setName('balance')
    .setDescription('Show your wallet balances'),

  new SlashCommandBuilder()
    .setName('deposit')
    .setDescription('Show your deposit address'),

  new SlashCommandBuilder()
    .setName('buy')
    .setDescription('Open a buy-side DLMM position')
    .addStringOption(opt =>
      opt.setName('range')
        .setDescription('TOKEN HIGH to LOW AMOUNT QUOTE — e.g. SOL 84 to 74 1000 USDC')
        .setRequired(true)),

  new SlashCommandBuilder()
    .setName('sell')
    .setDescription('Open a sell-side DLMM position')
    .addStringOption(opt =>
      opt.setName('range')
        .setDescription('TOKEN LOW to HIGH AMOUNT QUOTE — e.g. SOL 98 to 115 10 SOL')
        .setRequired(true)),

  new SlashCommandBuilder()
    .setName('positions')
    .setDescription('View your open positions'),

  new SlashCommandBuilder()
    .setName('close')
    .setDescription('Close a position')
    .addStringOption(opt =>
      opt.setName('id')
        .setDescription('Position ID (or prefix) from /positions')
        .setRequired(true)),

  new SlashCommandBuilder()
    .setName('setwithdraw')
    .setDescription('Lock your withdrawal address (one-time, cannot be changed)')
    .addStringOption(opt =>
      opt.setName('address').setDescription('Your external wallet address').setRequired(true)),

  new SlashCommandBuilder()
    .setName('withdraw')
    .setDescription('Withdraw tokens — funds can only go to your wallet')
    .addStringOption(opt =>
      opt.setName('token').setDescription('Token symbol (SOL, USDC, etc.)').setRequired(true))
    .addStringOption(opt =>
      opt.setName('amount').setDescription('Amount to withdraw').setRequired(true))
    .addStringOption(opt =>
      opt.setName('address').setDescription('Destination wallet address').setRequired(true)),

  new SlashCommandBuilder()
    .setName('pools')
    .setDescription('List covered pools and APR'),

  new SlashCommandBuilder()
    .setName('vote')
    .setDescription('Allocate vote weight to trading pairs')
    .addStringOption(opt =>
      opt.setName('allocation')
        .setDescription('POOL PCT POOL PCT — e.g. SOL 50 CRANK 50')
        .setRequired(false)),

  new SlashCommandBuilder()
    .setName('burn')
    .setDescription('Burn CRANK → mint BANK 1:1')
    .addStringOption(opt =>
      opt.setName('amount').setDescription('Amount of CRANK to burn').setRequired(true)),

  new SlashCommandBuilder()
    .setName('claim')
    .setDescription('Claim pending $PEGGED emissions'),

  new SlashCommandBuilder()
    .setName('unstake')
    .setDescription('Unstake $PEGGED → SOL (instant from reserve)')
    .addStringOption(opt =>
      opt.setName('amount').setDescription('Amount of $PEGGED to unstake (or "all")').setRequired(true)),

  new SlashCommandBuilder()
    .setName('help')
    .setDescription('Show all CrankBot commands'),
].map(cmd => cmd.toJSON());

const rest = new REST().setToken(TOKEN);

(async () => {
  try {
    console.log(`Registering ${commands.length} slash commands...`);

    if (GUILD_ID) {
      await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
      console.log(`Guild commands registered (guild: ${GUILD_ID}) — available immediately`);
    } else {
      await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
      console.log('Global commands registered — may take up to 1 hour to propagate');
    }
  } catch (err) {
    console.error('Failed to register commands:', err);
    process.exit(1);
  }
})();
