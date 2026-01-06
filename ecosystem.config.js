module.exports = {
  apps: [{
    name: 'whatsapp-bot',
    script: 'index.js',
    instances: 1,
    exec_mode: 'fork',
    autorestart: true,
    watch: false,
    max_memory_restart: '500M',
    max_restarts: 10,
    min_uptime: '10s',
    restart_delay: 4000,
    ignore_watch: [
      'node_modules',
      '.wwebjs_auth',
      '.wwebjs_cache',
      'logs',
      'backups',
      '*.log'
    ],
    env: {
      NODE_ENV: 'production'
    },
    error_file: './logs/pm2-error.log',
    out_file: './logs/pm2-out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    merge_logs: true
  }]
};

