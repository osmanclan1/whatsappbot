const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const config = require('./config');
const logger = require('./logger');
const rateLimiter = require('./rateLimiter');
const scheduler = require('./scheduler');
const healthMonitor = require('./health');
const alertSystem = require('./alerts');
const backupManager = require('./backup');
const browserManager = require('./browserManager');

// Create a new client instance
const client = new Client({
    authStrategy: new LocalAuth({
        dataPath: './.wwebjs_auth'
    }),
    puppeteer: {
        headless: config.puppeteer.headless,
        args: config.puppeteer.args
    }
});

// Initialize managers
const health = new HealthMonitor(client);
const alerts = new AlertSystem(health);
const backup = new BackupManager();
const browserMgr = new BrowserManager(client);

// Keep-alive interval
let keepAliveInterval = null;

// Generate QR code for authentication
client.on('qr', (qr) => {
    console.clear();
    logger.auth('QR code generated, scan with WhatsApp mobile app');
    console.log('Scan this QR code with your WhatsApp mobile app:\n');
    qrcode.generate(qr, { small: true });
    console.log('\n');
});

// Client is ready
client.on('ready', async () => {
    logger.connection('WhatsApp client is ready!');
    logger.info('You can now send and receive messages.');
    
    // Reset restart attempts on successful connection
    browserMgr.restartAttempts = 0;
    
    // Start health monitoring
    health.start();
    
    // Start alert system
    alerts.start();
    
    // Start scheduled backups
    backup.startScheduledBackups();
    
    // Initialize scheduler
    const messageScheduler = new scheduler(sendMessage);
    messageScheduler.start();
    
    // Store scheduler for cleanup
    global.messageScheduler = messageScheduler;
    logger.info('Scheduler initialized');
    
    // Start keep-alive mechanism
    startKeepAlive();
    
    logger.info('All systems initialized and ready');
});

// Authentication successful
client.on('authenticated', () => {
    logger.auth('Authentication successful');
});

// Authentication failure
client.on('auth_failure', (msg) => {
    logger.auth('Authentication failed', { reason: msg });
    alerts.triggerAuthFailure(msg);
});

// Client disconnected
client.on('disconnected', async (reason) => {
    logger.connection('Client disconnected', { reason });
    
    // Stop keep-alive
    stopKeepAlive();
    
    // Handle different disconnect reasons
    if (reason === 'NAVIGATION') {
        logger.warn('Session might have expired, attempting to reconnect');
        setTimeout(() => {
            client.initialize();
        }, 5000);
    } else if (reason === 'CONFLICT') {
        logger.warn('Multiple sessions detected, reconnecting');
        setTimeout(() => {
            client.initialize();
        }, 5000);
    } else if (reason === 'LOGOUT') {
        logger.warn('Logged out from phone, QR code scan required');
        alerts.triggerSessionExpired();
    }
});

// Handle incoming messages
client.on('message', async (message) => {
    try {
        const contact = await message.getContact();
        const chat = await message.getChat();
        
        health.recordReceived();
        
        logger.message('RECEIVED', `From: ${contact.pushname || contact.number}`, {
            from: contact.number,
            chat: chat.name || 'Individual',
            message: message.body,
            timestamp: message.timestamp
        });
        
        // Example: Auto-reply (uncomment to enable)
        // if (message.body.toLowerCase() === 'hello') {
        //     await message.reply('Hi! How can I help you?');
        // }
    } catch (error) {
        logger.error('Error handling incoming message', { error: error.message });
        health.recordError();
    }
});

// Handle message creation (sent messages)
client.on('message_create', async (message) => {
    // Only log messages we sent
    if (message.fromMe) {
        try {
            const contact = await message.getContact();
            health.recordSent();
            
            logger.message('SENT', `To: ${contact.pushname || contact.number}`, {
                to: contact.number,
                message: message.body
            });
        } catch (error) {
            logger.error('Error logging sent message', { error: error.message });
        }
    }
});

// Error handling
client.on('error', (error) => {
    logger.error('Client error', {
        error: error.message,
        stack: error.stack
    });
    health.recordError();
});

// Function to send a message with rate limiting
async function sendMessage(number, message) {
    try {
        // Validate input
        if (!number || !message) {
            throw new Error('Number and message are required');
        }
        
        // Format: number@c.us (country code without +)
        const chatId = number.includes('@c.us') ? number : `${number}@c.us`;
        
        // Check rate limiter
        const rateCheck = rateLimiter.canSend(chatId);
        
        if (!rateCheck.allowed) {
            const error = new Error(`Rate limit exceeded: ${rateCheck.reason}`);
            error.rateLimited = true;
            error.waitTime = rateCheck.waitTime;
            alerts.triggerRateLimitExceeded({
                recipient: chatId,
                reason: rateCheck.reason,
                waitTime: rateCheck.waitTime
            });
            throw error;
        }
        
        // Send message
        const sentMessage = await client.sendMessage(chatId, message);
        
        // Record in rate limiter
        rateLimiter.recordSent(chatId);
        
        // Record in health monitor
        health.recordSent();
        
        logger.info('Message sent successfully', { to: chatId });
        return sentMessage;
    } catch (error) {
        health.recordError();
        
        if (error.rateLimited) {
            logger.warn('Message rate limited', {
                to: number,
                reason: error.reason,
                waitTime: error.waitTime
            });
        } else {
            logger.error('Error sending message', {
                to: number,
                error: error.message,
                stack: error.stack
            });
        }
        throw error;
    }
}

// Keep-alive mechanism
function startKeepAlive() {
    if (keepAliveInterval) {
        clearInterval(keepAliveInterval);
    }
    
    keepAliveInterval = setInterval(async () => {
        try {
            const state = await client.getState();
            if (state !== 'CONNECTED') {
                logger.warn('Connection lost, reconnecting...', { state });
                client.initialize();
            }
        } catch (error) {
            logger.error('Keep-alive check failed', { error: error.message });
            // Attempt to reinitialize
            try {
                client.initialize();
            } catch (err) {
                logger.error('Failed to reinitialize after keep-alive failure', {
                    error: err.message
                });
            }
        }
    }, 5 * 60 * 1000); // Check every 5 minutes
}

function stopKeepAlive() {
    if (keepAliveInterval) {
        clearInterval(keepAliveInterval);
        keepAliveInterval = null;
    }
}

// Initialize browser manager
browserMgr.initialize();

// Initialize the client
logger.info('Initializing WhatsApp client...');
client.initialize();

// Handle graceful shutdown
async function gracefulShutdown(signal) {
    logger.info(`Received ${signal}, shutting down gracefully...`);
    
    // Stop keep-alive
    stopKeepAlive();
    
    // Stop scheduler
    if (global.messageScheduler) {
        global.messageScheduler.stop();
    }
    
    // Stop health monitoring
    health.stop();
    
    // Destroy client
    try {
        await client.destroy();
        logger.info('Client destroyed successfully');
    } catch (error) {
        logger.error('Error destroying client', { error: error.message });
    }
    
    process.exit(0);
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

// Handle uncaught errors
process.on('uncaughtException', (error) => {
    logger.error('Uncaught exception', {
        error: error.message,
        stack: error.stack
    });
    // Don't exit, let PM2 handle restart
});

process.on('unhandledRejection', (reason, promise) => {
    logger.error('Unhandled rejection', {
        reason: reason?.message || reason,
        promise
    });
});

// Export sendMessage function for use in other modules
module.exports = { sendMessage, client };
