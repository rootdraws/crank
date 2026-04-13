/**
 * discord-bot/src/notifier.ts
 *
 * Two destinations:
 * 1. Feed channel (public — protocol heartbeat for users: harvests, closes, epoch success)
 * 2. Ops channel (private — bot health alerts: gRPC down, low balance, keeper failures, divergence)
 *
 * Each protocol event also DMs the position owner directly.
 */

import { Client, TextChannel } from 'discord.js';
import { WalletService, loadPoolRegistry } from '@crankbot/core-sdk';
import { formatHarvestDM, formatClosedDM, formatFeedHarvested, formatFeedClosed } from './formatter';

export class DiscordNotifier {
  private feedChannel: TextChannel | null = null;
  private opsChannel: TextChannel | null = null;

  constructor(
    private client: Client,
    private walletService: WalletService
  ) {
    this.client.on('ready', () => {
      this.resolveFeedChannel();
      this.resolveOpsChannel();
    });
  }

  private async resolveFeedChannel(): Promise<void> {
    const channelId = process.env.DISCORD_FEED_CHANNEL_ID;
    if (!channelId) return;

    try {
      const channel = await this.client.channels.fetch(channelId);
      if (channel?.isTextBased() && 'send' in channel) {
        this.feedChannel = channel as TextChannel;
        console.log(`[notifier] Feed channel resolved: #${(channel as TextChannel).name}`);
      }
    } catch (e: any) {
      console.warn(`[notifier] Failed to resolve feed channel ${channelId}: ${e.message}`);
    }
  }

  private async resolveOpsChannel(): Promise<void> {
    const channelId = process.env.DISCORD_OPS_CHANNEL_ID;
    if (!channelId) return;

    try {
      const channel = await this.client.channels.fetch(channelId);
      if (channel?.isTextBased() && 'send' in channel) {
        this.opsChannel = channel as TextChannel;
        console.log(`[notifier] Ops channel resolved: #${(channel as TextChannel).name}`);
      }
    } catch (e: any) {
      console.warn(`[notifier] Failed to resolve ops channel ${channelId}: ${e.message}`);
    }
  }

  async onHarvestExecuted(data: {
    positionPDA: string;
    lbPair: string;
    owner: string;
    side: 'Buy' | 'Sell';
    binCount: number;
    tokenXAmount?: string;
    tokenYAmount?: string;
    feeAmount?: string;
    totalHarvested?: string;
    txSig?: string;
  }): Promise<void> {
    const userId = this.walletService.getUserIdForVault(data.owner);
    const actorId = userId?.replace('discord:', '');

    // amount_out is whichever side is nonzero (the converted output).
    // Note: BigInt('0') is 0n but '0' is truthy, so nullish-coalesce on strings
    // would always pick tokenXAmount even when zero. Use bigint comparison.
    const xAmt = BigInt(data.tokenXAmount ?? '0');
    const yAmt = BigInt(data.tokenYAmount ?? '0');
    const amountOutRaw = xAmt > yAmt ? xAmt : yAmt;

    this.walletService.saveHarvest({
      positionPda: data.positionPDA,
      vaultPda: data.owner,
      lbPair: data.lbPair,
      amountOut: amountOutRaw,
      feeTaken: BigInt(data.feeAmount ?? '0'),
      txSig: data.txSig ?? '',
      slot: 0,
    });

    const pools = loadPoolRegistry();
    const poolConfig = pools.find(p => p.address === data.lbPair);
    const decimals = data.side === 'Buy' ? (poolConfig?.decimalsX ?? 9) : (poolConfig?.decimalsY ?? 9);
    const amountOut = data.side === 'Buy'
      ? formatLamports(data.tokenXAmount ?? '0', decimals)
      : formatLamports(data.tokenYAmount ?? '0', decimals);
    const totalHarvested = formatLamports(data.totalHarvested ?? '0', decimals);
    const poolName = poolConfig?.label ?? data.lbPair.slice(0, 8) + '...';
    const tokenSymbol = data.side === 'Buy'
      ? (poolConfig?.buyToken ?? 'TOKEN')
      : (poolConfig?.quoteToken ?? 'SOL');

    // DM the position owner
    if (actorId) {
      const dmText = formatHarvestDM({
        poolName,
        side: data.side,
        binCount: data.binCount,
        amountOut,
        tokenSymbol,
        totalHarvested,
        txSig: data.txSig,
      });
      await this.sendDM(actorId, dmText);
    }

    // Post to feed channel
    if (this.feedChannel) {
      const feedText = formatFeedHarvested({
        poolName,
        side: data.side,
        amountOut,
        tokenSymbol,
        txSig: data.txSig ?? '',
        actorId,
      });
      await this.sendToFeed(feedText);
    }
  }

