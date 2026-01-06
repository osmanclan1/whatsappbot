const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const logger = require('./logger');
const config = require('./config');
const cron = require('node-cron');

class BackupManager {
  constructor() {
    this.backupDir = config.backup.directory;
    this.sessionDir = '.wwebjs_auth';
    this.ensureBackupDirectory();
  }

  /**
   * Ensure backup directory exists
   */
  ensureBackupDirectory() {
    if (!fs.existsSync(this.backupDir)) {
      fs.mkdirSync(this.backupDir, { recursive: true });
      logger.info('Created backup directory', { path: this.backupDir });
    }
  }

  /**
   * Create a backup of the session directory
   */
  async createBackup() {
    if (!fs.existsSync(this.sessionDir)) {
      logger.warn('Session directory not found, skipping backup', { path: this.sessionDir });
      return null;
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupFileName = `whatsapp-session-${timestamp}.tar.gz`;
    const backupPath = path.join(this.backupDir, backupFileName);

    try {
      logger.info('Creating session backup', { backupPath });

      // Create tar.gz archive
      execSync(`tar -czf "${backupPath}" -C . "${this.sessionDir}"`, {
        stdio: 'ignore'
      });

      const stats = fs.statSync(backupPath);
      logger.info('Backup created successfully', {
        path: backupPath,
        size: `${(stats.size / 1024 / 1024).toFixed(2)} MB`
      });

      // Cleanup old backups
      this.cleanupOldBackups();

      return backupPath;
    } catch (error) {
      logger.error('Failed to create backup', {
        error: error.message,
        stack: error.stack
      });
      throw error;
    }
  }

  /**
   * Cleanup old backups based on retention policy
   */
  cleanupOldBackups() {
    try {
      const files = fs.readdirSync(this.backupDir)
        .filter(file => file.startsWith('whatsapp-session-') && file.endsWith('.tar.gz'))
        .map(file => ({
          name: file,
          path: path.join(this.backupDir, file),
          mtime: fs.statSync(path.join(this.backupDir, file)).mtime
        }))
        .sort((a, b) => b.mtime - a.mtime); // Newest first

      const retentionDays = config.backup.retentionDays;
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - retentionDays);

      let deletedCount = 0;
      for (const file of files) {
        if (file.mtime < cutoffDate) {
          fs.unlinkSync(file.path);
          deletedCount++;
          logger.debug('Deleted old backup', { file: file.name, age: file.mtime });
        }
      }

      if (deletedCount > 0) {
        logger.info('Cleaned up old backups', { deletedCount, retentionDays });
      }
    } catch (error) {
      logger.error('Failed to cleanup old backups', { error: error.message });
    }
  }

  /**
   * Restore from backup
   * @param {string} backupFileName - Name of backup file to restore
   */
  async restoreBackup(backupFileName) {
    const backupPath = path.join(this.backupDir, backupFileName);

    if (!fs.existsSync(backupPath)) {
      throw new Error(`Backup file not found: ${backupFileName}`);
    }

    try {
      logger.info('Restoring from backup', { backupPath });

      // Remove existing session directory if it exists
      if (fs.existsSync(this.sessionDir)) {
        fs.rmSync(this.sessionDir, { recursive: true, force: true });
        logger.info('Removed existing session directory');
      }

      // Extract backup
      execSync(`tar -xzf "${backupPath}"`, {
        stdio: 'ignore',
        cwd: process.cwd()
      });

      logger.info('Backup restored successfully', { backupPath });
      return true;
    } catch (error) {
      logger.error('Failed to restore backup', {
        error: error.message,
        stack: error.stack
      });
      throw error;
    }
  }

  /**
   * List available backups
   */
  listBackups() {
    try {
      const files = fs.readdirSync(this.backupDir)
        .filter(file => file.startsWith('whatsapp-session-') && file.endsWith('.tar.gz'))
        .map(file => {
          const filePath = path.join(this.backupDir, file);
          const stats = fs.statSync(filePath);
          return {
            name: file,
            path: filePath,
            size: stats.size,
            created: stats.mtime,
            sizeFormatted: `${(stats.size / 1024 / 1024).toFixed(2)} MB`
          };
        })
        .sort((a, b) => b.created - a.created); // Newest first

      return files;
    } catch (error) {
      logger.error('Failed to list backups', { error: error.message });
      return [];
    }
  }

  /**
   * Start scheduled backups
   */
  startScheduledBackups() {
    if (!config.backup.enabled) {
      logger.info('Backup scheduling disabled');
      return;
    }

    const schedule = config.backup.schedule;
    if (!cron.validate(schedule)) {
      logger.error('Invalid backup schedule', { schedule });
      return;
    }

    logger.info('Starting scheduled backups', { schedule });

    cron.schedule(schedule, async () => {
      try {
        await this.createBackup();
      } catch (error) {
        logger.error('Scheduled backup failed', { error: error.message });
      }
    });

    // Create initial backup
    this.createBackup().catch(err => {
      logger.error('Initial backup failed', { error: err.message });
    });
  }
}

module.exports = BackupManager;

