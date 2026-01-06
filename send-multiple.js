#!/usr/bin/env node

const readline = require('readline');
const { Client, LocalAuth } = require('whatsapp-web.js');
const config = require('./config');
const rateLimiter = require('./rateLimiter');

// Create a client instance (will use existing session)
const client = new Client({
    authStrategy: new LocalAuth({
        dataPath: './.wwebjs_auth'
    }),
    puppeteer: {
        headless: config.puppeteer.headless,
        args: config.puppeteer.args
    }
});

let clientReady = false;

client.on('ready', () => {
    clientReady = true;
    console.log('✅ WhatsApp client is ready!\n');
    startPrompt();
});

// Initialize client
console.log('⏳ Connecting to WhatsApp...');
client.initialize();

// Give it a moment to check if already authenticated
setTimeout(() => {
    if (!clientReady) {
        console.log('⏳ Waiting for authentication...');
    }
}, 3000);

function startPrompt() {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });

    console.log('📱 WhatsApp Multi-Recipient Message Sender\n');
    console.log('Enter phone numbers (one per line).');
    console.log('Format: countrycode+number (e.g., 15551234567 or +1-555-123-4567)');
    console.log('Type "done" when finished entering numbers.\n');

    const numbers = [];

    function collectNumbers() {
        rl.question('Phone number (or "done" to finish): ', (input) => {
            if (input.toLowerCase() === 'done') {
                if (numbers.length === 0) {
                    console.log('❌ No numbers entered. Exiting.');
                    rl.close();
                    client.destroy();
                    process.exit(0);
                }
                collectMessage();
            } else {
                // Format the number - remove all non-digits except @
                let number = input.trim().replace(/[^0-9@]/g, '');
                
                if (number.length > 0) {
                    // Add @c.us if not present
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
            client.destroy();
            process.exit(0);
        });
    }

    collectNumbers();
}

async function sendMessage(number, message) {
    try {
        // Check rate limiter
        const rateCheck = rateLimiter.canSend(number);
        
        if (!rateCheck.allowed) {
            throw new Error(`Rate limited: ${rateCheck.reason}. Wait ${rateCheck.waitTime} seconds.`);
        }

        // Send message
        await client.sendMessage(number, message);
        rateLimiter.recordSent(number);
        
        return { success: true, number };
    } catch (error) {
        return { success: false, number, error: error.message };
    }
}

async function sendToMultiple(numbers, message) {
    const results = [];
    let successCount = 0;
    let failCount = 0;

    console.log(`Sending to ${numbers.length} recipient(s)...\n`);

    for (let i = 0; i < numbers.length; i++) {
        const number = numbers[i];
        const displayNumber = number.replace('@c.us', '');
        
        process.stdout.write(`[${i + 1}/${numbers.length}] Sending to ${displayNumber}... `);
        
        const result = await sendMessage(number, message);
        
        if (result.success) {
            console.log('✅ Sent');
            successCount++;
        } else {
            console.log(`❌ Failed: ${result.error}`);
            failCount++;
        }
        
        results.push(result);

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

    // Show failed numbers if any
    if (failCount > 0) {
        console.log('Failed numbers:');
        results
            .filter(r => !r.success)
            .forEach(r => {
                console.log(`   - ${r.number.replace('@c.us', '')}: ${r.error}`);
            });
        console.log('');
    }
}

// Handle graceful shutdown
process.on('SIGINT', async () => {
    console.log('\n\n👋 Exiting...');
    await client.destroy();
    process.exit(0);
});
