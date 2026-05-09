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
import { handleHelp } from './commands/help';
import { handleLeaderboard } from './commands/leaderboard';
import { handleStats } from './commands/stats';
import { handleEnableToken } from './commands/enable-token';
import { handleTreasury } from './commands/treasury';
import { handleProposals } from './commands/proposals';

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
  /**
   * Treasury-match (Path B) runtime. Populated by `DiscordBot.initTreasury()`
   * when GOVERNANCE_REALM_NAME env is set + on-chain bootstrap is complete.
   * Undefined when Path B is disabled — commands gracefully skip the
   * treasury enqueue step in that case.
   */
  treasury?: import('../../../bot/treasury-runtime').TreasuryRuntime;
}

// Commands allowed in the cash-out-only channel. Everything else is rejected
// so the room stays focused on getting out (close positions, pull funds).
const CASHOUT_ALLOWED = new Set(['close', 'withdraw', 'positions', 'balance', 'help', 'stats']);

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

    this.client = new Client({ intents: [GatewayIntentBits.Guilds] });

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
          case 'help':        return await handleHelp(interaction, ctx);
          case 'leaderboard': return await handleLeaderboard(interaction, ctx);
          case 'stats':       return await handleStats(interaction, ctx);
          case 'treasury':    return await handleTreasury(interaction, ctx);
          case 'proposals':   return await handleProposals(interaction, ctx);
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
    this.ctx.treasury?.orchestrator.stopWorker();
    this.walletService.close();
  }

  /**
   * Initialize the treasury-match (Path B) subsystem if env-configured.
   * Safe no-op when GOVERNANCE_REALM_NAME is unset. Caller should invoke
   * AFTER constructing the bot but BEFORE `start()` (or in parallel — the
   * bot can serve Path A commands while Path B initializes).
   *
   * Failures are logged + non-fatal: Path A continues to work, Path B
   * commands skip the treasury enqueue step until env / bootstrap is fixed.
   */
  async initTreasury(): Promise<void> {
    if (!process.env.GOVERNANCE_REALM_NAME) return;
    try {
      const { initTreasuryRuntime } = await import('../../../bot/treasury-runtime');
      const runtime = await initTreasuryRuntime(
        this.ctx.connection,
        this.ctx.botKeypair,
        this.walletService,
      );
      if (runtime) {
        this.ctx.treasury = runtime;
        // Populate the validator's pool whitelist from curator.json
        const setKnownPools = (
          runtime.orchestrator as unknown as { setKnownPools?: (pools: Iterable<string>) => void }
        ).setKnownPools;
        if (setKnownPools) setKnownPools(this.ctx.approvedPools);
      }
    } catch (e: unknown) {
      console.error('[discord-bot] Treasury init FAILED:', e instanceof Error ? e.message : e);
      console.error('[discord-bot] Path A continues; Path B disabled until init succeeds.');
    }
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
    let botKeypair: any = null;
    let configPDA: any = null;

    if (connection && process.env.CORE_PROGRAM_ID) {
      try {
        const { AnchorProvider, Program, Wallet } = require('@coral-xyz/anchor');
        const { Keypair } = require('@solana/web3.js');
        const bs58 = require('bs58');
        const { getConfigPDA } = require('@crankbot/core-sdk');

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
            [configPDA] = getConfigPDA();
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
      botKeypair: botKeypair as any,
      configPDA: configPDA as any,
    });

    process.on('SIGTERM', () => bot.stop());
    process.on('SIGINT', () => bot.stop());

    // Initialize Path B (treasury-match) subsystem if governance env is set.
    // No-op + logged warning if env missing or bootstrap incomplete.
    await bot.initTreasury();

    await bot.start();
  })().catch(e => {
    console.error('FATAL:', e);
    process.exit(1);
  });
}
