import { ChatInputCommandInteraction } from 'discord.js';
import { Transaction } from '@solana/web3.js';
import { createCloseAccountInstruction, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, KNOWN_TOKENS, NATIVE_MINT, signAndSendLegacy } from '@crankbot/core-sdk';
import { formatBalance } from '../formatter';
import type { BotContext } from '../index';

export async function handleBalance(interaction: ChatInputCommandInteraction, ctx: BotContext): Promise<void> {
  const userId = `discord:${interaction.user.id}`;
  const vaultPda = ctx.walletService.getVaultPda(userId);
  if (!vaultPda) {
    await interaction.reply({ content: 'No vault found. Run `/start wallet:<your-address>` first.', ephemeral: true });
    return;
  }
  const pubkey = vaultPda;

  await interaction.deferReply({ ephemeral: true });

  const withdrawAddr = ctx.walletService.getWithdrawAddress(userId);

  // PDA vault: no WSOL auto-unwrap on balance check. Vault holds native SOL
  // directly; WSOL in vault ATAs is from harvests and is unwrapped on
  // /withdraw SOL via unwrap_wsol_in_vault.
  const solBalance = await ctx.connection.getBalance(pubkey);
  const tokenAccounts = await ctx.connection.getParsedTokenAccountsByOwner(pubkey, { programId: TOKEN_PROGRAM_ID });
  const token2022Accounts = await ctx.connection.getParsedTokenAccountsByOwner(pubkey, { programId: TOKEN_2022_PROGRAM_ID }).catch(() => ({ value: [] }));

  const tokens: { symbol: string; amount: number }[] = [];
  for (const { account } of [...tokenAccounts.value, ...token2022Accounts.value]) {
    const parsed = account.data.parsed.info;
    const amount = parseFloat(parsed.tokenAmount.uiAmount || '0');
    if (amount <= 0) continue;
    if (parsed.mint === NATIVE_MINT.toBase58()) continue; // WSOL is transient — auto-unwrapped to native SOL by harvest-executor / /withdraw SOL
    const symbol = KNOWN_TOKENS[parsed.mint] || parsed.mint.slice(0, 8) + '...';
    tokens.push({ symbol, amount });
  }

  const text = formatBalance(pubkey.toBase58(), solBalance / 1e9, tokens, withdrawAddr);
  await interaction.editReply(text);
}
