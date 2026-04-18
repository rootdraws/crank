import { ChatInputCommandInteraction, TextChannel } from 'discord.js';
import { PublicKey, VersionedTransaction, TransactionMessage, Transaction } from '@solana/web3.js';
import { NATIVE_MINT, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { address } from '@solana/kit';
import {
  getUserCloseInstructionAsync,
} from '@crankbot/core-sdk/generated/bin-farm/index.js';
import {
  getConfigPDA, getPositionPDA, getVaultPDA, getRoverAuthorityPDA,
  resolveMeteoraCPIAccounts, parseLbPairFull, deriveATA,
  buildSetupTx, buildPriorityFeeIxs, kitIxToWeb3, asSigner, confirmAndCheck,
  signAndSend, signAndSendLegacy, binToPrice, fetchDexScreenerPrice,
  SPL_MEMO_PROGRAM_ID, METEORA_DLMM_PROGRAM_ID, loadPoolRegistry,
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
    const closeIds = [...dbPositions.map((_, i) => `/close ${i + 1}`), '/close all'].join(' · ');
    await interaction.editReply(text + '\n\n' + closeIds);
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

  // /close <id> — close specific position (by number or PDA prefix)
  let position: any;
  const num = parseInt(idInput, 10);
  if (!isNaN(num) && num > 0) {
    const allPositions = ctx.walletService.getOpenPositions(userId);
    position = allPositions[num - 1] ?? null;
  } else {
    position = ctx.walletService.findPositionByIdPrefix(userId, idInput);
  }
  if (!position) {
    await interaction.reply({
      content: formatError(`no position #${idInput}.`, '/close to see your positions'),
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
    // Deposit token: BUY deposits quote (SOL/USDC), SELL deposits base (CRANK)
    const tokenSymbol = position.side === 'Buy'
      ? (poolConfig?.quoteToken ?? 'SOL')
      : (poolConfig?.buyToken ?? 'TOKEN');
    const displayMode = poolConfig?.displayMode as 'price' | 'mc' | undefined;
    const supply = poolConfig?.supply;

    // Fetch quote token USD price for mcap display
    let quoteTokenUsdPrice = 1.0;
    if (displayMode === 'mc' && poolConfig?.mintY) {
      const isStable = ['USDC', 'USDT'].includes((poolConfig.quoteToken ?? '').toUpperCase());
      if (!isStable) {
        const qData = await fetchDexScreenerPrice(poolConfig.mintY).catch(() => null);
        quoteTokenUsdPrice = qData?.priceUsd ?? 1.0;
      }
    }

    // Read actual amount returned from the confirmed tx
    let amountOut = '—';
    try {
      const vaultKey = ctx.walletService.getVaultPda(userId)!.toBase58();
      // Deposit token mint: BUY deposits tokenY (SOL), SELL deposits tokenX (CRANK)
      const depositMint = position.side === 'Buy'
        ? (poolConfig?.mintY ?? '') : (poolConfig?.mintX ?? '');
      const depositDecimals = position.side === 'Buy' ? decimalsY : decimalsX;

      let txData = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        txData = await ctx.connection.getTransaction(sig, {
          maxSupportedTransactionVersion: 0, commitment: 'confirmed',
        });
        if (txData?.meta) break;
        await new Promise(r => setTimeout(r, 2000));
      }

      if (txData?.meta) {
        // Sum all token deltas going to the vault owner
        const pre = txData.meta.preTokenBalances ?? [];
        const post = txData.meta.postTokenBalances ?? [];
        let totalDelta = 0n;
        for (const p of post) {
          if (p.owner !== vaultKey) continue;
          if (depositMint && p.mint !== depositMint) continue;
          const preEntry = pre.find(e => e.accountIndex === p.accountIndex);
          const preBal = BigInt(preEntry?.uiTokenAmount?.amount ?? '0');
          const postBal = BigInt(p.uiTokenAmount.amount);
          const delta = postBal - preBal;
          if (delta > 0n) totalDelta += delta;
        }
        if (totalDelta > 0n) {
          const amt = Number(totalDelta) / Math.pow(10, depositDecimals);
          if (amt >= 1_000_000) {
            const m = amt / 1_000_000;
            amountOut = (m % 1 === 0 ? m.toFixed(0) : m.toFixed(2)) + 'M';
          } else if (amt >= 1_000) {
            const k = amt / 1_000;
            amountOut = (k % 1 === 0 ? k.toFixed(0) : k.toFixed(1)) + 'k';
          } else if (amt % 1 === 0) {
            amountOut = amt.toFixed(0);
          } else if (amt >= 1) {
            amountOut = amt.toFixed(2);
          } else {
            amountOut = amt.toFixed(4);
          }
        }
      }
    } catch { /* fall back to — */ }

    const closeParams = {
      side: position.side,
      poolName,
      priceLow,
      priceHigh,
      amountOut,
      tokenSymbol,
      txSig: sig,
      displayMode,
      supply,
      quoteTokenUsdPrice,
    };

    await interaction.editReply(formatPositionClosed(closeParams));

    await interaction.followUp({
      content: `TX: https://solscan.io/tx/${sig}`,
      ephemeral: true,
    });

    if (ctx.feedChannelId) {
      try {
        const feedChannel = await ctx.client.channels.fetch(ctx.feedChannelId) as TextChannel;
        if (feedChannel) {
          await feedChannel.send({
            content: formatFeedClosed({ ...closeParams, actorId: interaction.user.id }),
            allowedMentions: { parse: [] },
          });
        }
      } catch { /* best-effort */ }
    }
  } catch (e: any) {
    await interaction.editReply(`close failed: ${e.message?.slice(0, 150)}`);
  }
}

// ─── Shared close logic ───────────────────────────────────────────────────

async function closePosition(userId: string, position: any, ctx: BotContext): Promise<string> {
  const vaultPda = ctx.walletService.getVaultPda(userId);
  if (!vaultPda) throw new Error('No vault found — run /start first');
  const bot = ctx.botKeypair;

  const cpi = await resolveMeteoraCPIAccounts(
    ctx.connection, position.lb_pair, position.min_bin_id, position.max_bin_id
  );

  const meteoraPosition = new PublicKey(position.meteora_position);
  const [configPDA] = getConfigPDA();
  const [positionPDA] = getPositionPDA(meteoraPosition);
  const [posVaultPDA] = getVaultPDA(meteoraPosition);
  const [roverAuth] = getRoverAuthorityPDA();

  const vaultTokenX = deriveATA(cpi.tokenXMint, posVaultPDA, cpi.tokenXProgramId, true);
  const vaultTokenY = deriveATA(cpi.tokenYMint, posVaultPDA, cpi.tokenYProgramId, true);
  // user_token_x/y = vault PDA's ATAs (tokens go to vault, user withdraws later)
  const userTokenX = deriveATA(cpi.tokenXMint, vaultPda, cpi.tokenXProgramId, true);
  const userTokenY = deriveATA(cpi.tokenYMint, vaultPda, cpi.tokenYProgramId, true);
  const roverFeeTokenX = deriveATA(cpi.tokenXMint, roverAuth, cpi.tokenXProgramId, true);
  const roverFeeTokenY = deriveATA(cpi.tokenYMint, roverAuth, cpi.tokenYProgramId, true);

  const setupTx = await buildSetupTx(
    ctx.connection, bot.publicKey,
    [
      { ata: userTokenX, owner: vaultPda, mint: cpi.tokenXMint, tokenProgram: cpi.tokenXProgramId },
      { ata: userTokenY, owner: vaultPda, mint: cpi.tokenYMint, tokenProgram: cpi.tokenYProgramId },
      { ata: roverFeeTokenX, owner: roverAuth, mint: cpi.tokenXMint, tokenProgram: cpi.tokenXProgramId },
      { ata: roverFeeTokenY, owner: roverAuth, mint: cpi.tokenYMint, tokenProgram: cpi.tokenYProgramId },
    ]
  );

  if (setupTx) {
    await signAndSendLegacy(setupTx, bot, ctx.connection);
  }

  // Build instruction, fix bitmap extension writable, send manually
  const closeIx = await ctx.coreProgram.methods
    .userClose()
    .accounts({
      caller: bot.publicKey,
      config: configPDA,
      userVault: vaultPda,
      position: positionPDA,
      vault: posVaultPDA,
      meteoraPosition,
      lbPair: cpi.lbPair,
      binArrayBitmapExt: cpi.binArrayBitmapExt,
      binArrayLower: cpi.binArrayLower,
      binArrayUpper: cpi.binArrayUpper,
      reserveX: cpi.reserveX,
      reserveY: cpi.reserveY,
      tokenXMint: cpi.tokenXMint,
      tokenYMint: cpi.tokenYMint,
      eventAuthority: cpi.eventAuthority,
      dlmmProgram: cpi.dlmmProgram,
      vaultTokenX,
      vaultTokenY,
      userTokenX,
      userTokenY,
      roverAuthority: roverAuth,
      roverFeeTokenX,
      roverFeeTokenY,
      tokenXProgram: cpi.tokenXProgramId,
      tokenYProgram: cpi.tokenYProgramId,
      memoProgram: SPL_MEMO_PROGRAM_ID,
      systemProgram: new PublicKey('11111111111111111111111111111111'),
    })
    .instruction();

  // Bitmap extension must be writable for Meteora CPI (IDL marks it read-only)
  if (!cpi.binArrayBitmapExt.equals(METEORA_DLMM_PROGRAM_ID)) {
    for (const key of closeIx.keys) {
      if (key.pubkey.equals(cpi.binArrayBitmapExt)) {
        key.isWritable = true;
      }
    }
  }

  const closeTx = new Transaction().add(...(await buildPriorityFeeIxs(ctx.connection, 1_400_000)), closeIx);
  closeTx.feePayer = bot.publicKey;
  const closeBh = await ctx.connection.getLatestBlockhash();
  closeTx.recentBlockhash = closeBh.blockhash;
  closeTx.sign(bot);
  const sig = await ctx.connection.sendRawTransaction(closeTx.serialize(), { skipPreflight: true });
  await confirmAndCheck(ctx.connection, sig, closeBh.blockhash, closeBh.lastValidBlockHeight);

  // Auto-unwrap vault WSOL → native SOL so /balance reflects the full return
  // immediately. Without this, closes on SOL-quoted pools leave WSOL parked in
  // the vault ATA that /balance hides (WSOL is skipped as transient).
  if (cpi.tokenXMint.equals(NATIVE_MINT) || cpi.tokenYMint.equals(NATIVE_MINT)) {
    try {
      const wsolAta = getAssociatedTokenAddressSync(NATIVE_MINT, vaultPda, true, TOKEN_PROGRAM_ID);
      await ctx.coreProgram.methods
        .unwrapWsolInVault()
        .accounts({
          caller: bot.publicKey,
          config: configPDA,
          userVault: vaultPda,
          vaultWsolAta: wsolAta,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([bot])
        .rpc();
    } catch { /* best-effort; /withdraw SOL unwraps on demand */ }
  }

  ctx.walletService.closePosition(position.position_pda);
  return sig;
}
