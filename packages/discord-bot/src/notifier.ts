/**
 * discord-bot/src/notifier.ts
 *
 * Two outputs for every protocol event:
 * 1. DM to the position owner (private)
 * 2. Post to the feed channel (public — the protocol's heartbeat)
 */

import { Client, TextChannel } from 'discord.js';
import { WalletService, KNOWN_TOKENS } from '@crankbot/core-sdk';
import { formatHarvestDM, formatClosedDM, formatFeedHarvested, formatFeedClosed } from './formatter';

export class DiscordNotifier {
  private feedChannel: TextChannel | null = null;

  constructor(
    private client: Client,
    private walletService: WalletService
  ) {
    this.client.on('ready', () => {
      this.resolveFeedChannel();
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
    const userId = this.walletService.getUserIdForOwner(data.owner);

    this.walletService.saveHarvest({
      positionPda: data.positionPDA,
      walletPubkey: data.owner,
      lbPair: data.lbPair,
      amountOut: BigInt(data.tokenXAmount ?? data.tokenYAmount ?? '0'),
      feeTaken: BigInt(data.feeAmount ?? '0'),
      txSig: data.txSig ?? '',
      slot: 0,
    });

    const amountOut = data.side === 'Buy'
      ? formatLamports(data.tokenXAmount ?? '0', 9)
      : formatLamports(data.tokenYAmount ?? '0', 9);
    const totalHarvested = formatLamports(data.totalHarvested ?? '0', 9);
    const poolName = data.lbPair.slice(0, 8) + '...';
    const tokenSymbol = data.side === 'Buy' ? 'TOKEN' : 'SOL';

    // DM the position owner
    if (userId) {
      const discordUserId = userId.replace('discord:', '');
      const dmText = formatHarvestDM({
        poolName,
        side: data.side,
        binCount: data.binCount,
        amountOut,
        tokenSymbol,
        totalHarvested,
        txSig: data.txSig,
      });
      await this.sendDM(discordUserId, dmText);
    }

    // Post to feed channel
    if (this.feedChannel) {
      const feedText = formatFeedHarvested({
        poolName,
        side: data.side,
        amountOut,
        tokenSymbol,
        txSig: data.txSig ?? '',
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
    const userId = this.walletService.getUserIdForOwner(data.owner);

    this.walletService.closePosition(data.positionPDA);

    const poolName = data.lbPair.slice(0, 8) + '...';
    const tokenSymbol = data.side === 'Buy' ? 'TOKEN' : 'SOL';

    if (userId) {
      const discordUserId = userId.replace('discord:', '');
      const dmText = formatClosedDM({
        poolName,
        side: data.side,
        amountOut: '—',
        tokenSymbol,
        txSig: data.txSig,
      });
      await this.sendDM(discordUserId, dmText);
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
      });
      await this.sendToFeed(feedText);
    }
  }

  async postToFeed(text: string): Promise<void> {
    await this.sendToFeed(text);
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
      await this.feedChannel.send(text);
    } catch (e: any) {
      console.warn(`[notifier] Failed to post to feed: ${e.message}`);
    }
  }
}

function formatLamports(lamports: string, decimals: number): string {
  const val = Number(lamports) / Math.pow(10, decimals);
  if (val >= 1000) return val.toFixed(2);
  if (val >= 1) return val.toFixed(4);
  return val.toFixed(6);
}
