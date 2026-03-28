import { ChatInputCommandInteraction } from 'discord.js';
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, KNOWN_TOKENS } from '@crankbot/core-sdk';
import { formatBalance } from '../formatter';
import type { BotContext } from '../index';

export async function handleBalance(interaction: ChatInputCommandInteraction, ctx: BotContext): Promise<void> {
  const userId = `discord:${interaction.user.id}`;
  const keypair = ctx.walletService.getOrCreate(userId);
  const pubkey = keypair.publicKey;

  await interaction.deferReply({ ephemeral: true });

  const solBalance = await ctx.connection.getBalance(pubkey);
  const tokenAccounts = await ctx.connection.getParsedTokenAccountsByOwner(pubkey, { programId: TOKEN_PROGRAM_ID });
  const token2022Accounts = await ctx.connection.getParsedTokenAccountsByOwner(pubkey, { programId: TOKEN_2022_PROGRAM_ID }).catch(() => ({ value: [] }));

  const tokens: { symbol: string; amount: number }[] = [];
  for (const { account } of [...tokenAccounts.value, ...token2022Accounts.value]) {
    const parsed = account.data.parsed.info;
    const amount = parseFloat(parsed.tokenAmount.uiAmount || '0');
    if (amount <= 0) continue;
    const symbol = KNOWN_TOKENS[parsed.mint] || parsed.mint.slice(0, 8) + '...';
    tokens.push({ symbol, amount });
  }

  const text = formatBalance(pubkey.toBase58(), solBalance / 1e9, tokens);
  await interaction.editReply(text);
}
