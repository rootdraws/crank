/**
 * discord-bot/src/index.ts
 *
 * CrankBot Discord entry point.
 * Wires: discord.js client -> slash commands -> core-sdk -> signer
 *
 * Integration with existing harvester:
 *   import { DiscordBot } from './packages/discord-bot/src/index';
 *   const bot = new DiscordBot({ executor, subscriber, connection, coreProgram, coreProgramId });
 *   await bot.start();
 */

import { Client, GatewayIntentBits, Collection, Interaction } from 'discord.js';
import { Connection, PublicKey } from '@solana/web3.js';
import { Program } from '@coral-xyz/anchor';
import dotenv from 'dotenv';
import path from 'path';

import { WalletService, TIER1_POOLS } from '@crankbot/core-sdk';
import { DiscordNotifier } from './notifier';

import { handleStart } from './commands/start';
import { handleBalance } from './commands/balance';
import { handleDeposit } from './commands/deposit';
import { handleBuy } from './commands/buy';
import { handleSell } from './commands/sell';
import { handlePositions } from './commands/positions';
import { handleClose } from './commands/close';
import { handleWithdraw } from './commands/withdraw';
import { handlePools } from './commands/pools';
import { handleVote } from './commands/vote';
import { handleBurn } from './commands/burn';
import { handleClaim } from './commands/claim';
import { handleHelp } from './commands/help';

dotenv.config({ path: path.join(__dirname, '..', '..', '..', '.env') });

export interface BotContext {
  connection: Connection;
  coreProgram: Program;
  coreProgramId: PublicKey;
  walletService: WalletService;
  approvedPools: Set<string>;
  poolALT?: any;
  feedChannelId?: string;
  client: Client;
}

interface DiscordBotConfig {
  executor?: any;
  subscriber?: any;
  connection: Connection;
  coreProgram: Program;
  coreProgramId: PublicKey;
}

export class DiscordBot {
  private client: Client;
  public notifier: DiscordNotifier;
  private walletService: WalletService;
  private ctx: BotContext;

  constructor(config: DiscordBotConfig) {
    const token = process.env.DISCORD_TOKEN;
    if (!token) throw new Error('DISCORD_TOKEN not set');

    this.client = new Client({
      intents: [GatewayIntentBits.Guilds],
    });

    this.walletService = new WalletService(process.env.DB_PATH);
    this.notifier = new DiscordNotifier(this.client, this.walletService);

    const approvedPools = new Set<string>(TIER1_POOLS);
    const extraPools = (process.env.APPROVED_POOLS || '').split(',').filter(Boolean);
    for (const p of extraPools) approvedPools.add(p.trim());

    this.ctx = {
      connection: config.connection,
      coreProgram: config.coreProgram,
      coreProgramId: config.coreProgramId,
      walletService: this.walletService,
      approvedPools,
      feedChannelId: process.env.DISCORD_FEED_CHANNEL_ID,
      client: this.client,
    };

    this.registerHandlers();
  }

  private registerHandlers(): void {
    const ctx = this.ctx;

    this.client.on('ready', (c) => {
      console.log(`[discord-bot] Running as ${c.user.tag}`);
    });

    this.client.on('interactionCreate', async (interaction: Interaction) => {
      if (!interaction.isChatInputCommand()) return;

      const { commandName } = interaction;

      try {
        switch (commandName) {
          case 'start':     return await handleStart(interaction, ctx);
          case 'balance':   return await handleBalance(interaction, ctx);
          case 'deposit':   return await handleDeposit(interaction, ctx);
          case 'buy':       return await handleBuy(interaction, ctx);
          case 'sell':      return await handleSell(interaction, ctx);
          case 'positions': return await handlePositions(interaction, ctx);
          case 'close':     return await handleClose(interaction, ctx);
          case 'withdraw':  return await handleWithdraw(interaction, ctx);
          case 'pools':     return await handlePools(interaction, ctx);
          case 'vote':      return await handleVote(interaction, ctx);
          case 'burn':      return await handleBurn(interaction, ctx);
          case 'claim':     return await handleClaim(interaction, ctx);
          case 'help':      return await handleHelp(interaction, ctx);
          default:
            await interaction.reply({ content: 'Unknown command.', ephemeral: true });
        }
      } catch (err: any) {
        console.error(`[discord-bot] Command error (${commandName}):`, err);
        const msg = `Something went wrong: ${err.message?.slice(0, 100) || 'unknown error'}`;
        if (interaction.replied || interaction.deferred) {
          await interaction.followUp({ content: msg, ephemeral: true }).catch(() => {});
        } else {
          await interaction.reply({ content: msg, ephemeral: true }).catch(() => {});
        }
      }
    });
  }

  async start(): Promise<void> {
    const token = process.env.DISCORD_TOKEN!;
    console.log('[discord-bot] Starting...');
    await this.client.login(token);
  }

  async stop(): Promise<void> {
    this.client.destroy();
    this.walletService.close();
  }
}

// ─── Standalone entry point ────────────────────────────────────────────────

if (require.main === module) {
  const { Connection } = require('@solana/web3.js');
  const fs = require('fs');

  (async () => {
    const rpcUrl = process.env.HELIUS_RPC_URL || process.env.RPC_URL;
    const connection = rpcUrl ? new Connection(rpcUrl, 'confirmed') : null;

    let coreProgram: any = null;
    let coreProgramId: any = null;

    if (connection && process.env.CORE_PROGRAM_ID) {
      try {
        const { AnchorProvider, Program, Wallet } = require('@coral-xyz/anchor');
        const { Keypair } = require('@solana/web3.js');
        const bs58 = require('bs58');

        let botKeypair: any;
        if (process.env.BOT_KEYPAIR_PATH && fs.existsSync(process.env.BOT_KEYPAIR_PATH)) {
          const data = JSON.parse(fs.readFileSync(process.env.BOT_KEYPAIR_PATH, 'utf-8'));
          botKeypair = Keypair.fromSecretKey(Uint8Array.from(data));
        } else if (process.env.BOT_PRIVATE_KEY) {
          botKeypair = Keypair.fromSecretKey(bs58.decode(process.env.BOT_PRIVATE_KEY));
        }

        if (botKeypair) {
          const wallet = new Wallet(botKeypair);
          const provider = new AnchorProvider(connection, wallet, { commitment: 'confirmed' });
          const idlDir = process.env.IDL_DIR || path.join(__dirname, '..', '..', '..', 'bot', 'idl');
          const idlPath = path.join(idlDir, 'bin_farm.json');
          if (fs.existsSync(idlPath)) {
            const idl = JSON.parse(fs.readFileSync(idlPath, 'utf-8'));
            coreProgramId = new PublicKey(process.env.CORE_PROGRAM_ID);
            coreProgram = new Program(idl, provider);
            console.log('[discord-bot] Solana connection + program loaded');
          }
        }
      } catch (e: any) {
        console.warn(`[discord-bot] Solana setup skipped: ${e.message}`);
      }
    }

    if (!connection) {
      console.warn('[discord-bot] No RPC_URL — running in Discord-only mode (wallet commands work, trading commands disabled)');
    }

    const bot = new DiscordBot({
      connection: connection as any,
      coreProgram: coreProgram as any,
      coreProgramId: coreProgramId as any,
    });

    process.on('SIGTERM', () => bot.stop());
    process.on('SIGINT', () => bot.stop());

    await bot.start();
  })().catch(e => {
    console.error('FATAL:', e);
    process.exit(1);
  });
}
