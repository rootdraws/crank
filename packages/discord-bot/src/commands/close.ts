import { ChatInputCommandInteraction, TextChannel } from 'discord.js';
import { PublicKey, VersionedTransaction, TransactionMessage, Transaction, TransactionInstruction, SystemProgram } from '@solana/web3.js';
import { NATIVE_MINT, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction } from '@solana/spl-token';
import { BIN_FARM_PROGRAM_ID, getPositionSettlePDA } from '@crankbot/core-sdk';
import { address } from '@solana/kit';
import {
  getUserCloseInstructionAsync,
} from '@crankbot/core-sdk/generated/bin-farm/index.js';
import {
  getConfigPDA, getPositionPDA, getVaultPDA,
  resolveMeteoraCPIAccounts, parseLbPairFull, deriveATA,
  buildSetupTx, buildPriorityFeeIxs, kitIxToWeb3, asSigner, confirmAndCheck,
  signAndSend, signAndSendLegacy, binToPrice, fetchDexScreenerPrice,
  SPL_MEMO_PROGRAM_ID, METEORA_DLMM_PROGRAM_ID, loadPoolRegistry,
} from '@crankbot/core-sdk';
import { formatPositionClosed, formatFeedClosed, formatError, formatPositionsList, formatTreasuryProposalName, PositionDisplayData } from '../formatter';
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
  // Use the resolved Config.fee_dest (HopperVault post-routing). On-chain handler
  // reverts InvalidFeeDest (6045) if this doesn't match what Config.fee_dest is.
  const feeDest = ctx.feeDest;

  const vaultTokenX = deriveATA(cpi.tokenXMint, posVaultPDA, cpi.tokenXProgramId, true);
  const vaultTokenY = deriveATA(cpi.tokenYMint, posVaultPDA, cpi.tokenYProgramId, true);
  // user_token_x/y = vault PDA's ATAs (tokens go to vault, user withdraws later)
  const userTokenX = deriveATA(cpi.tokenXMint, vaultPda, cpi.tokenXProgramId, true);
  const userTokenY = deriveATA(cpi.tokenYMint, vaultPda, cpi.tokenYProgramId, true);
  const feeDestTokenX = deriveATA(cpi.tokenXMint, feeDest, cpi.tokenXProgramId, true);
  const feeDestTokenY = deriveATA(cpi.tokenYMint, feeDest, cpi.tokenYProgramId, true);

  const setupTx = await buildSetupTx(
    ctx.connection, bot.publicKey,
    [
      { ata: userTokenX, owner: vaultPda, mint: cpi.tokenXMint, tokenProgram: cpi.tokenXProgramId },
      { ata: userTokenY, owner: vaultPda, mint: cpi.tokenYMint, tokenProgram: cpi.tokenYProgramId },
      { ata: feeDestTokenX, owner: feeDest, mint: cpi.tokenXMint, tokenProgram: cpi.tokenXProgramId },
      { ata: feeDestTokenY, owner: feeDest, mint: cpi.tokenYMint, tokenProgram: cpi.tokenYProgramId },
    ]
  );

  if (setupTx) {
    await signAndSendLegacy(setupTx, bot, ctx.connection);
  }

  // Hand-craft the user_close ix. Anchor 0.30 represents optional accounts in
  // the "compact" form: None optionals are OMITTED from the keys array entirely.
  // system_program comes right after the last present account.
  const USER_CLOSE_DISC = Buffer.from([126, 78, 180, 205, 96, 242, 20, 2]);
  const [positionSettlePDA] = getPositionSettlePDA(meteoraPosition);
  const positionSettleAcc = await ctx.connection.getAccountInfo(positionSettlePDA);
  const hasSettle = positionSettleAcc !== null;

  const baseKeys = [
    { pubkey: bot.publicKey,           isSigner: true,  isWritable: true  },
    { pubkey: configPDA,               isSigner: false, isWritable: true  },
    { pubkey: vaultPda,                isSigner: false, isWritable: true  },
    { pubkey: positionPDA,             isSigner: false, isWritable: true  },
    { pubkey: posVaultPDA,             isSigner: false, isWritable: true  },
    { pubkey: meteoraPosition,         isSigner: false, isWritable: true  },
    { pubkey: cpi.lbPair,              isSigner: false, isWritable: true  },
    { pubkey: cpi.binArrayBitmapExt,   isSigner: false,
      isWritable: !cpi.binArrayBitmapExt.equals(METEORA_DLMM_PROGRAM_ID) },
    { pubkey: cpi.binArrayLower,       isSigner: false, isWritable: true  },
    { pubkey: cpi.binArrayUpper,       isSigner: false, isWritable: true  },
    { pubkey: cpi.reserveX,            isSigner: false, isWritable: true  },
    { pubkey: cpi.reserveY,            isSigner: false, isWritable: true  },
    { pubkey: cpi.tokenXMint,          isSigner: false, isWritable: false },
    { pubkey: cpi.tokenYMint,          isSigner: false, isWritable: false },
    { pubkey: cpi.eventAuthority,      isSigner: false, isWritable: false },
    { pubkey: cpi.dlmmProgram,         isSigner: false, isWritable: false },
    { pubkey: vaultTokenX,             isSigner: false, isWritable: true  },
    { pubkey: vaultTokenY,             isSigner: false, isWritable: true  },
    { pubkey: userTokenX,              isSigner: false, isWritable: true  },
    { pubkey: userTokenY,              isSigner: false, isWritable: true  },
    { pubkey: feeDest,                 isSigner: false, isWritable: false },
    { pubkey: feeDestTokenX,           isSigner: false, isWritable: true  },
    { pubkey: feeDestTokenY,           isSigner: false, isWritable: true  },
    { pubkey: cpi.tokenXProgramId,     isSigner: false, isWritable: false },
    { pubkey: cpi.tokenYProgramId,     isSigner: false, isWritable: false },
    { pubkey: SPL_MEMO_PROGRAM_ID,     isSigner: false, isWritable: false },
  ];
  // Optional accounts: only include if present (Anchor compact form).
  // When position_settle exists, include all three; otherwise omit all three.
  if (hasSettle) {
    throw new Error('Path A user_close on a Path B-matched position requires proposerOutputAta resolution — not implemented in close.ts');
  }
  const closeIx = new TransactionInstruction({
    programId: BIN_FARM_PROGRAM_ID,
    keys: [
      ...baseKeys,
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: USER_CLOSE_DISC,
  });

  // Always re-create the vault's X/Y ATAs idempotently in the SAME tx as
  // user_close. The previous /close in a /close all loop runs unwrap_wsol_in_vault
  // which closes the WSOL ATA. The setupTx-and-loop pattern races RPC propagation:
  // getMultipleAccountsInfo can return the pre-unwrap state, so buildSetupTx
  // skips the create. Inline + idempotent removes the race entirely.
  const closeTx = new Transaction().add(
    ...(await buildPriorityFeeIxs(ctx.connection, 1_400_000)),
    createAssociatedTokenAccountIdempotentInstruction(
      bot.publicKey, userTokenX, vaultPda, cpi.tokenXMint, cpi.tokenXProgramId,
    ),
    createAssociatedTokenAccountIdempotentInstruction(
      bot.publicKey, userTokenY, vaultPda, cpi.tokenYMint, cpi.tokenYProgramId,
    ),
    closeIx,
  );
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

  // Path B: if this user position has a matched treasury position, enqueue
  // a separate treasury close proposal that pays the proposer's 20% cut and
  // closes the treasury's matched position. Runs async — does not block the
  // user's close response. The user's close (above) is final regardless.
  if (ctx.treasury) {
    const treasuryMatch = ctx.walletService.getTreasuryPositionByUserPosition(position.position_pda);
    if (treasuryMatch && treasuryMatch.status === 'open') {
      void enqueueTreasuryClose(ctx, treasuryMatch).catch((e: unknown) =>
        console.error('[close] treasury-match close failed:', e instanceof Error ? e.message : e),
      );
    }
  }

  return sig;
}

