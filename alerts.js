const logger = require('./logger');
const config = require('./config');

class AlertSystem {
  constructor(healthMonitor) {
    this.healthMonitor = healthMonitor;
    this.alertHistory = [];
    this.lastAlertTimes = new Map();
    this.alertCooldown = 5 * 60 * 1000; // 5 minutes cooldown between same alerts
  }

  /**
   * Check for alert conditions
   */
  checkAlerts() {
    const metrics = this.healthMonitor.getMetrics();
    
    // Check connection lost
    if (metrics.connection.lostSince) {
      const lostMinutes = (Date.now() - metrics.connection.lostSince) / 60000;
      if (lostMinutes > config.alerts.connectionLostMinutes) {
        this.triggerAlert('connection_lost', {
          message: `Connection lost for ${Math.round(lostMinutes)} minutes`,
          lostSince: metrics.connection.lostSince,
          minutes: Math.round(lostMinutes)
        });
      }
    }

    // Check memory usage
    if (metrics.memory.usagePercent > (config.alerts.memoryThreshold * 100)) {
      this.triggerAlert('high_memory', {
        message: `Memory usage at ${metrics.memory.usagePercent.toFixed(1)}%`,
        usagePercent: metrics.memory.usagePercent,
        threshold: config.alerts.memoryThreshold * 100
      });
    }

    // Check process memory
    if (metrics.memory.process.percent > 90) {
      this.triggerAlert('high_process_memory', {
        message: `Process memory usage at ${metrics.memory.process.percent.toFixed(1)}%`,
        usagePercent: metrics.memory.process.percent
      });
    }

    // Check error rate
    const errorRate = this.calculateErrorRate(metrics.messages.errors);
    if (errorRate > config.alerts.highErrorRate) {
      this.triggerAlert('high_error_rate', {
        message: `High error rate: ${errorRate} errors/minute`,
        errorRate,
        threshold: config.alerts.highErrorRate
      });
    }
  }

  /**
   * Calculate error rate (errors per minute)
   */
  calculateErrorRate(totalErrors) {
    // Simple calculation - in production, you'd track errors over time windows
    const uptimeMinutes = (Date.now() - this.healthMonitor.startTime) / 60000;
    return uptimeMinutes > 0 ? totalErrors / uptimeMinutes : 0;
  }

  /**
   * Trigger an alert
   * @param {string} type - Alert type
   * @param {Object} data - Alert data
   */
  triggerAlert(type, data) {
    const now = Date.now();
    const lastAlert = this.lastAlertTimes.get(type);
    
    // Check cooldown
    if (lastAlert && (now - lastAlert) < this.alertCooldown) {
      return; // Still in cooldown
    }

    this.lastAlertTimes.set(type, now);

    const alert = {
      type,
      timestamp: now,
      ...data
    };

    this.alertHistory.push(alert);
    
    // Keep only last 100 alerts
    if (this.alertHistory.length > 100) {
      this.alertHistory.shift();
    }

    // Log alert
    logger.error(`[ALERT] ${data.message}`, {
      alertType: type,
      ...data
    });

    // Here you could add:
    // - Email notifications
    // - Webhook calls
    // - SMS alerts
    // - Slack/Discord notifications
  }

  /**
   * Trigger authentication failure alert
   */
  triggerAuthFailure(reason) {
    this.triggerAlert('authentication_failure', {
      message: `Authentication failed: ${reason}`,
      reason
    });
  }

  /**
   * Trigger session expiration alert
   */
  triggerSessionExpired() {
    this.triggerAlert('session_expired', {
      message: 'WhatsApp session has expired. QR code scan required.'
    });
  }

  /**
   * Trigger rate limit exceeded alert
   */
  triggerRateLimitExceeded(details) {
    this.triggerAlert('rate_limit_exceeded', {
      message: 'Rate limit exceeded',
      ...details
    });
  }

  /**
   * Get recent alerts
   * @param {number} limit - Number of alerts to return
   */
  getRecentAlerts(limit = 10) {
    return this.alertHistory.slice(-limit).reverse();
  }

  /**
   * Start alert monitoring
   */
  start() {
    // Check alerts every minute
    setInterval(() => {
      this.checkAlerts();
    }, 60000);
  }
}

module.exports = AlertSystem;

