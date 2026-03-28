import { ChatInputCommandInteraction } from 'discord.js';
import { PublicKey, SystemProgram, Transaction } from '@solana/web3.js';
import { getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction } from '@solana/spl-token';
import { signAndSendLegacy, NATIVE_MINT, TOKEN_PROGRAM_ID, KNOWN_TOKENS } from '@crankbot/core-sdk';
import type { BotContext } from '../index';

export async function handleWithdraw(interaction: ChatInputCommandInteraction, ctx: BotContext): Promise<void> {
  const userId = `discord:${interaction.user.id}`;
  const tokenSymbol = interaction.options.getString('token', true).toUpperCase();
  const amountStr = interaction.options.getString('amount', true);
  const destAddr = interaction.options.getString('address', true);

  const amount = parseFloat(amountStr);
  if (isNaN(amount) || amount <= 0) {
    await interaction.reply({ content: '🦧 invalid amount.', ephemeral: true });
    return;
  }

  let destPubkey: PublicKey;
  try {
    destPubkey = new PublicKey(destAddr);
  } catch {
    await interaction.reply({ content: '🦧 invalid destination address.', ephemeral: true });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  const keypair = ctx.walletService.getOrCreate(userId);
  const user = keypair.publicKey;

  try {
    if (tokenSymbol === 'SOL') {
      const lamports = BigInt(Math.round(amount * 1e9));
      const tx = new Transaction().add(
        SystemProgram.transfer({ fromPubkey: user, toPubkey: destPubkey, lamports })
      );
      const sig = await signAndSendLegacy(tx, keypair, ctx.connection);
      await interaction.editReply(`Sent ${amount} SOL to ${destAddr.slice(0, 8)}...\nhttps://solscan.io/tx/${sig}`);
    } else {
      const mintAddr = Object.entries(KNOWN_TOKENS).find(([, sym]) => sym === tokenSymbol)?.[0];
      if (!mintAddr) {
        await interaction.editReply(`🦧 unknown token "${tokenSymbol}". Use the mint address or a known symbol.`);
        return;
      }
      const mint = new PublicKey(mintAddr);
      const decimals = tokenSymbol === 'USDC' || tokenSymbol === 'USDT' ? 6 : 9;
      const rawAmount = BigInt(Math.round(amount * Math.pow(10, decimals)));

      const sourceAta = getAssociatedTokenAddressSync(mint, user);
      const destAta = getAssociatedTokenAddressSync(mint, destPubkey);

      const tx = new Transaction();
      tx.add(createAssociatedTokenAccountIdempotentInstruction(user, destAta, destPubkey, mint));

      const transferData = Buffer.alloc(9);
      transferData[0] = 3;
      transferData.writeBigUInt64LE(rawAmount, 1);
      tx.add({
        programId: TOKEN_PROGRAM_ID,
        keys: [
          { pubkey: sourceAta, isSigner: false, isWritable: true },
          { pubkey: destAta, isSigner: false, isWritable: true },
          { pubkey: user, isSigner: true, isWritable: false },
        ],
        data: transferData,
      });

      const sig = await signAndSendLegacy(tx, keypair, ctx.connection);
      await interaction.editReply(`Sent ${amount} ${tokenSymbol} to ${destAddr.slice(0, 8)}...\nhttps://solscan.io/tx/${sig}`);
    }
  } catch (e: any) {
    await interaction.editReply(`🦧 withdraw failed: ${e.message?.slice(0, 100)}`);
  }
}