async function enqueueTreasuryClose(
  ctx: BotContext,
  match: import('@crankbot/core-sdk').TreasuryPositionRecord,
): Promise<void> {
  const treasury = ctx.treasury;
  if (!treasury) return;

  const bot = ctx.botKeypair;
  const treasuryMeteoraPosition = new PublicKey(match.meteora_position);
  const lbPair = new PublicKey(match.lb_pair);
  const treasuryVault = new PublicKey(match.treasury_vault);
  const proposerWallet = new PublicKey(match.proposer_wallet);
  const outputMint = new PublicKey(match.output_mint);

  const cpi = await resolveMeteoraCPIAccounts(
    ctx.connection, lbPair, match.min_bin_id, match.max_bin_id,
  );

  const [configPDA] = getConfigPDA();
  const [treasuryPositionPDA] = getPositionPDA(treasuryMeteoraPosition);
  const [treasuryPosVaultPDA] = getVaultPDA(treasuryMeteoraPosition);
  // Resolved Config.fee_dest (HopperVault). Mismatch reverts InvalidFeeDest (6045).
  const feeDest = ctx.feeDest;

  // Treasury per-position vault ATAs (sources of residue transfers)
  const tVaultTokenX = deriveATA(cpi.tokenXMint, treasuryPosVaultPDA, cpi.tokenXProgramId, true);
  const tVaultTokenY = deriveATA(cpi.tokenYMint, treasuryPosVaultPDA, cpi.tokenYProgramId, true);
  // NTP-direct ATAs (Realms-visible residue destinations on close)
  const ntp = treasury.nativeTreasuryPda;
  const ntpTokenXAta = deriveATA(cpi.tokenXMint, ntp, cpi.tokenXProgramId, true);
  const feeDestTokenX = deriveATA(cpi.tokenXMint, feeDest, cpi.tokenXProgramId, true);
  const feeDestTokenY = deriveATA(cpi.tokenYMint, feeDest, cpi.tokenYProgramId, true);

  // Pre-create destinations if missing (NTP CRANK ATA + fee_dest ATAs).
  // WSOL Y residue → close ATA → NTP lamports (no Y ATA needed at NTP).
  const setupTx = await buildSetupTx(
    ctx.connection, bot.publicKey,
    [
      { ata: ntpTokenXAta, owner: ntp, mint: cpi.tokenXMint, tokenProgram: cpi.tokenXProgramId },
      { ata: feeDestTokenX, owner: feeDest, mint: cpi.tokenXMint, tokenProgram: cpi.tokenXProgramId },
      { ata: feeDestTokenY, owner: feeDest, mint: cpi.tokenYMint, tokenProgram: cpi.tokenYProgramId },
    ],
  );
  if (setupTx) await signAndSendLegacy(setupTx, bot, ctx.connection);

  // Proposer's destination ATA for the output mint
  const outputTokenProgram = outputMint.equals(cpi.tokenXMint) ? cpi.tokenXProgramId : cpi.tokenYProgramId;
  const proposerOutputAta = getAssociatedTokenAddressSync(
    outputMint, proposerWallet, false, outputTokenProgram,
  );
  const proposerAtaInfo = await ctx.connection.getAccountInfo(proposerOutputAta);
  if (!proposerAtaInfo) {
    const { createAssociatedTokenAccountIdempotentInstruction } = await import('@solana/spl-token');
    const createIx = createAssociatedTokenAccountIdempotentInstruction(
      bot.publicKey, proposerOutputAta, proposerWallet, outputMint, outputTokenProgram,
    );
    const tx = new Transaction().add(createIx);
    tx.feePayer = bot.publicKey;
    tx.recentBlockhash = (await ctx.connection.getLatestBlockhash()).blockhash;
    tx.sign(bot);
    await ctx.connection.sendRawTransaction(tx.serialize(), { skipPreflight: true });
  }

  // Per-position vault's ATA for the output mint (source of payout transfer)
  const positionVaultOutputAta = outputMint.equals(cpi.tokenXMint) ? tVaultTokenX : tVaultTokenY;

  // Resolve tax_reserve_output_ata if Config.tax_routing is enabled.
  // Config v2 layout offset: tax_reserve = 295 (see treasury-match.ts comment).
  let taxReserveOutputAta: PublicKey | null = null;
  try {
    const configInfo = await ctx.connection.getAccountInfo(configPDA);
    if (configInfo) {
      const TAX_RESERVE_OFFSET = 295;
      if (configInfo.data.length >= TAX_RESERVE_OFFSET + 32) {
        const taxReserveBytes = configInfo.data.subarray(TAX_RESERVE_OFFSET, TAX_RESERVE_OFFSET + 32);
        const taxReserve = new PublicKey(taxReserveBytes);
        if (!taxReserve.equals(new PublicKey('11111111111111111111111111111111'))) {
          taxReserveOutputAta = getAssociatedTokenAddressSync(
            outputMint, taxReserve, true, outputTokenProgram,
          );
          // Pre-create if missing
          const taxAtaInfo = await ctx.connection.getAccountInfo(taxReserveOutputAta);
          if (!taxAtaInfo) {
            const { createAssociatedTokenAccountIdempotentInstruction } = await import('@solana/spl-token');
            const ix2 = createAssociatedTokenAccountIdempotentInstruction(
              bot.publicKey, taxReserveOutputAta, taxReserve, outputMint, outputTokenProgram,
            );
            const tx2 = new Transaction().add(ix2);
            tx2.feePayer = bot.publicKey;
            tx2.recentBlockhash = (await ctx.connection.getLatestBlockhash()).blockhash;
            tx2.sign(bot);
            await ctx.connection.sendRawTransaction(tx2.serialize(), { skipPreflight: true });
          }
        }
      }
    }
  } catch (e) {
    console.warn('[close] failed to resolve tax_reserve_output_ata:', (e as Error).message);
  }

  let proposerHandle: string | undefined;
  try {
    const snowflake = match.proposer_user_id.replace(/^discord:/, '');
    const u = await ctx.client.users.fetch(snowflake);
    proposerHandle = u.username;
  } catch (e) {
    console.warn('[close] failed to resolve proposer handle:', (e as Error).message);
  }

  // Build mcap-styled proposal name from the match record.
  let proposalName: string | undefined;
  try {
    const pools = loadPoolRegistry();
    const poolConfig = pools.find(p => p.address === match.lb_pair);
    const binStep = poolConfig?.binStep ?? 10;
    const decimalsX = poolConfig?.decimalsX ?? 9;
    const decimalsY = poolConfig?.decimalsY ?? 6;
    const rawLow = binToPrice(match.min_bin_id, binStep, decimalsX, decimalsY);
    const rawHigh = binToPrice(match.max_bin_id, binStep, decimalsX, decimalsY);
    let qUsd = 1.0;
    if (poolConfig?.displayMode === 'mc' && poolConfig.mintY) {
      const isStable = ['USDC', 'USDT'].includes((poolConfig.quoteToken ?? '').toUpperCase());
      if (!isStable) {
        const qData = await fetchDexScreenerPrice(poolConfig.mintY).catch(() => null);
        qUsd = qData?.priceUsd ?? 1.0;
      }
    }
    proposalName = formatTreasuryProposalName({
      kind: 'close',
      side: match.side,
      priceLow: rawLow * qUsd,
      priceHigh: rawHigh * qUsd,
      amount: 0,
      quoteSymbol: poolConfig?.quoteToken ?? 'SOL',
      displayMode: poolConfig?.displayMode as 'price' | 'mc' | undefined,
      supply: poolConfig?.supply,
      proposerHandle,
    });
  } catch (e) {
    console.warn('[close] failed to build rich proposal name:', (e as Error).message);
  }

  void import('../../../../bot/treasury-match').then(m =>
    m.enqueueCloseMatch({
      ctx: {
        connection: ctx.connection,
        coreProgram: ctx.coreProgram as unknown as { methods: Record<string, (...args: unknown[]) => unknown> },
        configPDA: ctx.configPDA,
        botKeypair: bot,
        treasury: ctx.treasury,
      },
      treasuryPositionPda: new PublicKey(match.treasury_position_pda),
      treasuryMeteoraPosition,
      lbPair,
      positionVaultOutputAta,
      proposerOutputAta,
      outputMint,
      outputTokenProgram,
      taxReserveOutputAta,
      cpi: {
        binArrayBitmapExt: cpi.binArrayBitmapExt,
        binArrayLower: cpi.binArrayLower,
        binArrayUpper: cpi.binArrayUpper,
        reserveX: cpi.reserveX,
        reserveY: cpi.reserveY,
        tokenXMint: cpi.tokenXMint,
        tokenYMint: cpi.tokenYMint,
        eventAuthority: cpi.eventAuthority,
        dlmmProgram: cpi.dlmmProgram,
        tokenXProgramId: cpi.tokenXProgramId,
        tokenYProgramId: cpi.tokenYProgramId,
      },
      vaultTokenX: tVaultTokenX,
      vaultTokenY: tVaultTokenY,
      ntpTokenXAta,
      ntpSolAccount: ntp,
      feeDest,
      feeDestTokenX,
      feeDestTokenY,
      proposerUserId: match.proposer_user_id,
      proposerWallet,
      proposerHandle,
      proposalName,
      userPositionPda: match.user_position_pda,
    }),
  );
}
