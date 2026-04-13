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

import { Client, GatewayIntentBits, Interaction } from 'discord.js';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { Program } from '@coral-xyz/anchor';
import dotenv from 'dotenv';
import path from 'path';

import { WalletService, loadPoolRegistry } from '@crankbot/core-sdk';
import { DiscordNotifier } from './notifier';

import { handleStart } from './commands/start';
import { handleBalance } from './commands/balance';
// deposit killed — /balance shows the vault address
import { handleBuy } from './commands/buy';
import { handleSell } from './commands/sell';
import { handlePositions } from './commands/positions';
import { handleClose } from './commands/close';
import { handleWithdraw } from './commands/withdraw';
import { handlePools } from './commands/pools';
import { handleVote } from './commands/vote';
import { handleBurn } from './commands/burn';
import { handleHelp } from './commands/help';
import { handleLeaderboard } from './commands/leaderboard';
import { handleEnableToken } from './commands/enable-token';

dotenv.config({ path: path.join(__dirname, '..', '..', '..', '.env') });

export interface BotContext {
  connection: Connection;
  coreProgram: Program;
  coreProgramId: PublicKey;
  botKeypair: Keypair;
  configPDA: PublicKey;
  walletService: WalletService;
  approvedPools: Set<string>;
  subscriber?: any; // GeyserSubscriber — has getPoolInfo(lbPair) for real-time activeId
  feedChannelId?: string;
  cashoutChannelId?: string;
  client: Client;
}

// Commands allowed in the cash-out-only channel. Everything else is rejected
// so the room stays focused on getting out (close positions, pull funds).
const CASHOUT_ALLOWED = new Set(['close', 'withdraw', 'positions', 'balance', 'help']);

interface DiscordBotConfig {
  executor?: any;
  subscriber?: any;
  connection: Connection;
  coreProgram: Program;
  coreProgramId: PublicKey;
  botKeypair: Keypair;
  configPDA: PublicKey;
}

export class DiscordBot {
  public client: Client;
  public notifier: DiscordNotifier;
  public walletService: WalletService;
  private ctx: BotContext;

  constructor(config: DiscordBotConfig) {
    const token = process.env.DISCORD_TOKEN;
    if (!token) throw new Error('DISCORD_TOKEN not set');

    // Enable GuildMembers only when the operator has toggled the privileged
    // "Server Members Intent" in the Discord developer portal. Required by
    // the keeper's crank-role pruner; without it, pruning is a no-op but
    // every other command still works.
    const intents = [GatewayIntentBits.Guilds];
    if (process.env.DISCORD_ENABLE_MEMBER_INTENT === 'true') {
      intents.push(GatewayIntentBits.GuildMembers);
    }
    this.client = new Client({ intents });

    this.walletService = new WalletService(process.env.DB_PATH);
    this.notifier = new DiscordNotifier(this.client, this.walletService);

    const pools = loadPoolRegistry();
    const approvedPools = new Set<string>(pools.map(p => p.address));

    this.ctx = {
      connection: config.connection,
      coreProgram: config.coreProgram,
      coreProgramId: config.coreProgramId,
      botKeypair: config.botKeypair,
      configPDA: config.configPDA,
      walletService: this.walletService,
      approvedPools,
      subscriber: config.subscriber,
      feedChannelId: process.env.DISCORD_FEED_CHANNEL_ID,
      cashoutChannelId: process.env.DISCORD_CASHOUT_CHANNEL_ID,
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
      // Handle button clicks (e.g. "Enable $TOKEN")
      if (interaction.isButton()) {
        try {
          if (interaction.customId.startsWith('enable_token:')) {
            return await handleEnableToken(interaction, ctx);
          }
        } catch (err: any) {
          console.error('[discord-bot] Button error:', err);
          const msg = `Something went wrong: ${err.message?.slice(0, 100) || 'unknown error'}`;
          if (interaction.replied || interaction.deferred) {
            await interaction.followUp({ content: msg, ephemeral: true }).catch(() => {});
          } else {
            await interaction.reply({ content: msg, ephemeral: true }).catch(() => {});
          }
        }
        return;
      }

      if (!interaction.isChatInputCommand()) return;

      const { commandName } = interaction;

      if (ctx.cashoutChannelId && interaction.channelId === ctx.cashoutChannelId && !CASHOUT_ALLOWED.has(commandName)) {
        await interaction.reply({
          content: 'This channel is cash-out only. Use `/close`, `/withdraw`, `/positions`, `/balance`, or `/help`.',
          ephemeral: true,
        });
        return;
      }

      try {
        switch (commandName) {
          case 'start':     return await handleStart(interaction, ctx);
          case 'balance':   return await handleBalance(interaction, ctx);
          case 'deposit':   return await interaction.reply({ content: 'Use `/balance` to see your vault address and balances.', ephemeral: true });
          case 'buy':       return await handleBuy(interaction, ctx);
          case 'sell':      return await handleSell(interaction, ctx);
          case 'positions': return await handlePositions(interaction, ctx);
          case 'close':     return await handleClose(interaction, ctx);
          case 'withdraw':  return await handleWithdraw(interaction, ctx);
          case 'pools':     return await handlePools(interaction, ctx);
          case 'vote':      return await handleVote(interaction, ctx);
          case 'burn':      return await handleBurn(interaction, ctx);
          case 'help':        return await handleHelp(interaction, ctx);
          case 'leaderboard': return await handleLeaderboard(interaction, ctx);
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
