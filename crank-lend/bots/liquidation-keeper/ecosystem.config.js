// PM2 ecosystem config for deployment on DigitalOcean
module.exports = {
  apps: [
    {
      name: "crank-lend-keeper",
      script: "dist/index.js",
      cwd: __dirname,
      env: {
        NODE_ENV: "production",
      },
      restart_delay: 5000,
      max_restarts: 50,
      autorestart: true,
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
    },
  ],
};
