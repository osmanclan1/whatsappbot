const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const path = require('path');
const config = require('./config');
const logger = require('./logger');
const rateLimiter = require('./rateLimiter');
const scheduler = require('./scheduler');
const healthMonitor = require('./health');
const alertSystem = require('./alerts');
const backupManager = require('./backup');
const browserManager = require('./browserManager');
const OneTimeScheduler = require('./one-time-scheduler');

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
    
    // Initialize recurring scheduler
    const messageScheduler = new scheduler(sendMessage);
    messageScheduler.start();
    
    // Initialize one-time scheduler
    const oneTimeScheduler = new OneTimeScheduler(sendMessage);
    const oneTimeFile = path.join(__dirname, 'one-time-messages.json');
    oneTimeScheduler.loadFromFile(oneTimeFile);
    oneTimeScheduler.start();
    
    // Save one-time messages periodically
    setInterval(() => {
      oneTimeScheduler.saveToFile(oneTimeFile);
    }, 60000); // Save every minute
    
    // Store schedulers for cleanup
    global.messageScheduler = messageScheduler;
    global.oneTimeScheduler = oneTimeScheduler;
    logger.info('Schedulers initialized');
    
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

// Multi-recipient sending function with scheduling support
async function runSendMultiple() {
    const readline = require('readline');
    const fs = require('fs');
    const path = require('path');
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });

    console.log('📱 WhatsApp Message Sender\n');

    return new Promise((resolve) => {
        let isMultipleMessages = false; // Multiple different messages
        let isMultipleRecipients = false; // Multiple recipients for same message
        let isRecurring = false;
        let cronExpr = null;
        let scheduleName = '';
        let sendAt = null; // For one-time scheduled messages
        let messages = []; // Array to store multiple messages

        // Step 1: Ask if single message or multiple messages
        function askMessageCount() {
            console.log('How many messages do you want to send?');
            console.log('1. Single message');
            console.log('2. Multiple messages (different messages)');
            rl.question('\nEnter choice (1 or 2): ', (choice) => {
                if (choice === '1') {
                    isMultipleMessages = false;
                    askRecipientCount();
                } else if (choice === '2') {
                    isMultipleMessages = true;
                    collectMultipleMessages();
                } else {
                    console.log('❌ Invalid choice. Please enter 1 or 2.');
                    askMessageCount();
                }
            });
        }

        // Collect multiple different messages
        function collectMultipleMessages() {
            rl.question('\nHow many different messages do you want to send? ', (countInput) => {
                const count = parseInt(countInput);
                if (isNaN(count) || count < 1) {
                    console.log('❌ Invalid number. Please enter a positive integer.');
                    collectMultipleMessages();
                    return;
                }

                console.log(`\n📝 You will collect ${count} message(s).\n`);
                collectNextMessage(0, count, []);
            });
        }

        // Collect next message in the sequence
        function collectNextMessage(currentIndex, totalCount, collectedMessages) {
            if (currentIndex >= totalCount) {
                // All messages collected, now process them
                processMultipleMessages(collectedMessages);
                return;
            }

            console.log(`\n${'='.repeat(50)}`);
            console.log(`Message ${currentIndex + 1} of ${totalCount}`);
            console.log('='.repeat(50));

            // Collect message text
            rl.question('\n📝 Enter message text: ', (messageText) => {
                if (!messageText.trim()) {
                    console.log('❌ Message cannot be empty. Try again.');
                    collectNextMessage(currentIndex, totalCount, collectedMessages);
                    return;
                }

                // Collect recipients for this message
                collectRecipientsForMessage(messageText.trim(), currentIndex, totalCount, collectedMessages);
            });
        }

        // Collect recipients for a specific message
        function collectRecipientsForMessage(messageText, messageIndex, totalCount, collectedMessages) {
            console.log('\n📞 How many recipients for this message?');
            console.log('1. Single recipient');
            console.log('2. Multiple recipients');
            rl.question('\nEnter choice (1 or 2): ', (choice) => {
                const isMultiRecip = choice === '2';
                
                if (choice !== '1' && choice !== '2') {
                    console.log('❌ Invalid choice. Please enter 1 or 2.');
                    collectRecipientsForMessage(messageText, messageIndex, totalCount, collectedMessages);
                    return;
                }

                // Collect phone numbers
                const numbers = [];
                const prompt = isMultiRecip 
                    ? '\n📞 Enter phone numbers (one per line, type "done" when finished): '
                    : '\n📞 Enter phone number: ';

                function askNumberForMessage() {
                    rl.question(prompt, (input) => {
                        if (isMultiRecip && input.toLowerCase() === 'done') {
                            if (numbers.length === 0) {
                                console.log('❌ No numbers entered. Try again.');
                                askNumberForMessage();
                                return;
                            }
                            // Ask scheduling option for this message
                            askSchedulingForMessage(messageText, numbers, messageIndex, totalCount, collectedMessages);
                        } else if (!isMultiRecip && numbers.length === 0) {
                            let number = input.trim().replace(/[^0-9@]/g, '');
                            if (number.length > 0) {
                                if (!number.includes('@c.us')) {
                                    number = number + '@c.us';
                                }
                                numbers.push(number);
                                askSchedulingForMessage(messageText, numbers, messageIndex, totalCount, collectedMessages);
                            } else {
                                console.log('❌ Invalid number format. Try again.');
                                askNumberForMessage();
                            }
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
                            askNumberForMessage();
                        }
                    });
                }

                askNumberForMessage();
            });
        }

        // Ask scheduling option for a specific message
        function askSchedulingForMessage(messageText, numbers, messageIndex, totalCount, collectedMessages) {
            console.log('\n📅 Message type:');
            console.log('1. Recurring (repeats on schedule)');
            console.log('2. Non-recurring (one-time message)');
            console.log('3. Send now (immediate)');
            rl.question('\nEnter choice (1, 2, or 3): ', (choice) => {
                if (choice === '1') {
                    // Recurring - collect schedule
                    collectRecurringScheduleForMessage(messageText, numbers, messageIndex, totalCount, collectedMessages);
                } else if (choice === '2') {
                    // One-time scheduled
                    collectOneTimeScheduleForMessage(messageText, numbers, messageIndex, totalCount, collectedMessages);
                } else if (choice === '3') {
                    // Immediate - add to collected messages
                    collectedMessages.push({
                        message: messageText,
                        recipients: numbers,
                        type: 'immediate'
                    });
                    collectNextMessage(messageIndex + 1, totalCount, collectedMessages);
                } else {
                    console.log('❌ Invalid choice. Please enter 1, 2, or 3.');
                    askSchedulingForMessage(messageText, numbers, messageIndex, totalCount, collectedMessages);
                }
            });
        }

        // Collect recurring schedule for a specific message
        function collectRecurringScheduleForMessage(messageText, numbers, messageIndex, totalCount, collectedMessages) {
            console.log('\n📅 Recurring Schedule Options:');
            console.log('1. Every hour (at :00)');
            console.log('2. Every 30 minutes');
            console.log('3. Every 15 minutes');
            console.log('4. Daily at specific time (e.g., 9:00 AM)');
            console.log('5. Custom cron expression');
            rl.question('\nEnter choice (1-5): ', (choice) => {
                let msgCronExpr = null;
                let msgScheduleName = '';

                switch(choice) {
                    case '1':
                        msgCronExpr = '0 * * * *';
                        msgScheduleName = 'hourly';
                        break;
                    case '2':
                        msgCronExpr = '*/30 * * * *';
                        msgScheduleName = 'every-30-minutes';
                        break;
                    case '3':
                        msgCronExpr = '*/15 * * * *';
                        msgScheduleName = 'every-15-minutes';
                        break;
                    case '4':
                        collectDailyTimeForMessage(messageText, numbers, messageIndex, totalCount, collectedMessages);
                        return;
                    case '5':
                        collectCustomCronForMessage(messageText, numbers, messageIndex, totalCount, collectedMessages);
                        return;
                    default:
                        console.log('❌ Invalid choice. Please enter 1-5.');
                        collectRecurringScheduleForMessage(messageText, numbers, messageIndex, totalCount, collectedMessages);
                        return;
                }

                collectedMessages.push({
                    message: messageText,
                    recipients: numbers,
                    type: 'recurring',
                    cron: msgCronExpr,
                    scheduleName: msgScheduleName
                });
                collectNextMessage(messageIndex + 1, totalCount, collectedMessages);
            });
        }

        // Collect daily time for a specific message
        function collectDailyTimeForMessage(messageText, numbers, messageIndex, totalCount, collectedMessages) {
            rl.question('\nEnter time (format: HH:MM, 24-hour, e.g., 09:00 for 9 AM): ', (timeInput) => {
                const timeMatch = timeInput.match(/^(\d{1,2}):(\d{2})$/);
                if (!timeMatch) {
                    console.log('❌ Invalid time format. Use HH:MM (e.g., 09:00)');
                    collectDailyTimeForMessage(messageText, numbers, messageIndex, totalCount, collectedMessages);
                    return;
                }
                const hour = parseInt(timeMatch[1]);
                const minute = parseInt(timeMatch[2]);
                if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
                    console.log('❌ Invalid time. Hour must be 0-23, minute must be 0-59.');
                    collectDailyTimeForMessage(messageText, numbers, messageIndex, totalCount, collectedMessages);
                    return;
                }
                const msgCronExpr = `${minute} ${hour} * * *`;
                const msgScheduleName = `daily-${hour.toString().padStart(2, '0')}-${minute.toString().padStart(2, '0')}`;
                
                collectedMessages.push({
                    message: messageText,
                    recipients: numbers,
                    type: 'recurring',
                    cron: msgCronExpr,
                    scheduleName: msgScheduleName
                });
                collectNextMessage(messageIndex + 1, totalCount, collectedMessages);
            });
        }

        // Collect custom cron for a specific message
        function collectCustomCronForMessage(messageText, numbers, messageIndex, totalCount, collectedMessages) {
            console.log('\nEnter cron expression (format: minute hour day month weekday)');
            console.log('Examples:');
            console.log('  "0 9 * * *" - Daily at 9:00 AM');
            console.log('  "0 */2 * * *" - Every 2 hours');
            console.log('  "0 9 * * 1-5" - Weekdays at 9:00 AM');
            rl.question('\nCron expression: ', (input) => {
                const cron = require('node-cron');
                if (!cron.validate(input)) {
                    console.log('❌ Invalid cron expression. Please try again.');
                    collectCustomCronForMessage(messageText, numbers, messageIndex, totalCount, collectedMessages);
                    return;
                }
                
                collectedMessages.push({
                    message: messageText,
                    recipients: numbers,
                    type: 'recurring',
                    cron: input,
                    scheduleName: 'custom'
                });
                collectNextMessage(messageIndex + 1, totalCount, collectedMessages);
            });
        }

        // Collect one-time schedule for a specific message
        function collectOneTimeScheduleForMessage(messageText, numbers, messageIndex, totalCount, collectedMessages) {
            console.log('\n📅 Schedule One-Time Message');
            console.log('Enter date and time for when to send this message.');
            rl.question('Date (YYYY-MM-DD, e.g., 2026-01-15): ', (dateInput) => {
                const dateMatch = dateInput.match(/^(\d{4})-(\d{2})-(\d{2})$/);
                if (!dateMatch) {
                    console.log('❌ Invalid date format. Use YYYY-MM-DD (e.g., 2026-01-15)');
                    collectOneTimeScheduleForMessage(messageText, numbers, messageIndex, totalCount, collectedMessages);
                    return;
                }
                const year = parseInt(dateMatch[1]);
                const month = parseInt(dateMatch[2]) - 1; // JS months are 0-indexed
                const day = parseInt(dateMatch[3]);

                rl.question('Time (HH:MM, 24-hour, e.g., 14:30 for 2:30 PM): ', (timeInput) => {
                    const timeMatch = timeInput.match(/^(\d{1,2}):(\d{2})$/);
                    if (!timeMatch) {
                        console.log('❌ Invalid time format. Use HH:MM (e.g., 14:30)');
                        collectOneTimeScheduleForMessage(messageText, numbers, messageIndex, totalCount, collectedMessages);
                        return;
                    }
                    const hour = parseInt(timeMatch[1]);
                    const minute = parseInt(timeMatch[2]);

                    if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
                        console.log('❌ Invalid time. Hour must be 0-23, minute must be 0-59.');
                        collectOneTimeScheduleForMessage(messageText, numbers, messageIndex, totalCount, collectedMessages);
                        return;
                    }

                    // Create date object
                    const sendDate = new Date(year, month, day, hour, minute);
                    const now = new Date();

                    if (sendDate <= now) {
                        console.log('❌ That time is in the past. Please choose a future date/time.');
                        collectOneTimeScheduleForMessage(messageText, numbers, messageIndex, totalCount, collectedMessages);
                        return;
                    }

                    const sendAtTime = sendDate.getTime();
                    console.log(`✅ Scheduled for: ${sendDate.toLocaleString()}`);
                    
                    collectedMessages.push({
                        message: messageText,
                        recipients: numbers,
                        type: 'onetime',
                        sendAt: sendAtTime
                    });
                    collectNextMessage(messageIndex + 1, totalCount, collectedMessages);
                });
            });
        }

        // Process all collected messages
        async function processMultipleMessages(collectedMessages) {
            console.log('\n' + '='.repeat(50));
            console.log('📊 Processing all messages...');
            console.log('='.repeat(50) + '\n');

            let immediateCount = 0;
            let recurringCount = 0;
            let onetimeCount = 0;

            for (const msgData of collectedMessages) {
                if (msgData.type === 'immediate') {
                    immediateCount++;
                    console.log(`\n📤 Sending message ${immediateCount} immediately...`);
                    await sendToMultiple(msgData.recipients, msgData.message);
                } else if (msgData.type === 'recurring') {
                    recurringCount++;
                    await saveRecurringSchedule(
                        msgData.recipients, 
                        msgData.message, 
                        msgData.cron, 
                        msgData.scheduleName
                    );
                } else if (msgData.type === 'onetime') {
                    onetimeCount++;
                    await saveOneTimeScheduleForMultiple(msgData.recipients, msgData.message, msgData.sendAt);
                }
            }

            console.log('\n' + '='.repeat(50));
            console.log('✅ All messages processed!');
            console.log(`   📤 Immediate: ${immediateCount}`);
            console.log(`   🔄 Recurring: ${recurringCount}`);
            console.log(`   📅 One-time: ${onetimeCount}`);
            console.log('='.repeat(50) + '\n');

            if (recurringCount > 0 || onetimeCount > 0) {
                console.log('💡 To activate scheduled messages, restart PM2:');
                console.log('   pm2 restart whatsapp-bot\n');
            }
        }

        // Save one-time schedule for multiple messages mode
        async function saveOneTimeScheduleForMultiple(numbers, message, finalSendAt) {
            try {
                const oneTimeFile = path.join(__dirname, 'one-time-messages.json');
                let oneTimeMessages = [];

                // Load existing one-time messages
                if (fs.existsSync(oneTimeFile)) {
                    const data = fs.readFileSync(oneTimeFile, 'utf8');
                    oneTimeMessages = JSON.parse(data);
                }

                // Create new one-time message
                const messageId = `onetime-${Date.now()}`;
                const newMessage = {
                    id: messageId,
                    recipients: numbers,
                    message: message,
                    sendAt: finalSendAt
                };

                oneTimeMessages.push(newMessage);

                // Save to file
                fs.writeFileSync(oneTimeFile, JSON.stringify(oneTimeMessages, null, 2), 'utf8');

                const sendDate = new Date(finalSendAt);
                console.log(`\n✅ One-time message scheduled: ${sendDate.toLocaleString()}`);
            } catch (error) {
                console.error('❌ Error saving one-time schedule:', error.message);
            }
        }

        // Step 2: Ask if single or multiple recipients (for single message mode)
        function askRecipientCount() {
            console.log('\nHow many recipients for this message?');
            console.log('1. Single recipient');
            console.log('2. Multiple recipients');
            rl.question('\nEnter choice (1 or 2): ', (choice) => {
                if (choice === '1') {
                    isMultipleRecipients = false;
                    askRecurringOption();
                } else if (choice === '2') {
                    isMultipleRecipients = true;
                    askRecurringOption();
                } else {
                    console.log('❌ Invalid choice. Please enter 1 or 2.');
                    askRecipientCount();
                }
            });
        }

        // Step 2: Ask if recurring or non-recurring
        function askRecurringOption() {
            console.log('\nMessage type:');
            console.log('1. Recurring (repeats on schedule)');
            console.log('2. Non-recurring (one-time message)');
            rl.question('\nEnter choice (1 or 2): ', (choice) => {
                if (choice === '1') {
                    isRecurring = true;
                    collectRecurringScheduleType();
                } else if (choice === '2') {
                    isRecurring = false;
                    askNonRecurringOption();
                } else {
                    console.log('❌ Invalid choice. Please enter 1 or 2.');
                    askRecurringOption();
                }
            });
        }

        // Step 3a: For recurring, ask schedule type
        function collectRecurringScheduleType() {
            console.log('\n📅 Recurring Schedule Options:');
            console.log('1. Every hour (at :00)');
            console.log('2. Every 30 minutes');
            console.log('3. Every 15 minutes');
            console.log('4. Daily at specific time (e.g., 9:00 AM)');
            console.log('5. Custom cron expression');
            rl.question('\nEnter choice (1-5): ', (choice) => {
                switch(choice) {
                    case '1':
                        cronExpr = '0 * * * *';
                        scheduleName = 'hourly';
                        break;
                    case '2':
                        cronExpr = '*/30 * * * *';
                        scheduleName = 'every-30-minutes';
                        break;
                    case '3':
                        cronExpr = '*/15 * * * *';
                        scheduleName = 'every-15-minutes';
                        break;
                    case '4':
                        collectDailyTime();
                        return;
                    case '5':
                        collectCustomCron();
                        return;
                    default:
                        console.log('❌ Invalid choice. Please enter 1-5.');
                        collectRecurringScheduleType();
                        return;
                }
                collectNumbers();
            });
        }

        // Step 3b: For non-recurring, ask immediate or scheduled
        function askNonRecurringOption() {
            console.log('\n📤 Non-Recurring Options:');
            console.log('1. Send now (immediate)');
            console.log('2. Schedule for specific date/time');
            rl.question('\nEnter choice (1 or 2): ', (choice) => {
                if (choice === '1') {
                    collectNumbers();
                } else if (choice === '2') {
                    collectOneTimeSchedule();
                } else {
                    console.log('❌ Invalid choice. Please enter 1 or 2.');
                    askNonRecurringOption();
                }
            });
        }

        // Step 2: If scheduling, ask for schedule type
        function collectScheduleType() {
            console.log('\n📅 Schedule Options:');
            console.log('1. Every hour (at :00)');
            console.log('2. Every 30 minutes');
            console.log('3. Every 15 minutes');
            console.log('4. Daily at specific time (e.g., 9:00 AM)');
            console.log('5. Custom cron expression');
            rl.question('\nEnter choice (1-5): ', (choice) => {
                let cronExpr = null;
                let scheduleName = '';

                switch(choice) {
                    case '1':
                        cronExpr = '0 * * * *';
                        scheduleName = 'hourly';
                        break;
                    case '2':
                        cronExpr = '*/30 * * * *';
                        scheduleName = 'every-30-minutes';
                        break;
                    case '3':
                        cronExpr = '*/15 * * * *';
                        scheduleName = 'every-15-minutes';
                        break;
                    case '4':
                        collectDailyTime();
                        return;
                    case '5':
                        collectCustomCron();
                        return;
                    default:
                        console.log('❌ Invalid choice. Please enter 1-5.');
                        collectScheduleType();
                        return;
                }

                collectNumbers(true, cronExpr, scheduleName);
            });
        }

        function collectDailyTime() {
            rl.question('\nEnter time (format: HH:MM, 24-hour, e.g., 09:00 for 9 AM): ', (timeInput) => {
                const timeMatch = timeInput.match(/^(\d{1,2}):(\d{2})$/);
                if (!timeMatch) {
                    console.log('❌ Invalid time format. Use HH:MM (e.g., 09:00)');
                    collectDailyTime();
                    return;
                }
                const hour = parseInt(timeMatch[1]);
                const minute = parseInt(timeMatch[2]);
                if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
                    console.log('❌ Invalid time. Hour must be 0-23, minute must be 0-59.');
                    collectDailyTime();
                    return;
                }
                cronExpr = `${minute} ${hour} * * *`;
                scheduleName = `daily-${hour.toString().padStart(2, '0')}-${minute.toString().padStart(2, '0')}`;
                collectNumbers();
            });
        }

        function collectCustomCron() {
            console.log('\nEnter cron expression (format: minute hour day month weekday)');
            console.log('Examples:');
            console.log('  "0 9 * * *" - Daily at 9:00 AM');
            console.log('  "0 */2 * * *" - Every 2 hours');
            console.log('  "0 9 * * 1-5" - Weekdays at 9:00 AM');
            rl.question('\nCron expression: ', (input) => {
                const cron = require('node-cron');
                if (!cron.validate(input)) {
                    console.log('❌ Invalid cron expression. Please try again.');
                    collectCustomCron();
                    return;
                }
                cronExpr = input;
                scheduleName = 'custom';
                collectNumbers();
            });
        }

        // Collect one-time schedule (date and time)
        function collectOneTimeSchedule() {
            console.log('\n📅 Schedule One-Time Message');
            console.log('Enter date and time for when to send this message.');
            rl.question('Date (YYYY-MM-DD, e.g., 2026-01-15): ', (dateInput) => {
                const dateMatch = dateInput.match(/^(\d{4})-(\d{2})-(\d{2})$/);
                if (!dateMatch) {
                    console.log('❌ Invalid date format. Use YYYY-MM-DD (e.g., 2026-01-15)');
                    collectOneTimeSchedule();
                    return;
                }
                const year = parseInt(dateMatch[1]);
                const month = parseInt(dateMatch[2]) - 1; // JS months are 0-indexed
                const day = parseInt(dateMatch[3]);

                rl.question('Time (HH:MM, 24-hour, e.g., 14:30 for 2:30 PM): ', (timeInput) => {
                    const timeMatch = timeInput.match(/^(\d{1,2}):(\d{2})$/);
                    if (!timeMatch) {
                        console.log('❌ Invalid time format. Use HH:MM (e.g., 14:30)');
                        collectOneTimeSchedule();
                        return;
                    }
                    const hour = parseInt(timeMatch[1]);
                    const minute = parseInt(timeMatch[2]);

                    if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
                        console.log('❌ Invalid time. Hour must be 0-23, minute must be 0-59.');
                        collectOneTimeSchedule();
                        return;
                    }

                    // Create date object
                    const sendDate = new Date(year, month, day, hour, minute);
                    const now = new Date();

                    if (sendDate <= now) {
                        console.log('❌ That time is in the past. Please choose a future date/time.');
                        collectOneTimeSchedule();
                        return;
                    }

                    sendAt = sendDate.getTime();
                    console.log(`✅ Scheduled for: ${sendDate.toLocaleString()}`);
                    collectNumbers();
                });
            });
        }

        // Step 4: Collect phone numbers (for single message mode)
        function collectNumbers() {
            if (isMultipleRecipients) {
                console.log('\n📞 Enter phone numbers (one per line).');
                console.log('Format: countrycode+number (e.g., 15551234567)');
                console.log('Type "done" when finished entering numbers.\n');
            } else {
                console.log('\n📞 Enter phone number.');
                console.log('Format: countrycode+number (e.g., 15551234567)\n');
            }

            const numbers = [];

            function askNumber() {
                const prompt = isMultipleRecipients 
                    ? 'Phone number (or "done" to finish): '
                    : 'Phone number: ';
                    
                rl.question(prompt, (input) => {
                    if (isMultipleRecipients && input.toLowerCase() === 'done') {
                        if (numbers.length === 0) {
                            console.log('❌ No numbers entered. Exiting.');
                            rl.close();
                            resolve();
                            return;
                        }
                        collectMessage(numbers);
                    } else if (!isMultipleRecipients && numbers.length === 0) {
                        // Single recipient - just get one number
                        let number = input.trim().replace(/[^0-9@]/g, '');
                        if (number.length > 0) {
                            if (!number.includes('@c.us')) {
                                number = number + '@c.us';
                            }
                            numbers.push(number);
                            collectMessage(numbers);
                        } else {
                            console.log('❌ Invalid number format. Try again.');
                            askNumber();
                        }
                    } else {
                        // Multiple recipients - keep collecting
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
                        askNumber();
                    }
                });
            }

            askNumber();
        }

        // Step 5: Collect message
        function collectMessage(numbers) {
            console.log(`\n📝 You have ${numbers.length} recipient(s).`);
            rl.question('Enter your message: ', async (msg) => {
                if (!msg.trim()) {
                    console.log('❌ Message cannot be empty. Try again.');
                    collectMessage(numbers);
                    return;
                }

                if (isRecurring) {
                    // Save recurring schedule
                    await saveRecurringSchedule(numbers, msg.trim());
                } else if (sendAt) {
                    // Save one-time scheduled message
                    await saveOneTimeSchedule(numbers, msg.trim());
                } else {
                    // Send immediately
                    console.log('\n📤 Sending messages now...\n');
                    await sendToMultiple(numbers, msg.trim());
                }
                rl.close();
                resolve();
            });
        }

        // Save recurring schedule to file
        async function saveRecurringSchedule(numbers, message, cronOverride = null, scheduleNameOverride = '') {
            // Use provided values or fall back to stored values
            const finalCron = cronOverride || cronExpr || '0 * * * *';
            const finalScheduleName = scheduleNameOverride || scheduleName || 'custom';
            try {
                const schedulesFile = path.join(__dirname, 'schedules.json');
                let schedules = [];

                // Load existing schedules
                if (fs.existsSync(schedulesFile)) {
                    const data = fs.readFileSync(schedulesFile, 'utf8');
                    schedules = JSON.parse(data);
                }

                // Create new schedule
                const scheduleId = `${finalScheduleName}-${Date.now()}`;
                const newSchedule = {
                    id: scheduleId,
                    recipients: numbers,
                    message: message,
                    cron: finalCron,
                    enabled: true,
                    timezone: config.timezone || 'America/New_York'
                };

                schedules.push(newSchedule);

                // Save to file
                fs.writeFileSync(schedulesFile, JSON.stringify(schedules, null, 2), 'utf8');

                console.log('\n✅ Recurring schedule saved successfully!');
                console.log(`   Schedule ID: ${scheduleId}`);
                console.log(`   Recipients: ${numbers.length}`);
                console.log(`   Cron: ${finalCron}`);
                console.log(`   Message: ${message.substring(0, 50)}${message.length > 50 ? '...' : ''}`);
                console.log('\n💡 To activate this schedule, restart PM2:');
                console.log('   pm2 restart whatsapp-bot\n');
            } catch (error) {
                console.error('❌ Error saving schedule:', error.message);
            }
        }

        // Save one-time scheduled message
        async function saveOneTimeSchedule(numbers, message) {
            try {
                const oneTimeFile = path.join(__dirname, 'one-time-messages.json');
                let oneTimeMessages = [];

                // Load existing one-time messages
                if (fs.existsSync(oneTimeFile)) {
                    const data = fs.readFileSync(oneTimeFile, 'utf8');
                    oneTimeMessages = JSON.parse(data);
                }

                // Create new one-time message
                const messageId = `onetime-${Date.now()}`;
                const newMessage = {
                    id: messageId,
                    recipients: numbers,
                    message: message,
                    sendAt: sendAt
                };

                oneTimeMessages.push(newMessage);

                // Save to file
                fs.writeFileSync(oneTimeFile, JSON.stringify(oneTimeMessages, null, 2), 'utf8');

                const sendDate = new Date(sendAt);
                console.log('\n✅ One-time message scheduled successfully!');
                console.log(`   Message ID: ${messageId}`);
                console.log(`   Recipients: ${numbers.length}`);
                console.log(`   Scheduled for: ${sendDate.toLocaleString()}`);
                console.log(`   Message: ${message.substring(0, 50)}${message.length > 50 ? '...' : ''}`);
                console.log('\n💡 To activate this schedule, restart PM2:');
                console.log('   pm2 restart whatsapp-bot\n');
            } catch (error) {
                console.error('❌ Error saving one-time schedule:', error.message);
            }
        }

        // Send immediately
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

                if (i < numbers.length - 1) {
                    await new Promise(resolve => setTimeout(resolve, 3000));
                }
            }

            console.log('\n' + '='.repeat(50));
            console.log('📊 Summary:');
            console.log(`   ✅ Successful: ${successCount}`);
            console.log(`   ❌ Failed: ${failCount}`);
            console.log(`   📝 Total: ${numbers.length}`);
            console.log('='.repeat(50) + '\n');
        }

        askMessageCount();
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
    
    // Stop schedulers
    if (global.messageScheduler) {
        global.messageScheduler.stop();
    }
    if (global.oneTimeScheduler) {
        global.oneTimeScheduler.stop();
        // Save before shutdown
        const oneTimeFile = require('path').join(__dirname, 'one-time-messages.json');
        global.oneTimeScheduler.saveToFile(oneTimeFile);
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
