import { ChatInputCommandInteraction, TextChannel } from 'discord.js';
import { PublicKey, VersionedTransaction, TransactionMessage } from '@solana/web3.js';
import { address } from '@solana/kit';
import {
  getUserCloseInstructionAsync,
} from '@crankbot/core-sdk/generated/bin-farm/index.js';
import {
  getConfigPDA, getPositionPDA, getVaultPDA, getRoverAuthorityPDA,
  resolveMeteoraCPIAccounts, parseLbPairFull, deriveATA,
  buildSetupTx, buildPriorityFeeIxs, kitIxToWeb3, asSigner,
  signAndSend, signAndSendLegacy, binToPrice,
  SPL_MEMO_PROGRAM_ID, loadPoolRegistry,
} from '@crankbot/core-sdk';
import { formatPositionClosed, formatFeedClosed, formatError } from '../formatter';
import type { BotContext } from '../index';

export async function handleClose(interaction: ChatInputCommandInteraction, ctx: BotContext): Promise<void> {
  const userId = `discord:${interaction.user.id}`;
  const idPrefix = interaction.options.getString('id', true);

  const position = ctx.walletService.findPositionByIdPrefix(userId, idPrefix);
  if (!position) {
    await interaction.reply({
      content: formatError(`no position found matching "${idPrefix}".`, '/positions to see your open positions'),
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply({ ephemeral: false });

  try {
    const keypair = ctx.walletService.getOrCreate(userId);
    const user = keypair.publicKey;

    const cpi = await resolveMeteoraCPIAccounts(
      ctx.connection, position.lb_pair, position.min_bin_id, position.max_bin_id
    );

    const meteoraPosition = new PublicKey(position.meteora_position);
    const [configPDA] = getConfigPDA();
    const [positionPDA] = getPositionPDA(meteoraPosition);
    const [vaultPDA] = getVaultPDA(meteoraPosition);
    const [roverAuth] = getRoverAuthorityPDA();

    const vaultTokenX = deriveATA(cpi.tokenXMint, vaultPDA, cpi.tokenXProgramId, true);
    const vaultTokenY = deriveATA(cpi.tokenYMint, vaultPDA, cpi.tokenYProgramId, true);
    const userTokenX = deriveATA(cpi.tokenXMint, user, cpi.tokenXProgramId, false);
    const userTokenY = deriveATA(cpi.tokenYMint, user, cpi.tokenYProgramId, false);
    const roverFeeTokenX = deriveATA(cpi.tokenXMint, roverAuth, cpi.tokenXProgramId, true);
    const roverFeeTokenY = deriveATA(cpi.tokenYMint, roverAuth, cpi.tokenYProgramId, true);

    // TX 1: setup ATAs
    const setupTx = await buildSetupTx(
      ctx.connection, user,
      [
        { ata: userTokenX, owner: user, mint: cpi.tokenXMint, tokenProgram: cpi.tokenXProgramId },
        { ata: userTokenY, owner: user, mint: cpi.tokenYMint, tokenProgram: cpi.tokenYProgramId },
        { ata: roverFeeTokenX, owner: roverAuth, mint: cpi.tokenXMint, tokenProgram: cpi.tokenXProgramId },
        { ata: roverFeeTokenY, owner: roverAuth, mint: cpi.tokenYMint, tokenProgram: cpi.tokenYProgramId },
      ]
    );

    if (setupTx) {
      await signAndSendLegacy(setupTx, keypair, ctx.connection);
    }

    // TX 2: userClose via Codama
    const closeIx = await getUserCloseInstructionAsync({
      user: asSigner(user),
      position: address(positionPDA.toBase58()),
      vault: address(vaultPDA.toBase58()),
      meteoraPosition: address(meteoraPosition.toBase58()),
      lbPair: address(cpi.lbPair.toBase58()),
      binArrayBitmapExt: address(cpi.binArrayBitmapExt.toBase58()),
      binArrayLower: address(cpi.binArrayLower.toBase58()),
      binArrayUpper: address(cpi.binArrayUpper.toBase58()),
      reserveX: address(cpi.reserveX.toBase58()),
      reserveY: address(cpi.reserveY.toBase58()),
      tokenXMint: address(cpi.tokenXMint.toBase58()),
      tokenYMint: address(cpi.tokenYMint.toBase58()),
      eventAuthority: address(cpi.eventAuthority.toBase58()),
      dlmmProgram: address(cpi.dlmmProgram.toBase58()),
      vaultTokenX: address(vaultTokenX.toBase58()),
      vaultTokenY: address(vaultTokenY.toBase58()),
      userTokenX: address(userTokenX.toBase58()),
      userTokenY: address(userTokenY.toBase58()),
      roverFeeTokenX: address(roverFeeTokenX.toBase58()),
      roverFeeTokenY: address(roverFeeTokenY.toBase58()),
      tokenXProgram: address(cpi.tokenXProgramId.toBase58()),
      tokenYProgram: address(cpi.tokenYProgramId.toBase58()),
      memoProgram: address(SPL_MEMO_PROGRAM_ID.toBase58()),
    });

    const closeWeb3Ix = kitIxToWeb3(closeIx);

    if (!cpi.binArrayBitmapExt.equals(cpi.dlmmProgram)) {
      const bmIdx = closeWeb3Ix.keys.findIndex(k => k.pubkey.equals(cpi.binArrayBitmapExt));
      if (bmIdx >= 0) closeWeb3Ix.keys[bmIdx].isWritable = true;
    }

    const priorityIxs = await buildPriorityFeeIxs(ctx.connection);
    const { blockhash, lastValidBlockHeight } = await ctx.connection.getLatestBlockhash();
    const msg = new TransactionMessage({
      payerKey: user,
      recentBlockhash: blockhash,
      instructions: [...priorityIxs, closeWeb3Ix],
    }).compileToV0Message();
    const vtx = new VersionedTransaction(msg);

    const sig = await signAndSend(vtx, keypair, ctx.connection, blockhash, lastValidBlockHeight);

    ctx.walletService.closePosition(position.position_pda);

    // Resolve pool config for display
    const pools = loadPoolRegistry();
    const poolConfig = pools.find(p => p.address === position.lb_pair);
    const poolData = await parseLbPairFull(ctx.connection, position.lb_pair).catch(() => null);
    const binStep = poolConfig?.binStep ?? poolData?.binStep ?? 10;
    const decimalsX = poolConfig?.decimalsX ?? 9;
    const decimalsY = poolConfig?.decimalsY ?? 6;
    const priceLow = binToPrice(position.min_bin_id, binStep, decimalsX, decimalsY);
    const priceHigh = binToPrice(position.max_bin_id, binStep, decimalsX, decimalsY);
    const poolName = poolConfig?.label ?? position.lb_pair.slice(0, 8) + '...';
    const tokenSymbol = position.side === 'Buy'
      ? (poolConfig?.buyToken ?? 'TOKEN')
      : (poolConfig?.quoteToken ?? 'SOL');

    // Public reply
    const publicText = formatPositionClosed({
      side: position.side,
      poolName,
      priceLow,
      priceHigh,
      amountOut: '—',
      tokenSymbol,
      txSig: sig,
    });
    await interaction.editReply(publicText);

    // Ephemeral follow-up with tx
    await interaction.followUp({
      content: `TX: https://solscan.io/tx/${sig}`,
      ephemeral: true,
    });

    // Feed channel
    if (ctx.feedChannelId) {
      try {
        const feedChannel = await ctx.client.channels.fetch(ctx.feedChannelId) as TextChannel;
        if (feedChannel) {
          await feedChannel.send(formatFeedClosed({
            side: position.side,
            poolName,
            priceLow,
            priceHigh,
            amountOut: '—',
            tokenSymbol,
            txSig: sig,
          }));
        }
      } catch { /* best-effort */ }
    }
  } catch (e: any) {
    await interaction.editReply(`🦧 close failed: ${e.message?.slice(0, 150)}`);
  }
}
