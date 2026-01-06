const logger = require('./logger');
const config = require('./config');

class BrowserManager {
  constructor(client) {
    this.client = client;
    this.browser = null;
    this.restartAttempts = 0;
    this.maxRestartAttempts = config.reconnection.maxRetries;
    this.isRestarting = false;
    this.lastRestartTime = null;
  }

  /**
   * Initialize browser monitoring
   */
  initialize() {
    // Monitor browser process
    this.client.on('ready', () => {
      this.browser = this.client.pupPage?.browser();
      this.restartAttempts = 0; // Reset on successful connection
      logger.connection('Browser connected and ready');
    });

    // Handle browser disconnection
    this.client.on('disconnected', async (reason) => {
      logger.warn('Client disconnected', { reason });
      await this.handleDisconnection(reason);
    });

    // Handle Puppeteer errors
    this.client.on('error', async (error) => {
      logger.error('Client error', { error: error.message, stack: error.stack });
      
      // Check if it's a browser-related error
      if (this.isBrowserError(error)) {
        await this.handleBrowserError(error);
      }
    });
  }

  /**
   * Check if error is browser-related
   */
  isBrowserError(error) {
    const browserErrorPatterns = [
      'Target closed',
      'Session closed',
      'Protocol error',
      'Navigation timeout',
      'browser disconnected',
      'ECONNRESET',
      'Connection closed'
    ];

    const errorMessage = error.message || error.toString();
    return browserErrorPatterns.some(pattern => 
      errorMessage.toLowerCase().includes(pattern.toLowerCase())
    );
  }

  /**
   * Handle browser disconnection
   */
  async handleDisconnection(reason) {
    if (this.isRestarting) {
      logger.debug('Already restarting, ignoring disconnection');
      return;
    }

    // Check if we should restart based on reason
    const shouldRestart = [
      'NAVIGATION',
      'CONFLICT',
      'browser disconnected',
      'Target closed'
    ].some(r => reason.includes(r));

    if (shouldRestart) {
      await this.restartBrowser('disconnection');
    } else if (reason === 'LOGOUT') {
      logger.warn('Logged out from phone, QR code scan required');
      // Will need to re-authenticate
    }
  }

  /**
   * Handle browser errors
   */
  async handleBrowserError(error) {
    if (this.isRestarting) {
      logger.debug('Already restarting, ignoring browser error');
      return;
    }

    await this.restartBrowser('error');
  }

  /**
   * Restart browser with exponential backoff
   */
  async restartBrowser(reason = 'unknown') {
    if (this.isRestarting) {
      return;
    }

    if (this.restartAttempts >= this.maxRestartAttempts) {
      logger.error('Max restart attempts reached', {
        attempts: this.restartAttempts,
        max: this.maxRestartAttempts
      });
      return;
    }

    this.isRestarting = true;
    this.restartAttempts++;

    // Calculate delay with exponential backoff
    const baseDelay = config.reconnection.initialDelay;
    const maxDelay = config.reconnection.maxDelay;
    const multiplier = config.reconnection.backoffMultiplier;
    const delay = Math.min(
      baseDelay * Math.pow(multiplier, this.restartAttempts - 1),
      maxDelay
    );

    logger.warn('Restarting browser', {
      reason,
      attempt: this.restartAttempts,
      maxAttempts: this.maxRestartAttempts,
      delayMs: delay
    });

    try {
      // Cleanup existing browser if any
      if (this.browser) {
        try {
          const pages = await this.browser.pages();
          for (const page of pages) {
            await page.close().catch(() => {});
          }
          await this.browser.close().catch(() => {});
        } catch (err) {
          logger.debug('Error closing browser during restart', { error: err.message });
        }
      }

      // Wait before restarting
      await this.sleep(delay);

      // Reinitialize client
      await this.client.initialize();
      
      this.lastRestartTime = Date.now();
      logger.info('Browser restart initiated', { attempt: this.restartAttempts });

    } catch (error) {
      logger.error('Failed to restart browser', {
        error: error.message,
        attempt: this.restartAttempts
      });
    } finally {
      this.isRestarting = false;
    }
  }

  /**
   * Cleanup zombie processes
   */
  async cleanupZombieProcesses() {
    try {
      // This would require platform-specific implementation
      // For now, we rely on Puppeteer's built-in cleanup
      logger.debug('Checking for zombie processes');
    } catch (error) {
      logger.error('Failed to cleanup zombie processes', { error: error.message });
    }
  }

  /**
   * Sleep utility
   */
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Get browser status
   */
  getStatus() {
    return {
      isRestarting: this.isRestarting,
      restartAttempts: this.restartAttempts,
      maxRestartAttempts: this.maxRestartAttempts,
      lastRestartTime: this.lastRestartTime,
      browserConnected: this.browser !== null
    };
  }
}

module.exports = BrowserManager;

