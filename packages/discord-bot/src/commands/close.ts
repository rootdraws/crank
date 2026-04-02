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
  signAndSend, signAndSendLegacy, binToPrice, fetchDexScreenerPrice,
  SPL_MEMO_PROGRAM_ID, loadPoolRegistry,
} from '@crankbot/core-sdk';
import { formatPositionClosed, formatFeedClosed, formatError, formatPositionsList, PositionDisplayData } from '../formatter';
import type { BotContext } from '../index';

export async function handleClose(interaction: ChatInputCommandInteraction, ctx: BotContext): Promise<void> {
  const userId = `discord:${interaction.user.id}`;
  const idInput = interaction.options.getString('id')?.trim() ?? '';

  // Bare /close — show positions with IDs + instructions
  if (!idInput) {
    await interaction.deferReply({ ephemeral: true });

    const dbPositions = ctx.walletService.getOpenPositions(userId);
    if (dbPositions.length === 0) {
      await interaction.editReply('No open positions.');
      return;
    }

    const pools = loadPoolRegistry();
    const positions: PositionDisplayData[] = [];
    const poolCache = new Map<string, any>();
    const quoteUsdCache = new Map<string, number>();

    for (const p of dbPositions) {
      let poolData = poolCache.get(p.lb_pair);
      if (!poolData) {
        try {
          poolData = await parseLbPairFull(ctx.connection, p.lb_pair);
          poolCache.set(p.lb_pair, poolData);
        } catch {
          poolData = { activeId: 0, binStep: 10 };
        }
      }

      const poolConfig = pools.find(pc => pc.address === p.lb_pair);
      const decimalsX = poolConfig?.decimalsX ?? 9;
      const decimalsY = poolConfig?.decimalsY ?? 6;

      let quoteTokenUsdPrice = 1.0;
      if (poolConfig?.displayMode === 'mc' && poolConfig.mintY) {
        const isStable = ['USDC', 'USDT'].includes((poolConfig.quoteToken ?? '').toUpperCase());
        if (!isStable) {
          if (quoteUsdCache.has(poolConfig.mintY)) {
            quoteTokenUsdPrice = quoteUsdCache.get(poolConfig.mintY)!;
          } else {
            const qData = await fetchDexScreenerPrice(poolConfig.mintY).catch(() => null);
            quoteTokenUsdPrice = qData?.priceUsd ?? 1.0;
            quoteUsdCache.set(poolConfig.mintY, quoteTokenUsdPrice);
          }
        }
      }

      positions.push({
        positionPda: p.position_pda,
        lbPair: p.lb_pair,
        poolName: poolConfig?.label ?? p.lb_pair.slice(0, 8) + '...',
        side: p.side as 'Buy' | 'Sell',
        minBinId: p.min_bin_id,
        maxBinId: p.max_bin_id,
        activeBinId: poolData.activeId,
        binStep: poolConfig?.binStep ?? poolData.binStep,
        decimalsX,
        decimalsY,
        initialAmount: BigInt(p.initial_amount),
        harvestedAmount: ctx.walletService.getHarvestedTotal(p.position_pda),
        tokenSymbol: p.side === 'Buy'
          ? (poolConfig?.buyToken ?? 'TOKEN')
          : (poolConfig?.quoteToken ?? 'SOL'),
        quoteSymbol: p.side === 'Buy'
          ? (poolConfig?.quoteToken ?? 'SOL')
          : (poolConfig?.buyToken ?? 'TOKEN'),
        quoteDecimals: p.side === 'Buy' ? decimalsX : decimalsY,
        createdAt: p.created_at,
        displayMode: poolConfig?.displayMode as 'price' | 'mc' | undefined,
        supply: poolConfig?.supply,
        quoteTokenUsdPrice,
      });
    }

    const text = formatPositionsList(positions);
    const shortIds = dbPositions.map((p, i) => `\`/close ${p.position_pda.slice(0, 8)}\``).join(' · ');
    await interaction.editReply(
      text + '\n\n' + shortIds + '\n`/close all` to close everything'
    );
    return;
  }

  // /close all — rage quit
  if (idInput.toLowerCase() === 'all') {
    const dbPositions = ctx.walletService.getOpenPositions(userId);
    if (dbPositions.length === 0) {
      await interaction.reply({ content: 'No open positions.', ephemeral: true });
      return;
    }

    await interaction.deferReply({ ephemeral: false });

    const results: string[] = [];
    for (const position of dbPositions) {
      try {
        const sig = await closePosition(userId, position, ctx);
        const pools = loadPoolRegistry();
        const poolConfig = pools.find(p => p.address === position.lb_pair);
        const poolName = poolConfig?.label ?? position.lb_pair.slice(0, 8) + '...';
        results.push(`${position.side} ${poolName} — [closed](https://solscan.io/tx/${sig})`);
      } catch (e: any) {
        results.push(`${position.position_pda.slice(0, 8)}... — failed: ${e.message?.slice(0, 60)}`);
      }
    }

    await interaction.editReply(results.join('\n'));
    return;
  }

  // /close <id> — close specific position
  const position = ctx.walletService.findPositionByIdPrefix(userId, idInput);
  if (!position) {
    await interaction.reply({
      content: formatError(`no position found matching "${idInput}".`, '/close to see your positions'),
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply({ ephemeral: false });

  try {
    const sig = await closePosition(userId, position, ctx);

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

    await interaction.followUp({
      content: `TX: https://solscan.io/tx/${sig}`,
      ephemeral: true,
    });

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
    await interaction.editReply(`close failed: ${e.message?.slice(0, 150)}`);
  }
}

// ─── Shared close logic ───────────────────────────────────────────────────

async function closePosition(userId: string, position: any, ctx: BotContext): Promise<string> {
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
  return sig;
}