  async onPositionClosed(data: {
    positionPDA: string;
    lbPair: string;
    owner: string;
    side: 'Buy' | 'Sell';
    txSig?: string;
  }): Promise<void> {
    const userId = this.walletService.getUserIdForVault(data.owner);
    const actorId = userId?.replace('discord:', '');

    this.walletService.closePosition(data.positionPDA);

    const pools = loadPoolRegistry();
    const poolConfig = pools.find(p => p.address === data.lbPair);
    const poolName = poolConfig?.label ?? data.lbPair.slice(0, 8) + '...';
    const tokenSymbol = data.side === 'Buy'
      ? (poolConfig?.buyToken ?? 'TOKEN')
      : (poolConfig?.quoteToken ?? 'SOL');

    if (actorId) {
      const dmText = formatClosedDM({
        poolName,
        side: data.side,
        amountOut: '—',
        tokenSymbol,
        txSig: data.txSig,
      });
      await this.sendDM(actorId, dmText);
    }

    if (this.feedChannel) {
      const feedText = formatFeedClosed({
        side: data.side,
        poolName,
        priceLow: 0,
        priceHigh: 0,
        amountOut: '—',
        tokenSymbol,
        txSig: data.txSig ?? '',
        actorId,
      });
      await this.sendToFeed(feedText);
    }
  }

  /**
   * Called after new_epoch completes. Auto-claim itself is handled by
   * epoch-computer in the keeper's daily sequence — bot fronts the tx fee
   * and is reimbursed from each user's vault PDA via deduct_gas on the
   * bundled unwrap_wsol_in_vault. This stub is a placeholder for future
   * per-user DM notifications after distribution lands.
   */
  async onEpochComplete(data: {
    epoch: number;
    ipfsCid: string;
    leaves: Array<{ wallet: string; cumulative_amount: string; index: number; proof: number[][] }>;
  }): Promise<void> {
    // Auto-claim is now handled by epoch-computer.ts in the keeper daily sequence.
    // This stub remains for DM notifications after epoch distribution.
    console.log(`[notifier] onEpochComplete — epoch ${data.epoch}, ${data.leaves.length} leaves`);
  }

  async postToFeed(text: string): Promise<void> {
    await this.sendToFeed(text);
  }

  async postToOps(text: string): Promise<void> {
    await this.sendToOps(text);
  }

  private async sendDM(discordUserId: string, text: string): Promise<void> {
    try {
      const user = await this.client.users.fetch(discordUserId);
      await user.send(text);
    } catch (e: any) {
      console.warn(`[notifier] Failed to DM ${discordUserId}: ${e.message}`);
    }
  }

  private async sendToFeed(text: string): Promise<void> {
    if (!this.feedChannel) return;
    try {
      // allowedMentions suppresses the ping — handle still renders as a clickable link.
      // Owner already gets a DM; feed mention is attribution, not notification.
      await this.feedChannel.send({ content: text, flags: 1 << 2, allowedMentions: { parse: [] } });
    } catch (e: any) {
      console.warn(`[notifier] Failed to post to feed: ${e.message}`);
    }
  }

  private async sendToOps(text: string): Promise<void> {
    // Ops channel is optional — if not configured, silently drop the alert.
    // (Logs still go to pm2 via the alerter, so nothing is lost.)
    if (!this.opsChannel) return;
    try {
      await this.opsChannel.send({ content: text, flags: 1 << 2 });
    } catch (e: any) {
      console.warn(`[notifier] Failed to post to ops: ${e.message}`);
    }
  }
}

function formatLamports(lamports: string, decimals: number): string {
  const val = Number(lamports) / Math.pow(10, decimals);
  if (val >= 1000) return val.toFixed(2);
  if (val >= 1) return val.toFixed(4);
  return val.toFixed(6);
}
