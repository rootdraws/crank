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
    usdValue?: number | null;
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
      usdValue: data.usdValue ?? null,
      kind: 'harvest',
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
    tokenXAmount?: string;
    tokenYAmount?: string;
    usdValue?: number | null;
  }): Promise<void> {
    const userId = this.walletService.getUserIdForVault(data.owner);
    const actorId = userId?.replace('discord:', '');

    // Record a harvest row for the close — captures final yield so /stats
    // reflects total volume across both partial harvests and closes.
    const xAmt = BigInt(data.tokenXAmount ?? '0');
    const yAmt = BigInt(data.tokenYAmount ?? '0');
    const amountOutRaw = xAmt > yAmt ? xAmt : yAmt;
    if (amountOutRaw > 0n || (data.usdValue ?? 0) > 0) {
      this.walletService.saveHarvest({
        positionPda: data.positionPDA,
        vaultPda: data.owner,
        lbPair: data.lbPair,
        amountOut: amountOutRaw,
        feeTaken: 0n,
        txSig: data.txSig ?? '',
        slot: 0,
        usdValue: data.usdValue ?? null,
        kind: 'close',
      });
    }

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

    // JUP-baseline flex — if the position fully converted and we recorded a
    // market-quote baseline at open, compare actual DLMM yield vs market.
    // Only positive deltas get posted (a negative delta means market would
    // have beaten crank — not a flex). Failures are swallowed.
    try {
      await this.maybePostBaselineFlex(data.positionPDA, poolName, data.side, actorId);
    } catch (e: any) {
      console.warn(`[notifier] baseline flex failed: ${e.message?.slice(0, 120)}`);
    }
  }

  private async maybePostBaselineFlex(
    positionPda: string,
    poolName: string,
    side: 'Buy' | 'Sell',
    actorId: string | undefined,
  ): Promise<void> {
    const pos = this.walletService.getPositionByPda(positionPda);
    if (!pos?.baseline_out || !pos?.baseline_mint) return;

    const baseline = BigInt(pos.baseline_out);
    const actual = this.walletService.getActualHarvestedForPosition(positionPda);
    if (baseline === 0n || actual === 0n) return;

    const decimals = pos.baseline_decimals ?? 9;
    const humanBaseline = Number(baseline) / 10 ** decimals;
    const humanActual = Number(actual) / 10 ** decimals;
    const deltaPct = ((humanActual - humanBaseline) / humanBaseline) * 100;

    // Only flex when crank meaningfully beat market.
    if (deltaPct < 1) return;

    // Output token = the converted side (what we filled into).
    // On Buy: deposited quote, got base → tokenSym = pool base (e.g. CRANK).
    // On Sell: deposited base, got quote → tokenSym = pool quote (e.g. SOL).
    const parts = poolName.split('/');
    const tokenSym = side === 'Buy' ? (parts[0] || 'tokens') : (parts[1] || 'SOL');
    const verb = side === 'Sell' ? 'sold' : 'bought';
    const actorTag = actorId ? `<@${actorId}>` : 'a trader';

    const line = `${actorTag} ${verb} ${fmtAmount(humanActual)} ${tokenSym} via crank.money — +${deltaPct.toFixed(1)}% over a market ${side.toLowerCase()} at open.`;

    if (this.feedChannel) {
      await this.feedChannel.send({ content: line, allowedMentions: { parse: [] } });
    }

    // Tweet-ready variant — no @mention (X doesn't want Discord IDs), concrete
    // numbers, Twitter-appropriate length. Posted to ops channel for Root to
    // copy/paste; later wire to crank-crm's drafter for auto-submission.
    const actorForX = actorId ? `a ${verb.replace(/^b/, 'B')}er` : 'a trader';
    const tweet =
      `${actorForX} filled ${fmtAmount(humanActual)} $${tokenSym} via @crankdotmoney` +
      ` — +${deltaPct.toFixed(1)}% over a market ${side.toLowerCase()} at open.\n\n` +
      `DLMM limit orders, curated pools, non-custodial distribution.`;
    if (this.opsChannel) {
      try {
        await this.opsChannel.send({
          content: `📣 tweet-draft (copy/paste to X):\n\`\`\`\n${tweet}\n\`\`\``,
          allowedMentions: { parse: [] },
        });
      } catch { /* ops post is best-effort */ }
    }
  }

  /**
   * Format a human token amount for the flex line — thousands separators
   * on large numbers, decimals on small ones, to keep messages readable
   * across wildly different token magnitudes (1.2345 SOL vs 3,450,000 CRANK).
   */

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

function fmtAmount(val: number): string {
  if (val >= 10_000) return val.toLocaleString('en-US', { maximumFractionDigits: 0 });
  if (val >= 100) return val.toLocaleString('en-US', { maximumFractionDigits: 2 });
  if (val >= 1) return val.toFixed(4);
  return val.toFixed(6);
}
