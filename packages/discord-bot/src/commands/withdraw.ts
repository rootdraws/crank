import { ChatInputCommandInteraction } from 'discord.js';
import { PublicKey, SystemProgram, Transaction } from '@solana/web3.js';
import { getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction } from '@solana/spl-token';
import {
  signAndSendLegacy,
  NATIVE_MINT, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID,
  KNOWN_TOKENS, CRANK_MINT, BANK_MINT, PEGGED_MINT,
} from '@crankbot/core-sdk';
import type { BotContext } from '../index';

// Token decimals and program for each known mint
const TOKEN_META: Record<string, { decimals: number; program: PublicKey }> = {
  [CRANK_MINT.toBase58()]:  { decimals: 6, program: TOKEN_2022_PROGRAM_ID },
  [BANK_MINT.toBase58()]:   { decimals: 6, program: TOKEN_PROGRAM_ID },
  [PEGGED_MINT.toBase58()]: { decimals: 9, program: TOKEN_PROGRAM_ID },
  // USDC
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v': { decimals: 6, program: TOKEN_PROGRAM_ID },
  // USDT
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB': { decimals: 6, program: TOKEN_PROGRAM_ID },
};

export async function handleWithdraw(interaction: ChatInputCommandInteraction, ctx: BotContext): Promise<void> {
  const userId = `discord:${interaction.user.id}`;
  const tokenSymbol = interaction.options.getString('token', true).toUpperCase();
  const amountStr = interaction.options.getString('amount', true).trim().toLowerCase();
  const destAddr = interaction.options.getString('address', true);

  let destPubkey: PublicKey;
  try {
    destPubkey = new PublicKey(destAddr);
  } catch {
    await interaction.reply({ content: 'Invalid destination address.', ephemeral: true });
    return;
  }

  // Enforce withdraw address lock
  const lockedAddr = ctx.walletService.getWithdrawAddress(userId);
  if (!lockedAddr) {
    await interaction.reply({ content: 'Set your withdraw address first with /setwithdraw.', ephemeral: true });
    return;
  }
  if (destPubkey.toBase58() !== lockedAddr) {
    await interaction.reply({
      content: `Withdrawals locked to \`${lockedAddr.slice(0, 8)}...${lockedAddr.slice(-4)}\`. Use that address.`,
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  const keypair = ctx.walletService.getOrCreate(userId);
  const user = keypair.publicKey;

  try {
    if (tokenSymbol === 'SOL') {
      let lamports: bigint;

      if (amountStr === 'all') {
        const balance = await ctx.connection.getBalance(user);
        // Reserve 0.01 SOL for rent/fees
        const reserve = 10_000_000n;
        lamports = BigInt(balance) - reserve;
        if (lamports <= 0n) throw new Error('insufficient SOL (need to keep ~0.01 for rent)');
      } else {
        const amount = parseFloat(amountStr);
        if (isNaN(amount) || amount <= 0) {
          await interaction.editReply('🦧 invalid amount.');
          return;
        }
        lamports = BigInt(Math.round(amount * 1e9));
      }

      const tx = new Transaction().add(
        SystemProgram.transfer({ fromPubkey: user, toPubkey: destPubkey, lamports })
      );
      const sig = await signAndSendLegacy(tx, keypair, ctx.connection);
      const solAmount = Number(lamports) / 1e9;
      await interaction.editReply(`Sent ${solAmount} SOL to ${destAddr.slice(0, 8)}...\nhttps://solscan.io/tx/${sig}`);
    } else {
      // Resolve symbol to mint
      const mintAddr = Object.entries(KNOWN_TOKENS).find(([, sym]) => sym === tokenSymbol)?.[0];
      if (!mintAddr) {
        await interaction.editReply(`🦧 unknown token "${tokenSymbol}". Use /balance to see your tokens.`);
        return;
      }
      const mint = new PublicKey(mintAddr);
      const meta = TOKEN_META[mintAddr];

      // If we don't have hardcoded meta, read from chain
      let decimals: number;
      let tokenProgram: PublicKey;
      if (meta) {
        decimals = meta.decimals;
        tokenProgram = meta.program;
      } else {
        const mintAccount = await ctx.connection.getAccountInfo(mint);
        if (!mintAccount) throw new Error('mint account not found');
        tokenProgram = mintAccount.owner.equals(TOKEN_2022_PROGRAM_ID) ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
        // decimals at byte offset 44 in mint layout
        decimals = Buffer.from(mintAccount.data).readUInt8(44);
      }

      const sourceAta = getAssociatedTokenAddressSync(mint, user, false, tokenProgram);

      let rawAmount: bigint;
      if (amountStr === 'all') {
        const ataAccount = await ctx.connection.getAccountInfo(sourceAta);
        if (!ataAccount) throw new Error(`no ${tokenSymbol} balance`);
        rawAmount = Buffer.from(ataAccount.data).readBigUInt64LE(64);
        if (rawAmount === 0n) throw new Error(`${tokenSymbol} balance is 0`);
      } else {
        const amount = parseFloat(amountStr);
        if (isNaN(amount) || amount <= 0) {
          await interaction.editReply('🦧 invalid amount.');
          return;
        }
        rawAmount = BigInt(Math.round(amount * Math.pow(10, decimals)));
      }

      const destAta = getAssociatedTokenAddressSync(mint, destPubkey, false, tokenProgram);

      const tx = new Transaction();

      // Create dest ATA if needed
      tx.add(createAssociatedTokenAccountIdempotentInstruction(user, destAta, destPubkey, mint, tokenProgram));

      // Use transfer_checked for Token-2022 compatibility
      const dataLen = 1 + 8 + 1; // instruction variant + amount + decimals
      const transferData = Buffer.alloc(dataLen);
      transferData[0] = 12; // TransferChecked variant
      transferData.writeBigUInt64LE(rawAmount, 1);
      transferData.writeUInt8(decimals, 9);

      tx.add({
        programId: tokenProgram,
        keys: [
          { pubkey: sourceAta, isSigner: false, isWritable: true },
          { pubkey: mint, isSigner: false, isWritable: false },
          { pubkey: destAta, isSigner: false, isWritable: true },
          { pubkey: user, isSigner: true, isWritable: false },
        ],
        data: transferData,
      });

      const sig = await signAndSendLegacy(tx, keypair, ctx.connection);
      const humanAmount = Number(rawAmount) / Math.pow(10, decimals);
      await interaction.editReply(`Sent ${humanAmount} ${tokenSymbol} to ${destAddr.slice(0, 8)}...\nhttps://solscan.io/tx/${sig}`);
    }
  } catch (e: any) {
    await interaction.editReply(`🦧 withdraw failed: ${e.message?.slice(0, 100)}`);
  }
}
