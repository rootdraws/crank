import { ChatInputCommandInteraction, TextChannel } from 'discord.js';
import { PublicKey, VersionedTransaction, TransactionMessage } from '@solana/web3.js';
import { address } from '@solana/kit';
import {
  getOpenPositionV2InstructionAsync,
  Side,
} from '@crankbot/core-sdk/generated/bin-farm/index.js';
import {
  getPositionCounterPDA, getMeteoraPositionPDA,
  getPositionPDA, getVaultPDA,
  resolveMeteoraCPIAccounts, parseLbPairFull, deriveATA,
  buildSetupTx, buildWrapSolIxs, ensureBinArraysExist,
  buildPriorityFeeIxs, kitIxToWeb3, asSigner,
  binToPrice, formatPrice,
  signAndSend, signAndSendLegacy, withUserLock,
  NATIVE_MINT,
  loadPoolRegistry, routeCommand, isRouteError,
  parseCommand, fetchDexScreenerPrice,
} from '@crankbot/core-sdk';
import { formatPositionOpened, formatPositionEphemeral, formatFeedOpened, formatError } from '../formatter';
import type { BotContext } from '../index';

export async function handleBuy(interaction: ChatInputCommandInteraction, ctx: BotContext): Promise<void> {
  await handleOpenPosition(interaction, ctx, 'Buy');
}

