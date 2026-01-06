const logger = require('./logger');
const rateLimiter = require('./rateLimiter');

class OneTimeScheduler {
  constructor(sendMessageFn) {
    this.sendMessageFn = sendMessageFn;
    this.pendingMessages = [];
    this.checkInterval = null;
  }

  /**
   * Start checking for pending one-time messages
   */
  start() {
    if (this.checkInterval) {
      return;
    }

    // Check every minute for pending messages
    this.checkInterval = setInterval(() => {
      this.checkPendingMessages();
    }, 60000); // Check every minute

    // Also check immediately
    this.checkPendingMessages();

    logger.info('One-time scheduler started');
  }

  /**
   * Stop checking
   */
  stop() {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
  }

  /**
   * Add a one-time message
   * @param {Object} messageData - { recipients, message, sendAt (timestamp) }
   */
  addOneTimeMessage(messageData) {
    this.pendingMessages.push({
      ...messageData,
      id: `onetime-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
    });
    logger.info('One-time message added', {
      id: this.pendingMessages[this.pendingMessages.length - 1].id,
      sendAt: new Date(messageData.sendAt).toISOString(),
      recipientCount: messageData.recipients.length
    });
  }

  /**
   * Check and send pending messages
   */
  async checkPendingMessages() {
    const now = Date.now();
    const toSend = [];
    const remaining = [];

    for (const msg of this.pendingMessages) {
      if (msg.sendAt <= now) {
        toSend.push(msg);
      } else {
        remaining.push(msg);
      }
    }

    this.pendingMessages = remaining;

    // Send messages that are due
    for (const msg of toSend) {
      await this.sendOneTimeMessage(msg);
    }
  }

  /**
   * Send a one-time message
   */
  async sendOneTimeMessage(msg) {
    logger.info('Sending one-time message', { id: msg.id });

    let successCount = 0;
    let failCount = 0;

    for (const recipient of msg.recipients) {
      try {
        const rateCheck = rateLimiter.canSend(recipient);
        
        if (!rateCheck.allowed) {
          logger.warn('One-time message rate limited', {
            id: msg.id,
            recipient,
            reason: rateCheck.reason
          });
          failCount++;
          continue;
        }

        await this.sendMessageFn(recipient, msg.message);
        rateLimiter.recordSent(recipient);
        successCount++;

        // Delay between recipients
        if (msg.recipients.indexOf(recipient) < msg.recipients.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 3000));
        }
      } catch (error) {
        failCount++;
        logger.error('Failed to send one-time message', {
          id: msg.id,
          recipient,
          error: error.message
        });
      }
    }

    logger.info('One-time message completed', {
      id: msg.id,
      successCount,
      failCount,
      total: msg.recipients.length
    });
  }

  /**
   * Load pending messages from file
   */
  loadFromFile(filePath) {
    try {
      const fs = require('fs');
      if (fs.existsSync(filePath)) {
        const data = fs.readFileSync(filePath, 'utf8');
        this.pendingMessages = JSON.parse(data);
        logger.info('Loaded one-time messages from file', {
          count: this.pendingMessages.length
        });
      }
    } catch (error) {
      logger.error('Error loading one-time messages', { error: error.message });
    }
  }

  /**
   * Save pending messages to file
   */
  saveToFile(filePath) {
    try {
      const fs = require('fs');
      fs.writeFileSync(filePath, JSON.stringify(this.pendingMessages, null, 2), 'utf8');
    } catch (error) {
      logger.error('Error saving one-time messages', { error: error.message });
    }
  }

  /**
   * Get pending messages
   */
  getPendingMessages() {
    return this.pendingMessages.map(msg => ({
      id: msg.id,
      recipients: msg.recipients,
      message: msg.message,
      sendAt: new Date(msg.sendAt).toISOString()
    }));
  }
}

module.exports = OneTimeScheduler;

