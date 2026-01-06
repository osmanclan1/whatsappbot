const os = require('os');
const logger = require('./logger');
const config = require('./config');

class HealthMonitor {
  constructor(client) {
    this.client = client;
    this.startTime = Date.now();
    this.lastConnectionCheck = null;
    this.connectionLostSince = null;
    this.messageStats = {
      sent: 0,
      received: 0,
      errors: 0,
      lastSent: null,
      lastReceived: null
    };
    this.checkInterval = null;
  }

  /**
   * Start health monitoring
   */
  start() {
    logger.health('Starting health monitor', { interval: config.health.checkInterval });
    
    this.checkInterval = setInterval(() => {
      this.checkHealth();
    }, config.health.checkInterval);

    // Initial check
    this.checkHealth();
  }

  /**
   * Stop health monitoring
   */
  stop() {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
  }

  /**
   * Perform health check
   */
  async checkHealth() {
    try {
      const state = await this.client.getState();
      const isConnected = state === 'CONNECTED';
      
      this.lastConnectionCheck = Date.now();
      
      if (isConnected) {
        if (this.connectionLostSince) {
          const downtime = Date.now() - this.connectionLostSince;
          logger.health('Connection restored', { downtimeMs: downtime });
          this.connectionLostSince = null;
        }
      } else {
        if (!this.connectionLostSince) {
          this.connectionLostSince = Date.now();
          logger.warn('Connection lost detected', { state });
        }
      }

      // Get system metrics
      const metrics = this.getMetrics();
      
      logger.health('Health check completed', {
        connected: isConnected,
        uptime: metrics.uptime,
        memory: metrics.memory.usagePercent
      });
    } catch (error) {
      logger.error('Health check failed', { error: error.message });
    }
  }

  /**
   * Get current health metrics
   */
  getMetrics() {
    const uptime = Date.now() - this.startTime;
    const memUsage = process.memoryUsage();
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;
    const memUsagePercent = (usedMem / totalMem) * 100;
    const processMemPercent = (memUsage.heapUsed / totalMem) * 100;

    return {
      uptime: Math.floor(uptime / 1000), // seconds
      memory: {
        total: totalMem,
        free: freeMem,
        used: usedMem,
        usagePercent: Math.round(memUsagePercent * 100) / 100,
        process: {
          heapUsed: memUsage.heapUsed,
          heapTotal: memUsage.heapTotal,
          external: memUsage.external,
          rss: memUsage.rss,
          percent: Math.round(processMemPercent * 100) / 100
        }
      },
      cpu: {
        loadAverage: os.loadavg(),
        cores: os.cpus().length
      },
      connection: {
        connected: this.connectionLostSince === null,
        lastCheck: this.lastConnectionCheck,
        lostSince: this.connectionLostSince
      },
      messages: { ...this.messageStats }
    };
  }

  /**
   * Record message sent
   */
  recordSent() {
    this.messageStats.sent++;
    this.messageStats.lastSent = Date.now();
  }

  /**
   * Record message received
   */
  recordReceived() {
    this.messageStats.received++;
    this.messageStats.lastReceived = Date.now();
  }

  /**
   * Record error
   */
  recordError() {
    this.messageStats.errors++;
  }

  /**
   * Get health status
   */
  getStatus() {
    const metrics = this.getMetrics();
    const isHealthy = 
      metrics.connection.connected &&
      metrics.memory.usagePercent < (config.alerts.memoryThreshold * 100) &&
      metrics.memory.process.percent < 90;

    return {
      healthy: isHealthy,
      metrics
    };
  }
}

module.exports = HealthMonitor;

