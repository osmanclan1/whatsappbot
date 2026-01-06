const cron = require('node-cron');
const logger = require('./logger');
const config = require('./config');
const rateLimiter = require('./rateLimiter');

class Scheduler {
  constructor(sendMessageFn) {
    this.sendMessageFn = sendMessageFn;
    this.jobs = new Map();
    this.isRunning = false;
  }

  /**
   * Initialize and start all scheduled jobs
   */
  start() {
    if (this.isRunning) {
      logger.warn('Scheduler already running');
      return;
    }

    logger.info('Initializing scheduler', { scheduleCount: config.schedules.length });

    for (const schedule of config.schedules) {
      if (schedule.enabled) {
        this.addSchedule(schedule);
      } else {
        logger.debug('Schedule disabled, skipping', { id: schedule.id });
      }
    }

    this.isRunning = true;
    logger.info('Scheduler started', { activeJobs: this.jobs.size });
  }

  /**
   * Add a new schedule
   * @param {Object} schedule - Schedule configuration
   */
  addSchedule(schedule) {
    // Support both single recipient (string) or multiple recipients (array)
    const hasRecipient = schedule.recipient || (schedule.recipients && schedule.recipients.length > 0);
    
    if (!schedule.id || !hasRecipient || !schedule.message || !schedule.cron) {
      logger.error('Invalid schedule configuration', { schedule });
      return;
    }

    // Validate cron expression
    if (!cron.validate(schedule.cron)) {
      logger.error('Invalid cron expression', { id: schedule.id, cron: schedule.cron });
      return;
    }

    // Remove existing job if any
    if (this.jobs.has(schedule.id)) {
      this.removeSchedule(schedule.id);
    }

    // Set timezone if specified
    const options = schedule.timezone ? { timezone: schedule.timezone } : {};

    // Create cron job
    const job = cron.schedule(schedule.cron, async () => {
      await this.executeSchedule(schedule);
    }, {
      scheduled: true,
      ...options
    });

    // Normalize recipients to array for logging
    const recipients = schedule.recipients || [schedule.recipient];
    
    this.jobs.set(schedule.id, { job, schedule });
    logger.schedule('Schedule added', {
      id: schedule.id,
      recipients: recipients,
      recipientCount: recipients.length,
      cron: schedule.cron,
      timezone: schedule.timezone || 'system default'
    });
  }

  /**
   * Remove a schedule
   * @param {string} scheduleId - Schedule ID
   */
  removeSchedule(scheduleId) {
    const jobData = this.jobs.get(scheduleId);
    if (jobData) {
      jobData.job.stop();
      jobData.job.destroy();
      this.jobs.delete(scheduleId);
      logger.schedule('Schedule removed', { id: scheduleId });
    }
  }

  /**
   * Execute a scheduled message
   * @param {Object} schedule - Schedule configuration
   */
  async executeSchedule(schedule) {
    // Support both single recipient and multiple recipients
    const recipients = schedule.recipients || [schedule.recipient];
    
    logger.schedule('Executing scheduled message', {
      id: schedule.id,
      recipientCount: recipients.length,
      recipients: recipients
    });

    let successCount = 0;
    let failCount = 0;

    for (const recipient of recipients) {
      try {
        // Check rate limiter
        const rateCheck = rateLimiter.canSend(recipient);
        
        if (!rateCheck.allowed) {
          logger.warn('Scheduled message rate limited, will retry', {
            id: schedule.id,
            recipient: recipient,
            reason: rateCheck.reason,
            waitTime: rateCheck.waitTime
          });

          // Queue the message
          await rateLimiter.queueMessage(
            recipient,
            schedule.message,
            async () => {
              await this.sendMessageFn(recipient, schedule.message);
            }
          );
          failCount++;
          continue;
        }

        // Send message
        await this.sendMessageFn(recipient, schedule.message);
        rateLimiter.recordSent(recipient);
        successCount++;
        
        logger.schedule('Scheduled message sent successfully', {
          id: schedule.id,
          recipient: recipient
        });

        // Small delay between recipients to respect rate limits
        if (recipients.indexOf(recipient) < recipients.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 3000)); // 3 second delay
        }
      } catch (error) {
        failCount++;
        logger.error('Failed to execute scheduled message', {
          id: schedule.id,
          recipient: recipient,
          error: error.message,
          stack: error.stack
        });
      }
    }

    logger.schedule('Scheduled batch completed', {
      id: schedule.id,
      successCount: successCount,
      failCount: failCount,
      total: recipients.length
    });
  }

  /**
   * Stop all schedules
   */
  stop() {
    for (const [id, jobData] of this.jobs.entries()) {
      jobData.job.stop();
      jobData.job.destroy();
    }
    this.jobs.clear();
    this.isRunning = false;
    logger.info('Scheduler stopped');
  }

  /**
   * Get all active schedules
   */
  getSchedules() {
    return Array.from(this.jobs.values()).map(jobData => ({
      id: jobData.schedule.id,
      recipient: jobData.schedule.recipient,
      cron: jobData.schedule.cron,
      enabled: true,
      timezone: jobData.schedule.timezone
    }));
  }
}

module.exports = Scheduler;

