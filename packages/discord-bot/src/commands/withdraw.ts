import { ChatInputCommandInteraction } from 'discord.js';
import { PublicKey, SystemProgram, Transaction } from '@solana/web3.js';
import { BN } from '@coral-xyz/anchor';
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

  const vaultPda = ctx.walletService.getVaultPda(userId);
  if (!vaultPda) {
    await interaction.reply({
      content: 'No vault found. Run `/start wallet:<your-solana-address>` first.',
      ephemeral: true,
    });
    return;
  }

  const ownerWallet = ctx.walletService.getOwnerWallet(userId);
  if (!ownerWallet) {
    await interaction.reply({ content: 'Vault has no owner wallet set.', ephemeral: true });
    return;
  }

  const input = interaction.options.getString('amount')?.trim() ?? '';
  const destPubkey = ownerWallet;
  const lockedAddr = ownerWallet.toBase58();
  const destShort = `${lockedAddr.slice(0, 4)}...${lockedAddr.slice(-4)}`;
  const user = vaultPda; // vault PDA is the "account" that holds funds

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
    const bot = ctx.botKeypair;

    if (tokenSymbol === 'SOL') {
      let lamports: bigint;

      if (amountStr === 'all') {
        const balance = await ctx.connection.getBalance(user);
        // Reserve rent-exempt minimum for vault PDA (~0.001 SOL)
        const reserve = 1_000_000n;
        lamports = BigInt(balance) - reserve;
        if (lamports <= 0n) throw new Error('insufficient SOL in vault');
      } else {
        const amount = parseFloat(amountStr);
        if (isNaN(amount) || amount <= 0) {
          await interaction.editReply('Invalid amount.');
          return;
        }
        lamports = BigInt(Math.round(amount * 1e9));
      }

      // Unwrap any WSOL in vault first (from harvests/claims) so it's available as native SOL
      try {
        const wsolAta = getAssociatedTokenAddressSync(NATIVE_MINT, vaultPda, true, TOKEN_PROGRAM_ID);
        const wsolInfo = await ctx.connection.getAccountInfo(wsolAta);
        if (wsolInfo) {
          await ctx.coreProgram.methods
            .unwrapWsolInVault()
            .accounts({ caller: bot.publicKey, config: ctx.configPDA, userVault: vaultPda, vaultWsolAta: wsolAta, tokenProgram: TOKEN_PROGRAM_ID })
            .signers([bot])
            .rpc();
        }
      } catch { /* ATA might be empty or already closed */ }

      // Call on-chain withdraw_sol (bot signs, program enforces destination = vault.owner)
      const sig = await ctx.coreProgram.methods
        .withdrawSol(new BN(lamports.toString()))
        .accounts({
          caller: bot.publicKey,
          config: ctx.configPDA,
          userVault: vaultPda,
          owner: destPubkey,
        })
        .signers([bot])
        .rpc();

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

      const sourceAta = getAssociatedTokenAddressSync(mint, user, true, tokenProgram);
      const destAta = getAssociatedTokenAddressSync(mint, destPubkey, false, tokenProgram);

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

      // Create destination ATA (bot pays)
      const setupTx = new Transaction().add(
        createAssociatedTokenAccountIdempotentInstruction(bot.publicKey, destAta, destPubkey, mint, tokenProgram)
      );
      await signAndSendLegacy(setupTx, bot, ctx.connection);

      // Call on-chain withdraw_token (bot signs, program transfers via vault PDA)
      const sig = await ctx.coreProgram.methods
        .withdrawToken(new BN(rawAmount.toString()))
        .accounts({
          caller: bot.publicKey,
          config: ctx.configPDA,
          userVault: vaultPda,
          tokenMint: mint,
          vaultTokenAccount: sourceAta,
          ownerTokenAccount: destAta,
          tokenProgram,
        })
        .signers([bot])
        .rpc();

      const humanAmount = Number(rawAmount) / Math.pow(10, decimals);
      await interaction.editReply(`Sent ${humanAmount} ${tokenSymbol} to ${destShort}\n<https://solscan.io/tx/${sig}>`);
    }
  } catch (e: any) {
    await interaction.editReply(`Withdraw failed: ${e.message?.slice(0, 100)}`);
  }
}
