import { ChatInputCommandInteraction } from 'discord.js';
import { PublicKey, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import {
  MERKLE_DISTRIBUTOR_PROGRAM_ID, PEGGED_MINT, TOKEN_PROGRAM_ID,
  getDistributorPDA, getClaimStatusPDA, deriveATA, formatAmount,
  buildSetupTx, buildPriorityFeeIxs, signAndSend, signAndSendLegacy, withUserLock,
} from '@crankbot/core-sdk';
import { formatError } from '../formatter';
import type { BotContext } from '../index';

// claim discriminator from merkle-distributor IDL
const CLAIM_DISC = Buffer.from([62, 198, 214, 193, 213, 159, 108, 210]);

// Distributor account layout offsets (after 8-byte discriminator):
// authority: 32, pending_authority: 32, mint: 32, vault: 32,
// current_epoch: 8, merkle_root: 32, total_amount_funded: 8,
// total_amount_claimed: 8, paused: 1, bump: 1, ipfs_cid: 4+len
const DIST_VAULT_OFFSET = 8 + 32 + 32 + 32;       // offset to vault pubkey
const DIST_PAUSED_OFFSET = DIST_VAULT_OFFSET + 32 + 8 + 32 + 8 + 8; // offset to paused
const DIST_CID_OFFSET = DIST_PAUSED_OFFSET + 1 + 1; // offset to ipfs_cid (borsh string: 4-byte len + data)

interface TreeLeaf {
  index: number;
  wallet: string;
  cumulative_amount: string;
  proof: number[][];
}

export async function handleClaim(interaction: ChatInputCommandInteraction, ctx: BotContext): Promise<void> {
  const userId = `discord:${interaction.user.id}`;

  await interaction.deferReply({ ephemeral: false });

  const lockKey = `${userId}:claim`;

  try {
    const sig = await withUserLock(lockKey, async () => {
      const keypair = ctx.walletService.getOrCreate(userId);
      const user = keypair.publicKey;

      const [distributorPDA] = getDistributorPDA();

      // Read distributor account to get vault and IPFS CID
      const distAccount = await ctx.connection.getAccountInfo(distributorPDA);
      if (!distAccount) throw new Error('Distributor not initialized');

      const distData = Buffer.from(distAccount.data);

      const paused = distData.readUInt8(DIST_PAUSED_OFFSET);
      if (paused) throw new Error('Distributor is paused');

      const vault = new PublicKey(distData.subarray(DIST_VAULT_OFFSET, DIST_VAULT_OFFSET + 32));

      // Read IPFS CID (borsh string: 4-byte LE length prefix + utf8 data)
      const cidLen = distData.readUInt32LE(DIST_CID_OFFSET);
      if (cidLen === 0 || cidLen > 100) throw new Error('No epoch tree published yet');
      const ipfsCid = distData.subarray(DIST_CID_OFFSET + 4, DIST_CID_OFFSET + 4 + cidLen).toString('utf-8');

      // Fetch tree from IPFS and find user's leaf
      const leaf = await fetchUserLeaf(ipfsCid, user.toBase58());
      if (!leaf) throw new Error('No rewards found for your wallet in the current epoch tree');

      const cumulativeAmount = BigInt(leaf.cumulative_amount);
      const index = BigInt(leaf.index);
      const proof: Buffer[] = leaf.proof.map((p: number[]) => Buffer.from(p));

      // Check if there's anything new to claim
      const [claimStatusPDA] = getClaimStatusPDA(distributorPDA, user);
      let alreadyClaimed = 0n;
      try {
        const csAccount = await ctx.connection.getAccountInfo(claimStatusPDA);
        if (csAccount && csAccount.data.length >= 16) {
          // ClaimStatus: discriminator(8) + cumulative_claimed(u64)
          alreadyClaimed = Buffer.from(csAccount.data).readBigUInt64LE(8);
        }
      } catch { /* first claim */ }

      if (cumulativeAmount <= alreadyClaimed) {
        throw new Error('Nothing to claim — you are fully caught up');
      }

      const claimable = cumulativeAmount - alreadyClaimed;

      // $PEGGED is SPL Token (not Token-2022)
      const peggedTokenProgram = TOKEN_PROGRAM_ID;
      const claimantAta = deriveATA(PEGGED_MINT, user, peggedTokenProgram, false);

      // Ensure user's $PEGGED ATA exists
      const setupTx = await buildSetupTx(
        ctx.connection, user,
        [{ ata: claimantAta, owner: user, mint: PEGGED_MINT, tokenProgram: peggedTokenProgram }],
        []
      );
      if (setupTx) {
        await signAndSendLegacy(setupTx, keypair, ctx.connection);
      }

      // Build claim instruction
      // args: index (u64), cumulative_amount (u64), proof (Vec<[u8; 32]>)
      const proofVecLen = proof.length;
      const dataLen = 8 + 8 + 8 + 4 + (proofVecLen * 32);
      const data = Buffer.alloc(dataLen);
      let offset = 0;

      CLAIM_DISC.copy(data, offset); offset += 8;
      data.writeBigUInt64LE(index, offset); offset += 8;
      data.writeBigUInt64LE(cumulativeAmount, offset); offset += 8;
      data.writeUInt32LE(proofVecLen, offset); offset += 4;
      for (const p of proof) {
        p.copy(data, offset);
        offset += 32;
      }

      const ix = new TransactionInstruction({
        programId: MERKLE_DISTRIBUTOR_PROGRAM_ID,
        keys: [
          { pubkey: user, isSigner: true, isWritable: true },           // payer
          { pubkey: distributorPDA, isSigner: false, isWritable: true }, // distributor
          { pubkey: PEGGED_MINT, isSigner: false, isWritable: false },  // mint
          { pubkey: vault, isSigner: false, isWritable: true },         // vault
          { pubkey: user, isSigner: false, isWritable: false },         // claimant
          { pubkey: claimantAta, isSigner: false, isWritable: true },   // claimant_ata
          { pubkey: claimStatusPDA, isSigner: false, isWritable: true },// claim_status
          { pubkey: peggedTokenProgram, isSigner: false, isWritable: false }, // token_program
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, // system_program
        ],
        data,
      });

      const priorityIxs = await buildPriorityFeeIxs(ctx.connection);
      const { blockhash, lastValidBlockHeight } = await ctx.connection.getLatestBlockhash();
      const msg = new TransactionMessage({
        payerKey: user,
        recentBlockhash: blockhash,
        instructions: [...priorityIxs, ix],
      }).compileToV0Message();
      const vtx = new VersionedTransaction(msg);

      const txSig = await signAndSend(vtx, keypair, ctx.connection, blockhash, lastValidBlockHeight);

      return { sig: txSig, claimable };
    });

    const humanAmount = formatAmount(sig.claimable, 9); // $PEGGED has 9 decimals
    await interaction.editReply(
      `Claimed ${humanAmount} $PEGGED\n` +
      `tx: \`${sig.sig}\``
    );
  } catch (e: any) {
    const errMsg = e.message?.slice(0, 200) || 'unknown error';
    if (interaction.deferred) {
      await interaction.editReply(formatError(errMsg));
    } else {
      await interaction.reply({ content: formatError(errMsg), ephemeral: true });
    }
  }
}

/**
 * Fetch the Merkle tree JSON from IPFS and find the leaf for a given wallet.
 * Tree format: { leaves: [{ index, wallet, cumulative_amount, proof }, ...] }
 */
async function fetchUserLeaf(ipfsCid: string, wallet: string): Promise<TreeLeaf | null> {
  // Try multiple IPFS gateways
  const gateways = [
    `https://gateway.pinata.cloud/ipfs/${ipfsCid}`,
    `https://ipfs.io/ipfs/${ipfsCid}`,
    `https://cloudflare-ipfs.com/ipfs/${ipfsCid}`,
  ];

  let tree: any = null;
  for (const url of gateways) {
    try {
      const resp = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      if (resp.ok) {
        tree = await resp.json();
        break;
      }
    } catch { continue; }
  }

  if (!tree || !tree.leaves) return null;

  return tree.leaves.find((l: TreeLeaf) => l.wallet === wallet) ?? null;
}