export async function handleOpenPosition(
  interaction: ChatInputCommandInteraction,
  ctx: BotContext,
  side: 'Buy' | 'Sell'
): Promise<void> {
  const userId = `discord:${interaction.user.id}`;
  const rangeStr = interaction.options.getString('range', true);

  const parsed = parseCommand(rangeStr);
  if (!parsed) {
    const example = side === 'Buy'
      ? '/buy SOL 84 to 74 1000 USDC'
      : '/sell SOL 98 to 115 10 SOL';
    await interaction.reply({ content: formatError('could not parse that.', `e.g. ${example}`), ephemeral: true });
    return;
  }

  const { token, rangeA, rangeB, amount, quote } = parsed;

  // Check minimum SOL balance for rent + gas
  const MIN_SOL_LAMPORTS = 250_000_000; // 0.25 SOL
  const keypair = ctx.walletService.getOrCreate(userId);
  const solBalance = await ctx.connection.getBalance(keypair.publicKey);
  if (solBalance < MIN_SOL_LAMPORTS) {
    const addr = keypair.publicKey.toBase58();
    await interaction.reply({
      content: formatError(
        `need at least 0.25 SOL for rent + gas (you have ${(solBalance / 1e9).toFixed(3)} SOL).`,
        `/deposit to see your address. We recommend adding 0.5 SOL for transactions.`
      ),
      ephemeral: true,
    });
    return;
  }

  // Load pool registry and fetch current price for routing
  const pools = loadPoolRegistry();
  const candidates = pools.filter(
    p => p.buyToken.toUpperCase() === token.toUpperCase() &&
         p.quoteToken.toUpperCase() === quote.toUpperCase()
  );

  if (candidates.length === 0) {
    await interaction.reply({
      content: formatError(`no pool found for ${token}/${quote}.`, '/pools to see covered pairs'),
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply({ ephemeral: false });

  try {
    // Fetch current price — DexScreener for tokens without DLMM liquidity, on-chain otherwise
    const refPool = candidates[0];
    let currentPrice: number;

    // Fetch current price and quote token price for bin calculation
    let quoteTokenUsdPrice = 1.0;

    if (refPool.priceSource === 'dexscreener') {
      const isStableQuote = ['USDC', 'USDT'].includes(refPool.quoteToken.toUpperCase());
      const [tokenData, quoteData] = await Promise.all([
        fetchDexScreenerPrice(refPool.mintX),
        isStableQuote ? Promise.resolve({ priceUsd: 1.0 }) : fetchDexScreenerPrice(refPool.mintY),
      ]);
      if (!tokenData) {
        await interaction.editReply(formatError('could not fetch current price from DexScreener.', 'try again in a moment'));
        return;
      }
      if (!quoteData) {
        await interaction.editReply(formatError(`could not fetch ${refPool.quoteToken} price.`, 'try again in a moment'));
        return;
      }
      currentPrice = tokenData.priceUsd;
      quoteTokenUsdPrice = quoteData.priceUsd;
    } else {
      const refData = await parseLbPairFull(ctx.connection, refPool.address);
      currentPrice = binToPrice(refData.activeId, refData.binStep, refPool.decimalsX, refPool.decimalsY);
    }

    // Route to best pool — converts USD prices to DLMM-native prices internally
    const route = routeCommand(token, quote, rangeA, rangeB, currentPrice, pools, quoteTokenUsdPrice);
    if (isRouteError(route)) {
      await interaction.editReply(formatError(route.error, route.suggestion));
      return;
    }

    const { pool: selectedPool, positions } = route;
    // Convert native prices back to USD for validation and display
    const priceLow = route.priceLow * quoteTokenUsdPrice;
    const priceHigh = route.priceHigh * quoteTokenUsdPrice;

    // Validate side vs current price
    if (side === 'Buy' && priceHigh >= currentPrice) {
      await interaction.editReply(formatError(
        `range crosses current price ($${formatPrice(currentPrice)}).`,
        `buy range must be below current price`
      ));
      return;
    }
    if (side === 'Sell' && priceLow <= currentPrice) {
      await interaction.editReply(formatError(
        `range crosses current price ($${formatPrice(currentPrice)}).`,
        `sell range must be above current price`
      ));
      return;
    }

    // TODO: if positions.length > 1, show split confirmation before proceeding

    // Open each position
    const sigs: string[] = [];
    const positionPDAs: PublicKey[] = [];

    const lockKey = `${userId}:${selectedPool.address}`;

    for (const pos of positions) {
      const result = await withUserLock(lockKey, async () => {
        const keypair = ctx.walletService.getOrCreate(userId);
        const user = keypair.publicKey;
        const poolPubkey = new PublicKey(selectedPool.address);

        const cpi = await resolveMeteoraCPIAccounts(ctx.connection, poolPubkey, pos.minBinId, pos.maxBinId);

        const depositMint = side === 'Buy' ? cpi.tokenYMint : cpi.tokenXMint;
        const depositTokenProgram = side === 'Buy' ? cpi.tokenYProgramId : cpi.tokenXProgramId;
        const depositDecimals = side === 'Buy' ? selectedPool.decimalsY : selectedPool.decimalsX;
        const positionAmount = BigInt(Math.round(amount * pos.depositFraction * Math.pow(10, depositDecimals)));

        // Read position counter
        const [counterPDA] = getPositionCounterPDA(user, cpi.lbPair);
        let posCounter = 0;
        try {
          const counterInfo = await ctx.connection.getAccountInfo(counterPDA);
          if (counterInfo && counterInfo.data.length >= 16) {
            posCounter = Number(
              new DataView(counterInfo.data.buffer, counterInfo.data.byteOffset)
                .getBigUint64(8, true)
            );
          }
        } catch { /* first position */ }

        const [meteoraPositionPDA] = getMeteoraPositionPDA(user, cpi.lbPair, posCounter);
        const [positionPDA] = getPositionPDA(meteoraPositionPDA);
        const [vaultPDA] = getVaultPDA(meteoraPositionPDA);

        const isNative = depositMint.equals(NATIVE_MINT);
        const userTokenAccount = deriveATA(depositMint, user, depositTokenProgram, false);
        const vaultTokenX = deriveATA(cpi.tokenXMint, vaultPDA, cpi.tokenXProgramId, true);
        const vaultTokenY = deriveATA(cpi.tokenYMint, vaultPDA, cpi.tokenYProgramId, true);

        // TX 1: setup
        const initBinArrayIxs = await ensureBinArraysExist(ctx.connection, cpi.lbPair, pos.minBinId, pos.maxBinId, user);
        const extraSetupIxs = [...initBinArrayIxs];
        if (isNative) extraSetupIxs.push(...buildWrapSolIxs(user, userTokenAccount, positionAmount));

        const setupTx = await buildSetupTx(
          ctx.connection, user,
          [
            { ata: userTokenAccount, owner: user, mint: depositMint, tokenProgram: depositTokenProgram },
            { ata: vaultTokenX, owner: vaultPDA, mint: cpi.tokenXMint, tokenProgram: cpi.tokenXProgramId },
            { ata: vaultTokenY, owner: vaultPDA, mint: cpi.tokenYMint, tokenProgram: cpi.tokenYProgramId },
          ],
          extraSetupIxs
        );

        if (setupTx) {
          await signAndSendLegacy(setupTx, keypair, ctx.connection);
        }

        // TX 2: open position
        const slippage = selectedPool.binStep >= 80 ? 15 : 5;
        const openIx = await getOpenPositionV2InstructionAsync({
          user: asSigner(user),
          lbPair: address(cpi.lbPair.toBase58()),
          positionCounter: address(counterPDA.toBase58()),
          meteoraPosition: address(meteoraPositionPDA.toBase58()),
          binArrayBitmapExt: address(cpi.binArrayBitmapExt.toBase58()),
          reserveX: address(cpi.reserveX.toBase58()),
          reserveY: address(cpi.reserveY.toBase58()),
          userTokenAccount: address(userTokenAccount.toBase58()),
          vaultTokenX: address(vaultTokenX.toBase58()),
          vaultTokenY: address(vaultTokenY.toBase58()),
          tokenXProgram: address(cpi.tokenXProgramId.toBase58()),
          tokenYProgram: address(cpi.tokenYProgramId.toBase58()),
          binArrayLower: address(cpi.binArrayLower.toBase58()),
          binArrayUpper: address(cpi.binArrayUpper.toBase58()),
          eventAuthority: address(cpi.eventAuthority.toBase58()),
          dlmmProgram: address(cpi.dlmmProgram.toBase58()),
          tokenXMint: address(cpi.tokenXMint.toBase58()),
          tokenYMint: address(cpi.tokenYMint.toBase58()),
          amount: BigInt(positionAmount.toString()),
          minBinId: pos.minBinId,
          maxBinId: pos.maxBinId,
          side: side === 'Buy' ? Side.Buy : Side.Sell,
          maxActiveBinSlippage: slippage,
        });

        const openWeb3Ix = kitIxToWeb3(openIx);

        if (!cpi.binArrayBitmapExt.equals(cpi.dlmmProgram)) {
          const bmIdx = openWeb3Ix.keys.findIndex(k => k.pubkey.equals(cpi.binArrayBitmapExt));
          if (bmIdx >= 0) openWeb3Ix.keys[bmIdx].isWritable = true;
        }

        const priorityIxs = await buildPriorityFeeIxs(ctx.connection);
        const { blockhash, lastValidBlockHeight } = await ctx.connection.getLatestBlockhash();
        const msg = new TransactionMessage({
          payerKey: user,
          recentBlockhash: blockhash,
          instructions: [...priorityIxs, openWeb3Ix],
        }).compileToV0Message();
        const vtx = new VersionedTransaction(msg);

        const sig = await signAndSend(vtx, keypair, ctx.connection, blockhash, lastValidBlockHeight);

        ctx.walletService.savePosition({
          positionPda: positionPDA.toBase58(),
          userId,
          walletPubkey: user.toBase58(),
          lbPair: cpi.lbPair.toBase58(),
          meteoraPosition: meteoraPositionPDA.toBase58(),
          side,
          minBinId: pos.minBinId,
          maxBinId: pos.maxBinId,
          initialAmount: positionAmount,
        });

        return { sig, positionPDA };
      });

      sigs.push(result.sig);
      positionPDAs.push(result.positionPDA);
    }

    // Public reply
    const publicText = formatPositionOpened({
      side,
      poolName: `${token}/${quote}`,
      priceLow,
      priceHigh,
      currentPrice,
      amount,
      quoteSymbol: quote,
      txSig: sigs[0],
    });
    await interaction.editReply(
      positions.length > 1
        ? `${publicText}\n_Split into ${positions.length} positions (${sigs.length} txs)_`
        : publicText
    );

    // Ephemeral follow-up
    await interaction.followUp({
      content: formatPositionEphemeral(positionPDAs[0].toBase58(), sigs[0]),
      ephemeral: true,
    });

    // Feed channel
    if (ctx.feedChannelId) {
      try {
        const feedChannel = await ctx.client.channels.fetch(ctx.feedChannelId) as TextChannel;
        if (feedChannel) {
          await feedChannel.send(formatFeedOpened({
            side,
            poolName: `${token}/${quote}`,
            priceLow,
            priceHigh,
            amount,
            quoteSymbol: quote,
            txSig: sigs[0],
          }));
        }
      } catch { /* feed channel post is best-effort */ }
    }
  } catch (e: any) {
    // Extract useful error from simulation logs
    let errMsg = 'unknown error';
    const logs: string[] = e.logs || e.simulationResponse?.logs || [];
    const failLog = logs.find((l: string) => l.includes('failed') || l.includes('Error') || l.includes('insufficient'));
    if (failLog) {
      errMsg = failLog.slice(0, 300);
    } else if (e.message) {
      errMsg = e.message.slice(0, 300);
    }
    // Log full error server-side for debugging
    console.error(`[buy] Error for ${interaction.user.id}:`, e.message?.slice(0, 500));
    if (logs.length) console.error(`[buy] Simulation logs:`, logs.join('\n'));

    if (interaction.deferred) {
      await interaction.editReply(errMsg);
    } else {
      await interaction.reply({ content: errMsg, ephemeral: true });
    }
  }
}
