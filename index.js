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

// Check for send-multiple mode
const isSendMultipleMode = process.argv.includes('--send-multiple');

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
const health = new healthMonitor(client);
const alerts = new alertSystem(health);
const backup = new backupManager();
const browserMgr = new browserManager(client);

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
    
    // If in send-multiple mode, run that and exit
    if (isSendMultipleMode) {
        console.log('\n📱 Running in multi-recipient send mode...\n');
        await runSendMultiple();
        await gracefulShutdown('SEND_MULTIPLE_COMPLETE');
        return;
    }
    
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

// Multi-recipient sending function
async function runSendMultiple() {
    const readline = require('readline');
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });

    console.log('📱 WhatsApp Multi-Recipient Message Sender\n');
    console.log('Enter phone numbers (one per line).');
    console.log('Format: countrycode+number (e.g., 15551234567 or +1-555-123-4567)');
    console.log('Type "done" when finished entering numbers.\n');

    const numbers = [];

    return new Promise((resolve) => {
        function collectNumbers() {
            rl.question('Phone number (or "done" to finish): ', (input) => {
                if (input.toLowerCase() === 'done') {
                    if (numbers.length === 0) {
                        console.log('❌ No numbers entered. Exiting.');
                        rl.close();
                        resolve();
                        return;
                    }
                    collectMessage();
                } else {
                    let number = input.trim().replace(/[^0-9@]/g, '');
                    if (number.length > 0) {
                        if (!number.includes('@c.us')) {
                            number = number + '@c.us';
                        }
                        numbers.push(number);
                        const displayNum = number.replace('@c.us', '');
                        console.log(`✅ Added: ${displayNum} (${numbers.length} total)`);
                    } else {
                        console.log('❌ Invalid number format. Try again.');
                    }
                    collectNumbers();
                }
            });
        }

        function collectMessage() {
            console.log(`\n📝 You have ${numbers.length} recipient(s).`);
            rl.question('Enter your message: ', async (msg) => {
                if (!msg.trim()) {
                    console.log('❌ Message cannot be empty. Try again.');
                    collectMessage();
                    return;
                }

                console.log('\n📤 Sending messages...\n');
                await sendToMultiple(numbers, msg.trim());
                rl.close();
                resolve();
            });
        }

        async function sendToMultiple(numbers, message) {
            let successCount = 0;
            let failCount = 0;

            for (let i = 0; i < numbers.length; i++) {
                const number = numbers[i];
                const displayNumber = number.replace('@c.us', '');
                
                process.stdout.write(`[${i + 1}/${numbers.length}] Sending to ${displayNumber}... `);
                
                try {
                    await sendMessage(number, message);
                    console.log('✅ Sent');
                    successCount++;
                } catch (error) {
                    console.log(`❌ Failed: ${error.message}`);
                    failCount++;
                }

                // Small delay between messages to respect rate limits
                if (i < numbers.length - 1) {
                    await new Promise(resolve => setTimeout(resolve, 3000)); // 3 second delay
                }
            }

            console.log('\n' + '='.repeat(50));
            console.log('📊 Summary:');
            console.log(`   ✅ Successful: ${successCount}`);
            console.log(`   ❌ Failed: ${failCount}`);
            console.log(`   📝 Total: ${numbers.length}`);
            console.log('='.repeat(50) + '\n');
        }

        collectNumbers();
    });
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

// Export sendMessage function and client for use in other modules
module.exports = { sendMessage, client };
