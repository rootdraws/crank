module.exports = {
  apps: [{
    name: 'protocol-lp',
    script: './node_modules/.bin/tsx',
    args: 'tools/protocol-lp/index.ts',
    cwd: '/root/crank-money',
    max_memory_restart: '256M',
    restart_delay: 5000,
    max_restarts: 50,
    min_uptime: 10000,
    kill_timeout: 30000,
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
  }]
};
