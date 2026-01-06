const winston = require('winston');
const DailyRotateFile = require('winston-daily-rotate-file');
const path = require('path');
const fs = require('fs');
const config = require('./config');

// Ensure log directory exists
const logDir = config.logging.directory;
if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir, { recursive: true });
}

// Define log format
const logFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.errors({ stack: true }),
  winston.format.splat(),
  winston.format.json()
);

// Console format (more readable)
const consoleFormat = winston.format.combine(
  winston.format.colorize(),
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.printf(({ timestamp, level, message, ...meta }) => {
    let msg = `${timestamp} [${level}]: ${message}`;
    if (Object.keys(meta).length > 0) {
      msg += ` ${JSON.stringify(meta)}`;
    }
    return msg;
  })
);

// Create transports
const transports = [
  // Console transport
  new winston.transports.Console({
    format: consoleFormat,
    level: config.env === 'production' ? 'info' : 'debug'
  }),
  
  // Daily rotate file for all logs
  new DailyRotateFile({
    filename: path.join(logDir, 'application-%DATE%.log'),
    datePattern: 'YYYY-MM-DD',
    maxFiles: config.logging.maxFiles,
    format: logFormat,
    level: config.logging.level
  }),
  
  // Daily rotate file for errors only
  new DailyRotateFile({
    filename: path.join(logDir, 'error-%DATE%.log'),
    datePattern: 'YYYY-MM-DD',
    maxFiles: config.logging.maxFiles,
    format: logFormat,
    level: 'error'
  })
];

// Create logger instance
const logger = winston.createLogger({
  level: config.logging.level,
  format: logFormat,
  transports,
  exceptionHandlers: [
    new DailyRotateFile({
      filename: path.join(logDir, 'exceptions-%DATE%.log'),
      datePattern: 'YYYY-MM-DD',
      maxFiles: config.logging.maxFiles
    })
  ],
  rejectionHandlers: [
    new DailyRotateFile({
      filename: path.join(logDir, 'rejections-%DATE%.log'),
      datePattern: 'YYYY-MM-DD',
      maxFiles: config.logging.maxFiles
    })
  ]
});

// Helper methods for different log categories
logger.auth = (message, meta = {}) => {
  logger.info(`[AUTH] ${message}`, { category: 'authentication', ...meta });
};

logger.message = (direction, message, meta = {}) => {
  logger.info(`[MESSAGE ${direction}] ${message}`, { category: 'message', direction, ...meta });
};

logger.connection = (message, meta = {}) => {
  logger.info(`[CONNECTION] ${message}`, { category: 'connection', ...meta });
};

logger.health = (message, meta = {}) => {
  logger.debug(`[HEALTH] ${message}`, { category: 'health', ...meta });
};

logger.schedule = (message, meta = {}) => {
  logger.info(`[SCHEDULE] ${message}`, { category: 'schedule', ...meta });
};

module.exports = logger;

