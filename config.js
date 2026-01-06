require('dotenv').config();

const config = {
  env: process.env.NODE_ENV || 'development',
  timezone: process.env.TZ || 'America/New_York',
  
  // Rate limiting
  rateLimit: {
    messagesPerMinute: parseInt(process.env.RATE_LIMIT_PER_MINUTE || '20', 10),
    messagesPerHour: parseInt(process.env.RATE_LIMIT_PER_HOUR || '500', 10),
    perRecipientLimit: parseInt(process.env.RATE_LIMIT_PER_RECIPIENT || '10', 10)
  },
  
  // Alert thresholds
  alerts: {
    connectionLostMinutes: parseInt(process.env.ALERT_CONNECTION_LOST_MIN || '5', 10),
    highErrorRate: parseInt(process.env.ALERT_ERROR_RATE || '10', 10),
    memoryThreshold: parseFloat(process.env.ALERT_MEMORY_THRESHOLD || '0.8')
  },
  
  // Backup settings
  backup: {
    enabled: process.env.BACKUP_ENABLED !== 'false',
    schedule: process.env.BACKUP_SCHEDULE || '0 2 * * *', // Daily at 2 AM
    retentionDays: parseInt(process.env.BACKUP_RETENTION_DAYS || '7', 10),
    directory: process.env.BACKUP_DIRECTORY || './backups'
  },
  
  // Logging
  logging: {
    level: process.env.LOG_LEVEL || 'info',
    directory: process.env.LOG_DIRECTORY || './logs',
    maxFiles: process.env.LOG_MAX_FILES || '14d'
  },
  
  // Health check
  health: {
    checkInterval: parseInt(process.env.HEALTH_CHECK_INTERVAL || '60000', 10), // 1 minute
    httpPort: parseInt(process.env.HEALTH_HTTP_PORT || '0', 10) // 0 = disabled
  },
  
  // Scheduled messaging - load from schedules.json file
  schedules: (() => {
    try {
      const fs = require('fs');
      const path = require('path');
      const schedulesFile = path.join(__dirname, 'schedules.json');
      if (fs.existsSync(schedulesFile)) {
        const data = fs.readFileSync(schedulesFile, 'utf8');
        return JSON.parse(data);
      }
    } catch (error) {
      console.error('Error loading schedules.json:', error.message);
    }
    // Fallback to env variable if file doesn't exist
    return process.env.SCHEDULES ? JSON.parse(process.env.SCHEDULES) : [];
  })(),
  
  // Browser/Puppeteer
  puppeteer: {
    headless: process.env.PUPPETEER_HEADLESS !== 'false',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--disable-gpu'
    ]
  },
  
  // Reconnection settings
  reconnection: {
    maxRetries: parseInt(process.env.MAX_RECONNECT_RETRIES || '10', 10),
    initialDelay: parseInt(process.env.RECONNECT_INITIAL_DELAY || '5000', 10),
    maxDelay: parseInt(process.env.RECONNECT_MAX_DELAY || '60000', 10),
    backoffMultiplier: parseFloat(process.env.RECONNECT_BACKOFF || '1.5')
  }
};

module.exports = config;

