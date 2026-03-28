import { ChatInputCommandInteraction, TextChannel } from 'discord.js';
import { PublicKey, VersionedTransaction, TransactionMessage } from '@solana/web3.js';
import { address } from '@solana/kit';
import {
  getOpenPositionV2InstructionAsync,
  Side,
} from '../../../../src/generated/bin-farm/index.js';
import {
  getConfigPDA, getPositionCounterPDA, getMeteoraPosiitonPDA,
  getPositionPDA, getVaultPDA, getRoverAuthorityPDA,
  resolveMeteoraCPIAccounts, parseLbPairFull, deriveATA,
  buildSetupTx, buildWrapSolIxs, ensureBinArraysExist,
  buildPriorityFeeIxs, kitIxToWeb3, asSigner,
  priceToBin, binToPrice, formatPrice,
  signAndSend, signAndSendLegacy, withUserLock,
  NATIVE_MINT, MAX_POSITION_WIDTH,
} from '@crankbot/core-sdk';
import { formatPositionOpened, formatPositionEphemeral, formatFeedOpened, formatError } from '../formatter';
import { parseRange } from '../parse-range';
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

  const parsed = parseRange(rangeStr);
  if (!parsed) {
    const example = side === 'Buy'
      ? '/buy SOL 84 to 74 1000 USDC'
      : '/sell SOL 98 to 115 10 SOL';
    await interaction.reply({ content: formatError('could not parse that.', `e.g. ${example}`), ephemeral: true });
    return;
  }

  const { token, priceA, priceB, amount, quote } = parsed;

  // TODO: resolve token+quote to a pool address via curator.json
  // For now, require pool address directly or check approved pools
  const poolAddress = resolvePool(token, quote, ctx);
  if (!poolAddress) {
    await interaction.reply({
      content: formatError(`no pool found for ${token}/${quote}.`, '/pools to see covered pairs'),
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply({ ephemeral: false });

  const lockKey = `${userId}:${poolAddress}`;

  try {
    const result = await withUserLock(lockKey, async () => {
      const keypair = ctx.walletService.getOrCreate(userId);
      const user = keypair.publicKey;

      const pool = await parseLbPairFull(ctx.connection, poolAddress);
      const tokenXDecimals = 9; // TODO: fetch from mint
      const tokenYDecimals = 6;
      const currentPrice = binToPrice(pool.activeId, pool.binStep, tokenXDecimals, tokenYDecimals);

      // Order-agnostic: sort prices
      const priceLow = Math.min(priceA, priceB);
      const priceHigh = Math.max(priceA, priceB);

      // Validate side vs current price
      if (side === 'Buy' && priceHigh >= currentPrice) {
        throw new Error(formatError(
          `range crosses current price ($${formatPrice(currentPrice)}).`,
          `buy below: /buy ${token} ${formatPrice(priceHigh)} to ${formatPrice(priceLow)} ${amount} ${quote}`
        ));
      }
      if (side === 'Sell' && priceLow <= currentPrice) {
        throw new Error(formatError(
          `range crosses current price ($${formatPrice(currentPrice)}).`,
          `sell above: /sell ${token} ${formatPrice(priceLow)} to ${formatPrice(priceHigh)} ${amount} ${quote}`
        ));
      }

      const minBinId = priceToBin(priceLow, pool.binStep, tokenXDecimals, tokenYDecimals, true);
      const maxBinId = priceToBin(priceHigh, pool.binStep, tokenXDecimals, tokenYDecimals, false);

      if (maxBinId - minBinId + 1 > MAX_POSITION_WIDTH) {
        throw new Error(formatError(
          `range too wide (${maxBinId - minBinId + 1} bins, max ${MAX_POSITION_WIDTH}).`,
          'narrow your range or use a wider bin-step pool'
        ));
      }

      const cpi = await resolveMeteoraCPIAccounts(ctx.connection, poolAddress, minBinId, maxBinId);

      const depositMint = side === 'Buy' ? cpi.tokenYMint : cpi.tokenXMint;
      const depositTokenProgram = side === 'Buy' ? cpi.tokenYProgramId : cpi.tokenXProgramId;
      const depositDecimals = side === 'Buy' ? tokenYDecimals : tokenXDecimals;
      const depositAmount = BigInt(Math.round(amount * Math.pow(10, depositDecimals)));

      // Read position counter (critical: uses current count before increment)
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

      const [meteoraPositionPDA] = getMeteoraPosiitonPDA(user, cpi.lbPair, posCounter);
      const [configPDA] = getConfigPDA();
      const [positionPDA] = getPositionPDA(meteoraPositionPDA);
      const [vaultPDA] = getVaultPDA(meteoraPositionPDA);

      const isNative = depositMint.equals(NATIVE_MINT);
      const userTokenAccount = deriveATA(depositMint, user, depositTokenProgram, false);
      const vaultTokenX = deriveATA(cpi.tokenXMint, vaultPDA, cpi.tokenXProgramId, true);
      const vaultTokenY = deriveATA(cpi.tokenYMint, vaultPDA, cpi.tokenYProgramId, true);

      // TX 1: setup — ATAs + bin arrays + SOL wrap
      const initBinArrayIxs = await ensureBinArraysExist(ctx.connection, cpi.lbPair, minBinId, maxBinId, user);
      const extraSetupIxs = [...initBinArrayIxs];
      if (isNative) extraSetupIxs.push(...buildWrapSolIxs(user, userTokenAccount, depositAmount));

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

      // TX 2: execute — openPositionV2 via Codama
      const slippage = pool.binStep >= 80 ? 15 : 5;
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
        amount: BigInt(depositAmount.toString()),
        minBinId,
        maxBinId,
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

      // Save to DB
      ctx.walletService.savePosition({
        positionPda: positionPDA.toBase58(),
        userId,
        walletPubkey: user.toBase58(),
        lbPair: cpi.lbPair.toBase58(),
        meteoraPosition: meteoraPositionPDA.toBase58(),
        side,
        minBinId,
        maxBinId,
        initialAmount: depositAmount,
      });

      return { sig, positionPDA, priceLow, priceHigh, currentPrice };
    });

    // Public reply
    const publicText = formatPositionOpened({
      side,
      poolName: `${token}/${quote}`,
      priceLow: result.priceLow,
      priceHigh: result.priceHigh,
      currentPrice: result.currentPrice,
      amount,
      quoteSymbol: quote,
      txSig: result.sig,
    });
    await interaction.editReply(publicText);

    // Ephemeral follow-up
    await interaction.followUp({
      content: formatPositionEphemeral(result.positionPDA.toBase58(), result.sig),
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
            priceLow: result.priceLow,
            priceHigh: result.priceHigh,
            amount,
            quoteSymbol: quote,
            txSig: result.sig,
          }));
        }
      } catch { /* feed channel post is best-effort */ }
    }
  } catch (e: any) {
    const errMsg = e.message?.slice(0, 200) || 'unknown error';
    if (interaction.deferred) {
      await interaction.editReply(errMsg);
    } else {
      await interaction.reply({ content: errMsg, ephemeral: true });
    }
  }
}

function resolvePool(token: string, quote: string, ctx: BotContext): string | null {
  // Load curator.json and find matching pool
  try {
    const fs = require('fs');
    const path = require('path');
    const configPath = process.env.POOL_CONFIG_PATH || path.join(__dirname, '..', '..', '..', '..', 'curator.json');
    if (!fs.existsSync(configPath)) return null;
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    const pools = raw.pools || [];
    const match = pools.find((p: any) =>
      p.buyToken.toUpperCase() === token.toUpperCase() &&
      p.quoteToken.toUpperCase() === quote.toUpperCase() &&
      p.address !== 'REPLACE_WITH_REAL_ADDRESS'
    );
    return match?.address || null;
  } catch {
    return null;
  }
}
