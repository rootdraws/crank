import { ChatInputCommandInteraction } from 'discord.js';
import { PublicKey, SystemProgram, Transaction } from '@solana/web3.js';
import { getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction } from '@solana/spl-token';
import {
  signAndSendLegacy,
  NATIVE_MINT, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID,
  KNOWN_TOKENS, CRANK_MINT, BANK_MINT,
} from '@crankbot/core-sdk';
import { tryLockDepositor } from '../deposit-detect';
import type { BotContext } from '../index';

const TOKEN_META: Record<string, { decimals: number; program: PublicKey }> = {
  [CRANK_MINT.toBase58()]:  { decimals: 6, program: TOKEN_2022_PROGRAM_ID },
  [BANK_MINT.toBase58()]:   { decimals: 6, program: TOKEN_PROGRAM_ID },
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v': { decimals: 6, program: TOKEN_PROGRAM_ID },
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB': { decimals: 6, program: TOKEN_PROGRAM_ID },
};

export async function handleWithdraw(interaction: ChatInputCommandInteraction, ctx: BotContext): Promise<void> {
  const userId = `discord:${interaction.user.id}`;

  const lockedAddr = await tryLockDepositor(ctx.connection, ctx.walletService, userId);
  if (!lockedAddr) {
    await interaction.reply({
      content: 'No withdraw address detected.\nDeposit SOL from your personal wallet first — that wallet becomes your withdraw address.',
      ephemeral: true,
    });
    return;
  }

  const input = interaction.options.getString('amount')?.trim() ?? '';
  const destPubkey = new PublicKey(lockedAddr);
  const destShort = `${lockedAddr.slice(0, 4)}...${lockedAddr.slice(-4)}`;
  const keypair = ctx.walletService.getOrCreate(userId);
  const user = keypair.publicKey;

  // Bare /withdraw — show balances + withdraw wallet + example
  if (!input) {
    await interaction.deferReply({ ephemeral: true });

    const solBalance = await ctx.connection.getBalance(user);
    const tokenAccounts = await ctx.connection.getParsedTokenAccountsByOwner(user, { programId: TOKEN_PROGRAM_ID });
    const token2022Accounts = await ctx.connection.getParsedTokenAccountsByOwner(user, { programId: TOKEN_2022_PROGRAM_ID }).catch(() => ({ value: [] }));

    let balanceLines = `SOL: ${(solBalance / 1e9).toFixed(4)}`;
    for (const { account } of [...tokenAccounts.value, ...token2022Accounts.value]) {
      const parsed = account.data.parsed.info;
      const amount = parseFloat(parsed.tokenAmount.uiAmount || '0');
      if (amount <= 0) continue;
      if (parsed.mint === NATIVE_MINT.toBase58()) continue;
      const symbol = KNOWN_TOKENS[parsed.mint] || parsed.mint.slice(0, 6) + '...';
      balanceLines += `\n${symbol}: ${amount.toFixed(4)}`;
    }

    await interaction.editReply(
      `Withdraw to: [${lockedAddr}](https://solscan.io/account/${lockedAddr})\n\n` +
      `${balanceLines}\n\n` +
      `\`/withdraw SOL .5\` · \`/withdraw CRANK all\``
    );
    return;
  }

  // /withdraw SOL .5 — execute
  const parts = input.split(/\s+/);
  if (parts.length < 2) {
    await interaction.reply({ content: '`/withdraw SOL .5` or `/withdraw CRANK all`', ephemeral: true });
    return;
  }

  const tokenSymbol = parts[0].toUpperCase();
  const amountStr = parts[1].toLowerCase();

  await interaction.deferReply({ ephemeral: true });

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
      await interaction.editReply(`Sent ${Number(lamports) / 1e9} SOL to ${destShort}\n<https://solscan.io/tx/${sig}>`);
    } else {
      const mintAddr = Object.entries(KNOWN_TOKENS).find(([, sym]) => sym === tokenSymbol)?.[0];
      if (!mintAddr) {
        await interaction.editReply(`Unknown token "${tokenSymbol}". Use /withdraw to see your tokens.`);
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

      const transferData = Buffer.alloc(10);
      transferData[0] = 12;
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
      await interaction.editReply(`Sent ${humanAmount} ${tokenSymbol} to ${destShort}\n<https://solscan.io/tx/${sig}>`);
    }
  } catch (e: any) {
    await interaction.editReply(`Withdraw failed: ${e.message?.slice(0, 100)}`);
  }
}
