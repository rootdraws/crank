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
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v': { decimals: 6, program: TOKEN_PROGRAM_ID },
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB': { decimals: 6, program: TOKEN_PROGRAM_ID },
};

export async function handleWithdraw(interaction: ChatInputCommandInteraction, ctx: BotContext): Promise<void> {
  const userId = `discord:${interaction.user.id}`;

  // Enforce withdraw address lock
  const lockedAddr = ctx.walletService.getWithdrawAddress(userId);
  if (!lockedAddr) {
    await interaction.reply({ content: '🦧', ephemeral: true });
    await interaction.followUp({ content: 'Set your withdraw address first.\n`/setwithdraw <your wallet address>`', ephemeral: true });
    return;
  }

  const rangeStr = interaction.options.getString('range', true).trim();
  const parts = rangeStr.split(/\s+/);

  if (parts.length < 2) {
    await interaction.reply({ content: '🦧', ephemeral: true });
    await interaction.followUp({ content: 'Usage: `/withdraw SOL 0.5` or `/withdraw CRANK all`', ephemeral: true });
    return;
  }

  const tokenSymbol = parts[0].toUpperCase();
  const amountStr = parts[1].toLowerCase();
  const destPubkey = new PublicKey(lockedAddr);

  await interaction.deferReply({ ephemeral: true });

  const keypair = ctx.walletService.getOrCreate(userId);
  const user = keypair.publicKey;

  try {
    if (tokenSymbol === 'SOL') {
      let lamports: bigint;

      if (amountStr === 'all') {
        const balance = await ctx.connection.getBalance(user);
        const reserve = 10_000_000n;
        lamports = BigInt(balance) - reserve;
        if (lamports <= 0n) throw new Error('insufficient SOL (need to keep ~0.01 for rent)');
      } else {
        const amount = parseFloat(amountStr);
        if (isNaN(amount) || amount <= 0) {
          await interaction.editReply('Invalid amount.');
          return;
        }
        lamports = BigInt(Math.round(amount * 1e9));
      }

      const tx = new Transaction().add(
        SystemProgram.transfer({ fromPubkey: user, toPubkey: destPubkey, lamports })
      );
      const sig = await signAndSendLegacy(tx, keypair, ctx.connection);
      const solAmount = Number(lamports) / 1e9;
      await interaction.editReply(`Sent ${solAmount} SOL to ${lockedAddr.slice(0, 8)}...${lockedAddr.slice(-4)}\n<${`https://solscan.io/tx/${sig}`}>`);
    } else {
      const mintAddr = Object.entries(KNOWN_TOKENS).find(([, sym]) => sym === tokenSymbol)?.[0];
      if (!mintAddr) {
        await interaction.editReply(`Unknown token "${tokenSymbol}". Use /balance to see your tokens.`);
        return;
      }
      const mint = new PublicKey(mintAddr);
      const meta = TOKEN_META[mintAddr];

      let decimals: number;
      let tokenProgram: PublicKey;
      if (meta) {
        decimals = meta.decimals;
        tokenProgram = meta.program;
      } else {
        const mintAccount = await ctx.connection.getAccountInfo(mint);
        if (!mintAccount) throw new Error('mint account not found');
        tokenProgram = mintAccount.owner.equals(TOKEN_2022_PROGRAM_ID) ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
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
          await interaction.editReply('Invalid amount.');
          return;
        }
        rawAmount = BigInt(Math.round(amount * Math.pow(10, decimals)));
      }

      const destAta = getAssociatedTokenAddressSync(mint, destPubkey, false, tokenProgram);

      const tx = new Transaction();
      tx.add(createAssociatedTokenAccountIdempotentInstruction(user, destAta, destPubkey, mint, tokenProgram));

      const dataLen = 1 + 8 + 1;
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
      await interaction.editReply(`Sent ${humanAmount} ${tokenSymbol} to ${lockedAddr.slice(0, 8)}...${lockedAddr.slice(-4)}\n<${`https://solscan.io/tx/${sig}`}>`);
    }
  } catch (e: any) {
    await interaction.editReply(`Withdraw failed: ${e.message?.slice(0, 100)}`);
  }
}
