module.exports = {
  apps: [{
    name: 'crank-harvester',
    script: 'npx',
    args: 'tsx bot/anchor-harvest-bot.ts',
    cwd: '/root/crank-money',
    env_file: '/root/crank-money/bot/.env',
    max_memory_restart: '512M',
    restart_delay: 5000,
    max_restarts: 50,
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    out_file: '/root/.pm2/logs/crank-harvester-out.log',
    error_file: '/root/.pm2/logs/crank-harvester-error.log',
  }]
};
