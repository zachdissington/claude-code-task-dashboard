// PM2 process definition for the task-dashboard.
// Launch: pm2 start ecosystem.config.cjs   (or scripts/restart.ps1)
module.exports = {
  apps: [
    {
      name: "task-dashboard",
      script: "dist/index.js",
      cwd: __dirname,
      output: "logs/dashboard.log",
      error: "logs/dashboard-error.log",
      autorestart: true,
      max_restarts: 10,
      // dist/ is not committed — if it is missing the process crash-loops with
      // ERR_MODULE_NOT_FOUND. Always `npm run build` first (restart.ps1 does).
    },
  ],
};
