module.exports = {
  apps: [{
    name: 'crank-harvester',
    // Use tsx directly instead of `npx tsx` so PM2 signals the Node process,
    // not the npx wrapper. SIGTERM propagation is unreliable through npx.
    script: './node_modules/.bin/tsx',
    args: 'bot/anchor-harvest-bot.ts',
    cwd: process.env.HOME ? `${process.env.HOME}/crank-money` : '/home/crankbot/crank-money',
    env_file: process.env.HOME ? `${process.env.HOME}/crank-money/bot/.env` : '/home/crankbot/crank-money/bot/.env',
    max_memory_restart: '512M',
    restart_delay: 5000,
    max_restarts: 50,
    min_uptime: 10000,       // process must run 10s+ to count as a "successful" start
    kill_timeout: 10000,     // 10s for graceful shutdown (in-flight Solana txs)
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    out_file: process.env.HOME ? `${process.env.HOME}/.pm2/logs/crank-harvester-out.log` : '/home/crankbot/.pm2/logs/crank-harvester-out.log',
    error_file: process.env.HOME ? `${process.env.HOME}/.pm2/logs/crank-harvester-error.log` : '/home/crankbot/.pm2/logs/crank-harvester-error.log',
  }]
};
