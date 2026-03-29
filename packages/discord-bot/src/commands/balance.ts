import { ChatInputCommandInteraction } from 'discord.js';
import { Transaction } from '@solana/web3.js';
import { createCloseAccountInstruction, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, KNOWN_TOKENS, NATIVE_MINT, signAndSendLegacy } from '@crankbot/core-sdk';
import { formatBalance } from '../formatter';
import type { BotContext } from '../index';

export async function handleBalance(interaction: ChatInputCommandInteraction, ctx: BotContext): Promise<void> {
  const userId = `discord:${interaction.user.id}`;
  const keypair = ctx.walletService.getOrCreate(userId);
  const pubkey = keypair.publicKey;

  await interaction.deferReply({ ephemeral: true });

  // Auto-unwrap any WSOL before showing balance
  try {
    const wsolAta = getAssociatedTokenAddressSync(NATIVE_MINT, pubkey, false, TOKEN_PROGRAM_ID);
    const wsolInfo = await ctx.connection.getAccountInfo(wsolAta);
    if (wsolInfo && wsolInfo.data.length >= 72) {
      const wsolBalance = Buffer.from(wsolInfo.data).readBigUInt64LE(64);
      if (wsolBalance > 0n || wsolInfo) {
        const tx = new Transaction().add(
          createCloseAccountInstruction(wsolAta, pubkey, pubkey, [], TOKEN_PROGRAM_ID)
        );
        await signAndSendLegacy(tx, keypair, ctx.connection);
      }
    }
  } catch { /* no WSOL ATA or close failed — continue */ }

  const solBalance = await ctx.connection.getBalance(pubkey);
  const tokenAccounts = await ctx.connection.getParsedTokenAccountsByOwner(pubkey, { programId: TOKEN_PROGRAM_ID });
  const token2022Accounts = await ctx.connection.getParsedTokenAccountsByOwner(pubkey, { programId: TOKEN_2022_PROGRAM_ID }).catch(() => ({ value: [] }));

  const tokens: { symbol: string; amount: number }[] = [];
  for (const { account } of [...tokenAccounts.value, ...token2022Accounts.value]) {
    const parsed = account.data.parsed.info;
    const amount = parseFloat(parsed.tokenAmount.uiAmount || '0');
    if (amount <= 0) continue;
    if (parsed.mint === NATIVE_MINT.toBase58()) continue; // already unwrapped above
    const symbol = KNOWN_TOKENS[parsed.mint] || parsed.mint.slice(0, 8) + '...';
    tokens.push({ symbol, amount });
  }

  const text = formatBalance(pubkey.toBase58(), solBalance / 1e9, tokens);
  await interaction.editReply(text);
}
