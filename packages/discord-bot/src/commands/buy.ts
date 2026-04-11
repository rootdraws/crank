import { ChatInputCommandInteraction, TextChannel, ButtonBuilder, ButtonStyle, ActionRowBuilder } from 'discord.js';
import { PublicKey, VersionedTransaction, TransactionMessage, Transaction } from '@solana/web3.js';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import { address } from '@solana/kit';
import { BN } from '@coral-xyz/anchor';
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
  NATIVE_MINT, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, KNOWN_TOKENS,
  loadPoolRegistry, routeCommand, isRouteError,
  parseCommand, fetchDexScreenerPrice, hasTransferHook,
} from '@crankbot/core-sdk';
import { formatPositionOpened, formatPositionEphemeral, formatFeedOpened, formatError, formatErrorBig } from '../formatter';
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
      ? '/buy CRANK 15k to 20k 0.5 SOL'
      : '/sell CRANK 25k to 35k 4000000 CRANK';
    const err = formatErrorBig('could not parse that.', `e.g. ${example}`);
    await interaction.reply({ content: err.monke, ephemeral: true });
    await interaction.followUp({ content: err.body, ephemeral: true });
    return;
  }

  let { token, rangeA, rangeB, amount, quote } = parsed;

  // For sells, if the user typed the base token as the quote (e.g. "4000000 CRANK"),
  // resolve the actual quote token from the pool registry
  const pools = loadPoolRegistry();
  if (side === 'Sell' && token.toUpperCase() === quote.toUpperCase()) {
    const match = pools.find(p => p.buyToken.toUpperCase() === token.toUpperCase());
    if (match) {
      quote = match.quoteToken;
    }
  }

  // Ensure user has a vault
  const vaultPda = ctx.walletService.getVaultPda(userId);
  if (!vaultPda) {
    const err = formatErrorBig(
      'no vault found.',
      'Run `/start wallet:<your-solana-address>` first to create your vault.'
    );
    await interaction.reply({ content: err.monke, ephemeral: true });
    await interaction.followUp({ content: err.body, ephemeral: true });
    return;
  }

  // Check minimum SOL balance in vault for rent + gas
  const MIN_SOL_LAMPORTS = 10_000_000; // 0.01 SOL
  const solBalance = await ctx.connection.getBalance(vaultPda);
  if (solBalance < MIN_SOL_LAMPORTS) {
    const err = formatErrorBig(
      `vault is empty (${(solBalance / 1e9).toFixed(4)} SOL).`,
      `Deposit SOL to \`${vaultPda.toBase58()}\``
    );
    await interaction.reply({ content: err.monke, ephemeral: true });
    await interaction.followUp({ content: err.body, ephemeral: true });
    return;
  }

  // Load pool registry and fetch current price for routing
  const candidates = pools.filter(
    p => p.buyToken.toUpperCase() === token.toUpperCase() &&
         p.quoteToken.toUpperCase() === quote.toUpperCase()
  );

  if (candidates.length === 0) {
    const err = formatErrorBig(`no pool found for ${token}/${quote}.`, '/pools to see covered pairs');
    await interaction.reply({ content: err.monke, ephemeral: true });
    await interaction.followUp({ content: err.body,
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

    // Reject pools with Token-2022 transfer hooks (Meteora CPI uses empty_hooks())
    if (selectedPool.mintX && await hasTransferHook(ctx.connection, new PublicKey(selectedPool.mintX))) {
      await interaction.editReply(formatError(`${selectedPool.tokenX} has a Token-2022 transfer hook — not supported yet.`));
      return;
    }
    if (selectedPool.mintY && await hasTransferHook(ctx.connection, new PublicKey(selectedPool.mintY))) {
      await interaction.editReply(formatError(`${selectedPool.tokenY} has a Token-2022 transfer hook — not supported yet.`));
      return;
    }

    // TODO: if positions.length > 1, show split confirmation before proceeding

    // Check if vault has ATAs for non-SOL tokens in this pool.
    // If not, prompt the user to enable trading for that token.
    {
      const nonSolMints: { mint58: string; symbol: string }[] = [];
      if (selectedPool.mintX !== NATIVE_MINT.toBase58()) {
        nonSolMints.push({ mint58: selectedPool.mintX, symbol: selectedPool.tokenX });
      }
      if (selectedPool.mintY !== NATIVE_MINT.toBase58()) {
        nonSolMints.push({ mint58: selectedPool.mintY, symbol: selectedPool.tokenY });
      }

      const missingTokens: { mint58: string; symbol: string }[] = [];
      for (const t of nonSolMints) {
        const mint = new PublicKey(t.mint58);
        const mintInfo = await ctx.connection.getAccountInfo(mint);
        if (!mintInfo) continue;
        const tokenProgram = mintInfo.owner.equals(TOKEN_2022_PROGRAM_ID)
          ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
        const ata = getAssociatedTokenAddressSync(mint, vaultPda!, true, tokenProgram);
        const ataInfo = await ctx.connection.getAccountInfo(ata);
        if (!ataInfo) missingTokens.push(t);
      }

      if (missingTokens.length > 0) {
        const buttons = missingTokens.map(t =>
          new ButtonBuilder()
            .setCustomId(`enable_token:${t.mint58}`)
            .setLabel(`Enable $${t.symbol}`)
            .setStyle(ButtonStyle.Primary)
        );
        const row = new ActionRowBuilder<ButtonBuilder>().addComponents(...buttons);
        await interaction.editReply({
          content: `**$${missingTokens.map(t => t.symbol).join(', $')}** isn't enabled on your vault yet.\n\nEnable it to deposit and trade.`,
          components: [row],
        });
        return;
      }
    }

    // Open each position
    const sigs: string[] = [];
    const positionPDAs: PublicKey[] = [];

    const lockKey = `${userId}:${selectedPool.address}`;

    const { getUserVaultPDA } = await import('@crankbot/core-sdk');
    const bot = ctx.botKeypair;

    for (const pos of positions) {
      const result = await withUserLock(lockKey, async () => {
        const poolPubkey = new PublicKey(selectedPool.address);
        const cpi = await resolveMeteoraCPIAccounts(ctx.connection, poolPubkey, pos.minBinId, pos.maxBinId);

        const depositMint = side === 'Buy' ? cpi.tokenYMint : cpi.tokenXMint;
        const depositTokenProgram = side === 'Buy' ? cpi.tokenYProgramId : cpi.tokenXProgramId;
        const depositDecimals = side === 'Buy' ? selectedPool.decimalsY : selectedPool.decimalsX;
        const scaledAmount = BigInt(Math.round(amount * 1e9)) * BigInt(Math.round(pos.depositFraction * 1e9));
        const positionAmount = scaledAmount * BigInt(Math.pow(10, depositDecimals)) / BigInt(1e18);
        const positionAmountBN = new BN(positionAmount.toString());

        // PDA seeds use vaultPda (not user wallet)
        const [counterPDA] = getPositionCounterPDA(vaultPda!, cpi.lbPair);
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

        const [meteoraPositionPDA] = getMeteoraPositionPDA(vaultPda!, cpi.lbPair, posCounter);
        const [positionPDA] = getPositionPDA(meteoraPositionPDA);
        const [posVaultPDA] = getVaultPDA(meteoraPositionPDA);

        // Vault's deposit ATA (tokens/WSOL come from user vault PDA's ATAs)
        const userVaultDepositAta = deriveATA(depositMint, vaultPda!, depositTokenProgram, true);
        const posVaultTokenX = deriveATA(cpi.tokenXMint, posVaultPDA, cpi.tokenXProgramId, true);
        const posVaultTokenY = deriveATA(cpi.tokenYMint, posVaultPDA, cpi.tokenYProgramId, true);

        // TX 1: setup (bot pays)
        // For native SOL buys: bot wraps SOL from vault PDA to WSOL ATA
        // (on-chain open_position_v2 handles transfer from vault ATA → position vault ATA)
        const isNative = depositMint.equals(NATIVE_MINT);
        const initBinArrayIxs = await ensureBinArraysExist(ctx.connection, cpi.lbPair, pos.minBinId, pos.maxBinId, bot.publicKey);
        const extraSetupIxs = [...initBinArrayIxs];

        const setupTx = await buildSetupTx(
          ctx.connection, bot.publicKey,
          [
            { ata: userVaultDepositAta, owner: vaultPda!, mint: depositMint, tokenProgram: depositTokenProgram },
            { ata: posVaultTokenX, owner: posVaultPDA, mint: cpi.tokenXMint, tokenProgram: cpi.tokenXProgramId },
            { ata: posVaultTokenY, owner: posVaultPDA, mint: cpi.tokenYMint, tokenProgram: cpi.tokenYProgramId },
          ],
          extraSetupIxs
        );

        if (setupTx) {
          await signAndSendLegacy(setupTx, bot, ctx.connection);
        }

        // TX 1.5: create WSOL ATA (idempotent) + wrap SOL → WSOL + sync_native
        // All three in one tx so the ATA always exists when wrap runs.
        // sync_native must be a separate ix from wrapSolInVault — CPI to sync_native
        // within the same instruction causes runtime balance mismatch.
        if (isNative) {
          const { Transaction: Tx, TransactionInstruction: TxIx } = await import('@solana/web3.js');
          const { createAssociatedTokenAccountIdempotentInstruction } = await import('@solana/spl-token');

          const createAtaIx = createAssociatedTokenAccountIdempotentInstruction(
            bot.publicKey, userVaultDepositAta, vaultPda!, NATIVE_MINT, TOKEN_PROGRAM_ID,
          );

          const wrapIx = await ctx.coreProgram.methods
            .wrapSolInVault(positionAmountBN)
            .accounts({
              caller: bot.publicKey,
              config: ctx.configPDA,
              userVault: vaultPda!,
              vaultWsolAta: userVaultDepositAta,
              tokenProgram: TOKEN_PROGRAM_ID,
            })
            .instruction();

          const syncIx = new TxIx({
            programId: TOKEN_PROGRAM_ID,
            keys: [{ pubkey: userVaultDepositAta, isSigner: false, isWritable: true }],
            data: Buffer.from([17]), // SyncNative
          });

          const tx = new Tx().add(createAtaIx, wrapIx, syncIx);
          tx.feePayer = bot.publicKey;
          tx.recentBlockhash = (await ctx.connection.getLatestBlockhash()).blockhash;
          tx.sign(bot);
          const wrapSig = await ctx.connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
          await ctx.connection.confirmTransaction(wrapSig, 'confirmed');
        }

        // TX 2: open position via Anchor program methods (bot is sole signer)
        const slippage = selectedPool.binStep >= 80 ? 15 : 5;

        // Build instruction first, then fix bitmap extension mutability.
        // Meteora's AddLiquidityByStrategy2 requires bitmap_ext as writable,
        // but the IDL marks it read-only (can't be mut when placeholder is used).
        // CPI can't escalate privileges, so the top-level tx must set writable.
        const openIx = await ctx.coreProgram.methods
          .openPositionV2(
            positionAmountBN,
            pos.minBinId,
            pos.maxBinId,
            side === 'Buy' ? { buy: {} } : { sell: {} },
            slippage,
          )
          .accounts({
            bot: bot.publicKey,
            userVault: vaultPda!,
            config: ctx.configPDA,
            lbPair: cpi.lbPair,
            positionCounter: counterPDA,
            meteoraPosition: meteoraPositionPDA,
            binArrayBitmapExt: cpi.binArrayBitmapExt,
            reserveX: cpi.reserveX,
            reserveY: cpi.reserveY,
            position: positionPDA,
            vault: posVaultPDA,
            userVaultDepositAta,
            vaultTokenX: posVaultTokenX,
            vaultTokenY: posVaultTokenY,
            tokenXProgram: cpi.tokenXProgramId,
            tokenYProgram: cpi.tokenYProgramId,
            systemProgram: new PublicKey('11111111111111111111111111111111'),
            binArrayLower: cpi.binArrayLower,
            binArrayUpper: cpi.binArrayUpper,
            eventAuthority: cpi.eventAuthority,
            dlmmProgram: cpi.dlmmProgram,
            tokenXMint: cpi.tokenXMint,
            tokenYMint: cpi.tokenYMint,
          })
          .instruction();

        // Mark bitmap extension writable if it's a real account (not the DLMM program placeholder).
        // Anchor IDL marks it read-only (can't be mut when executable placeholder is used),
        // but the Meteora CPI needs it writable for AddLiquidityByStrategy2.
        // We must set isWritable on the TransactionInstruction keys BEFORE adding to Transaction.
        if (!cpi.binArrayBitmapExt.equals(cpi.dlmmProgram)) {
          let flipped = false;
          for (const key of openIx.keys) {
            if (key.pubkey.equals(cpi.binArrayBitmapExt)) {
              key.isWritable = true;
              flipped = true;
            }
          }
          if (!flipped) {
            console.error(`[buy] WARN: bitmap extension ${cpi.binArrayBitmapExt.toBase58()} not found in openIx.keys (${openIx.keys.length} keys)`);
          }
        }

        const { Transaction: Tx2 } = await import('@solana/web3.js');
        const openTx = new Tx2().add(...(await buildPriorityFeeIxs(ctx.connection)), openIx);
        openTx.feePayer = bot.publicKey;
        openTx.recentBlockhash = (await ctx.connection.getLatestBlockhash()).blockhash;
        openTx.sign(bot);
        // skipPreflight: wrap tx just confirmed but simulation may hit a stale RPC node
        // that doesn't see the WSOL ATA yet. Let on-chain execution be the authority.
        let sig: string;
        try {
          sig = await ctx.connection.sendRawTransaction(openTx.serialize(), { skipPreflight: true });
          await ctx.connection.confirmTransaction(sig, 'confirmed');
        } catch (openErr) {
          // If open failed after wrapping, unwrap WSOL back to SOL to avoid stuck funds
          if (isNative) {
            try {
              const unwrapIx = await ctx.coreProgram.methods
                .unwrapWsolInVault()
                .accounts({
                  caller: bot.publicKey,
                  config: ctx.configPDA,
                  userVault: vaultPda!,
                  vaultWsolAta: userVaultDepositAta,
                  tokenProgram: TOKEN_PROGRAM_ID,
                })
                .instruction();
              const unwrapTx = new Tx2().add(unwrapIx);
              unwrapTx.feePayer = bot.publicKey;
              unwrapTx.recentBlockhash = (await ctx.connection.getLatestBlockhash()).blockhash;
              unwrapTx.sign(bot);
              await ctx.connection.sendRawTransaction(unwrapTx.serialize());
              console.log(`[buy] Unwrapped WSOL after failed open for ${userId}`);
            } catch { /* unwrap is best-effort */ }
          }
          throw openErr;
        }

        ctx.walletService.savePosition({
          positionPda: positionPDA.toBase58(),
          userId,
          vaultPda: vaultPda!.toBase58(),
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
    const depositSymbol = side === 'Sell' ? token : quote;
    const publicText = formatPositionOpened({
      side,
      poolName: `${token}/${quote}`,
      priceLow,
      priceHigh,
      currentPrice,
      amount,
      quoteSymbol: depositSymbol,
      txSig: sigs[0],
      displayMode: selectedPool.displayMode as 'price' | 'mc',
      supply: selectedPool.supply,
      token,
      walletAddress: vaultPda!.toBase58(),
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
            quoteSymbol: depositSymbol,
            txSig: sigs[0],
            displayMode: selectedPool.displayMode as 'price' | 'mc',
            supply: selectedPool.supply,
          }));
        }
      } catch { /* feed channel post is best-effort */ }
    }
  } catch (e: any) {
    // Log full error server-side for debugging (never shown to user)
    console.error(`[buy] Error for ${interaction.user.id}:`, e.message?.slice(0, 500));
    const logs: string[] = e.logs || e.simulationResponse?.logs || [];
    if (logs.length) console.error(`[buy] Simulation logs:`, logs.join('\n'));

    // Extract a safe, user-facing error message (no raw logs or account addresses)
    let errMsg = 'Transaction failed.';
    const anchorError = e.error?.errorCode?.code || e.error?.errorMessage;
    if (anchorError) {
      errMsg = `Transaction failed: ${anchorError}`;
    } else if (e.message?.includes('insufficient')) {
      errMsg = 'Insufficient balance for this transaction.';
    } else if (e.message?.includes('SlippageExceeded') || e.message?.includes('slippage')) {
      errMsg = 'Transaction failed: price moved too fast (slippage). Try again.';
    } else if (e.message) {
      // Strip anything that looks like a base58 address (32+ alphanumeric chars)
      errMsg = e.message.replace(/[1-9A-HJ-NP-Za-km-z]{32,}/g, '***').slice(0, 200);
    }

    if (interaction.deferred) {
      await interaction.editReply(errMsg);
    } else {
      await interaction.reply({ content: errMsg, ephemeral: true });
    }
  }
}
