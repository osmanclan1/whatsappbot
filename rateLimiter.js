const logger = require('./logger');
const config = require('./config');

class RateLimiter {
  constructor() {
    this.messageHistory = new Map(); // phone -> [{timestamp, count}]
    this.globalHistory = []; // [{timestamp, count}]
    this.queuedMessages = []; // Queue for rate-limited messages
  }

  /**
   * Check if message can be sent based on rate limits
   * @param {string} recipient - Phone number
   * @returns {Object} {allowed: boolean, reason?: string, waitTime?: number}
   */
  canSend(recipient) {
    const now = Date.now();
    const oneMinuteAgo = now - 60000;
    const oneHourAgo = now - 3600000;

    // Check global per-minute limit
    this.globalHistory = this.globalHistory.filter(entry => entry.timestamp > oneMinuteAgo);
    const recentGlobalCount = this.globalHistory.reduce((sum, entry) => sum + entry.count, 0);
    
    if (recentGlobalCount >= config.rateLimit.messagesPerMinute) {
      const oldest = this.globalHistory[0];
      const waitTime = oldest ? (60000 - (now - oldest.timestamp)) : 60000;
      return {
        allowed: false,
        reason: 'Global per-minute limit exceeded',
        waitTime: Math.ceil(waitTime / 1000) // seconds
      };
    }

    // Check global per-hour limit
    const hourHistory = this.globalHistory.filter(entry => entry.timestamp > oneHourAgo);
    const hourCount = hourHistory.reduce((sum, entry) => sum + entry.count, 0);
    
    if (hourCount >= config.rateLimit.messagesPerHour) {
      const oldest = hourHistory[0];
      const waitTime = oldest ? (3600000 - (now - oldest.timestamp)) : 3600000;
      return {
        allowed: false,
        reason: 'Global per-hour limit exceeded',
        waitTime: Math.ceil(waitTime / 1000) // seconds
      };
    }

    // Check per-recipient limit
    if (recipient) {
      if (!this.messageHistory.has(recipient)) {
        this.messageHistory.set(recipient, []);
      }
      
      const recipientHistory = this.messageHistory.get(recipient);
      const recentRecipientCount = recipientHistory.filter(
        entry => entry.timestamp > oneMinuteAgo
      ).reduce((sum, entry) => sum + entry.count, 0);
      
      if (recentRecipientCount >= config.rateLimit.perRecipientLimit) {
        const oldest = recipientHistory.find(entry => entry.timestamp > oneMinuteAgo);
        const waitTime = oldest ? (60000 - (now - oldest.timestamp)) : 60000;
        return {
          allowed: false,
          reason: 'Per-recipient limit exceeded',
          waitTime: Math.ceil(waitTime / 1000) // seconds
        };
      }
    }

    return { allowed: true };
  }

  /**
   * Record a sent message
   * @param {string} recipient - Phone number (optional for global tracking)
   */
  recordSent(recipient = null) {
    const now = Date.now();
    
    // Record in global history
    this.globalHistory.push({ timestamp: now, count: 1 });
    
    // Record in recipient history
    if (recipient) {
      if (!this.messageHistory.has(recipient)) {
        this.messageHistory.set(recipient, []);
      }
      this.messageHistory.get(recipient).push({ timestamp: now, count: 1 });
    }

    // Cleanup old entries (older than 1 hour)
    const oneHourAgo = now - 3600000;
    this.globalHistory = this.globalHistory.filter(entry => entry.timestamp > oneHourAgo);
    
    for (const [phone, history] of this.messageHistory.entries()) {
      const filtered = history.filter(entry => entry.timestamp > oneHourAgo);
      if (filtered.length === 0) {
        this.messageHistory.delete(phone);
      } else {
        this.messageHistory.set(phone, filtered);
      }
    }
  }

  /**
   * Add message to queue if rate limited
   * @param {string} recipient - Phone number
   * @param {string} message - Message text
   * @param {Function} sendFn - Function to send message
   */
  async queueMessage(recipient, message, sendFn) {
    const check = this.canSend(recipient);
    
    if (check.allowed) {
      try {
        await sendFn();
        this.recordSent(recipient);
        return { success: true };
      } catch (error) {
        logger.error('Failed to send queued message', { recipient, error: error.message });
        return { success: false, error };
      }
    } else {
      // Add to queue
      this.queuedMessages.push({
        recipient,
        message,
        sendFn,
        addedAt: Date.now(),
        waitTime: check.waitTime
      });
      
      logger.warn('Message queued due to rate limit', {
        recipient,
        reason: check.reason,
        waitTime: check.waitTime
      });
      
      return { success: false, queued: true, waitTime: check.waitTime };
    }
  }

  /**
   * Process queued messages
   */
  async processQueue() {
    if (this.queuedMessages.length === 0) return;

    const now = Date.now();
    const toProcess = [];
    const stillQueued = [];

    for (const item of this.queuedMessages) {
      const check = this.canSend(item.recipient);
      if (check.allowed) {
        toProcess.push(item);
      } else {
        // Check if item is too old (older than 1 hour)
        if (now - item.addedAt > 3600000) {
          logger.warn('Dropping queued message (too old)', { recipient: item.recipient });
        } else {
          stillQueued.push(item);
        }
      }
    }

    this.queuedMessages = stillQueued;

    // Process allowed messages
    for (const item of toProcess) {
      try {
        await item.sendFn();
        this.recordSent(item.recipient);
        logger.info('Processed queued message', { recipient: item.recipient });
      } catch (error) {
        logger.error('Failed to process queued message', {
          recipient: item.recipient,
          error: error.message
        });
      }
    }
  }

  /**
   * Get current rate limit stats
   */
  getStats() {
    const now = Date.now();
    const oneMinuteAgo = now - 60000;
    const oneHourAgo = now - 3600000;

    const recentGlobal = this.globalHistory.filter(e => e.timestamp > oneMinuteAgo);
    const hourGlobal = this.globalHistory.filter(e => e.timestamp > oneHourAgo);

    return {
      global: {
        lastMinute: recentGlobal.reduce((sum, e) => sum + e.count, 0),
        lastHour: hourGlobal.reduce((sum, e) => sum + e.count, 0),
        limitPerMinute: config.rateLimit.messagesPerMinute,
        limitPerHour: config.rateLimit.messagesPerHour
      },
      queued: this.queuedMessages.length,
      trackedRecipients: this.messageHistory.size
    };
  }
}

// Singleton instance
const rateLimiter = new RateLimiter();

// Process queue every 30 seconds
setInterval(() => {
  rateLimiter.processQueue().catch(err => {
    logger.error('Error processing rate limit queue', { error: err.message });
  });
}, 30000);

module.exports = rateLimiter;

