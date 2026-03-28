# Discord Bot Wiring — Integration Pattern

From `crankclank/bot/anchor-harvest-bot.ts` lines 684-706.
This block goes in the main `bot/anchor-harvest-bot.ts` `run()` method,
after executor event wiring, before safety poll setup.

```typescript
// Discord bot — starts if DISCORD_TOKEN is set
if (process.env.DISCORD_TOKEN) {
  try {
    const { DiscordBot } = await import('../packages/discord-bot/src/index');
    const discordBot = new DiscordBot({
      executor: this.executor,
      subscriber: this.subscriber,
      connection: this.connection,
      coreProgram: this.coreProgram,
      coreProgramId: CORE_PROGRAM_ID,
    });
    this.executor.on('harvestExecuted', (data: any) => {
      discordBot.notifier.onHarvestExecuted(data);
    });
    this.executor.on('positionClosed', (data: any) => {
      discordBot.notifier.onPositionClosed(data);
    });
    await discordBot.start();
    logger.info('[discord] Bot started');
  } catch (e: any) {
    logger.warn(`[discord] Failed to start: ${e.message}`);
  }
}
```

## What this does

- Conditionally starts the Discord bot when `DISCORD_TOKEN` env var is set
- Passes the harvester's executor + subscriber + connection + program to the bot
- Hooks executor harvest/close events into the Discord notifier (DMs + feed channel)
- Graceful fallback — if Discord fails to start, the harvester keeps running

## Required env vars

```
DISCORD_TOKEN=<bot token from discord.com/developers>
DISCORD_CLIENT_ID=<application client ID>
DISCORD_FEED_CHANNEL_ID=<channel ID for public activity feed>
WALLET_ENCRYPTION_KEY=<32 bytes hex, generate: openssl rand -hex 32>
DB_PATH=./data/crankbot.json
```
