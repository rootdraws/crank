import type { Client } from 'discord.js';

/**
 * Grant the crank role to a user if they don't already have it. Fire-and-forget:
 * never throws, logs warnings on failure. Called on first successful /buy or /sell
 * to replace the manual role handout in closed beta.
 *
 * No-op unless DISCORD_GUILD_ID + DISCORD_CRANK_ROLE_ID + the GuildMembers intent
 * are all configured (matches the keeper pruner's gating).
 */
export async function grantCrankRoleIfMissing(client: Client, discordUserId: string): Promise<void> {
  const guildId = process.env.DISCORD_GUILD_ID;
  const roleId = process.env.DISCORD_CRANK_ROLE_ID;
  if (!guildId || !roleId) return;

  try {
    const guild = await client.guilds.fetch(guildId);
    const member = await guild.members.fetch(discordUserId);
    if (member.roles.cache.has(roleId)) return;
    await member.roles.add(roleId, 'Auto-grant on first /buy or /sell');
  } catch (e: any) {
    console.warn(`[role-service] grant crank role failed for ${discordUserId}: ${e.message?.slice(0, 120)}`);
  }
}
