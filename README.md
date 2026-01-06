# WhatsApp API - Production Ready

A production-ready Node.js application for interacting with WhatsApp using the `whatsapp-web.js` library. Features 24/7 reliability, automatic reconnection, scheduled messaging, rate limiting, health monitoring, and comprehensive logging.

## Features

### Core Functionality
- **QR Code Authentication**: Scan QR code to link your WhatsApp account
- **Send Messages**: Send text messages to any WhatsApp number with rate limiting
- **Receive Messages**: Listen and log incoming messages
- **Session Persistence**: Save authentication session to avoid re-scanning QR code

### Production Features
- **24/7 Reliability**: Auto-restart on server/Puppeteer/browser crashes
- **Scheduled Messaging**: Automated hourly/daily messaging with cron scheduling
- **Rate Limiting**: Prevent WhatsApp bans with configurable rate limits
- **Health Monitoring**: Track connection status, memory usage, and message rates
- **Alert System**: Notifications for critical failures
- **Structured Logging**: Winston-based logging with rotation
- **Session Backups**: Automated daily backups of authentication data
- **Browser Management**: Automatic browser/Puppeteer restart on crashes

## Prerequisites

- Node.js (v18 or higher)
- npm (Node Package Manager)
- WhatsApp mobile app installed on your phone
- For server deployment: Ubuntu 22.04 LTS (or similar Linux distribution)

## Installation

1. Clone or download this repository
2. Install dependencies:
```bash
npm install
```

3. Copy environment variables template:
```bash
cp .env.example .env
```

4. Edit `.env` file with your configuration (see Configuration section)

## Configuration

### Environment Variables

Create a `.env` file in the project root. See `.env.example` for all available options.

**Key Settings:**

```env
# Rate Limiting
RATE_LIMIT_PER_MINUTE=20
RATE_LIMIT_PER_HOUR=500

# Scheduled Messaging (JSON format)
SCHEDULES=[{"id":"hourly-1","recipient":"1234567890@c.us","message":"Hourly update","cron":"0 * * * *","enabled":true,"timezone":"America/New_York"}]
```

### Scheduled Messaging Configuration

To set up hourly messaging to 1 person, add to your `.env`:

```env
SCHEDULES=[{"id":"hourly-person-1","recipient":"YOUR_NUMBER@c.us","message":"Your hourly message","cron":"0 * * * *","enabled":true,"timezone":"America/New_York"}]
```

**Cron Format:** `minute hour day month weekday`
- `0 * * * *` - Every hour at minute 0
- `0 9 * * *` - Daily at 9 AM
- `0 9 * * 1-5` - Weekdays at 9 AM

## Usage

### Local Development

1. Start the application:
```bash
npm start
```

2. Scan the QR code with your WhatsApp mobile app:
   - Go to **Settings** → **Linked Devices**
   - Tap **Link a Device**
   - Scan the QR code displayed in your terminal

3. Once connected, the application will:
   - Log all incoming messages
   - Execute scheduled messages
   - Monitor health and send alerts

### Sending Messages Programmatically

```javascript
const { sendMessage } = require('./index');

// Send a message
await sendMessage('1234567890@c.us', 'Hello from WhatsApp API!');
```

**Phone Number Format:** `countrycode+number@c.us` (no +, spaces, or dashes)
- US: `+1 (555) 123-4567` → `15551234567@c.us`
- UK: `+44 20 1234 5678` → `442012345678@c.us`

## AWS EC2 Deployment

### Step 1: Create EC2 Instance

1. Go to AWS Console → EC2 → Launch Instance
2. **AMI**: Select Ubuntu 22.04 LTS
3. **Instance Type**: t2.small or t3.small (2GB RAM minimum)
4. **Storage**: 20GB minimum
5. **Security Group**: 
   - Allow SSH (port 22) from your IP
   - No need to expose WhatsApp ports
6. **Key Pair**: Create or select existing key pair
7. Launch instance and note the public IP

### Step 2: Initial Server Setup

1. SSH into your EC2 instance:
```bash
ssh -i your-key.pem ubuntu@your-ec2-ip
```

2. Run the EC2 setup script:
```bash
# Upload the script or clone the repository
git clone <your-repo-url>
cd whatsapp
chmod +x scripts/ec2-setup.sh
sudo ./scripts/ec2-setup.sh
```

This will install:
- Node.js 18.x
- PM2 process manager
- Puppeteer/Chrome dependencies
- Configure firewall
- Set up swap space

### Step 3: Deploy Application

1. Upload your application files to EC2 (or clone repository)
2. Install dependencies:
```bash
cd ~/whatsapp
npm install
```

3. Configure environment:
```bash
cp .env.example .env
nano .env  # Edit with your settings
```

4. First-time authentication:
```bash
npm start
# Scan QR code when it appears
# Press Ctrl+C after authentication
```

### Step 4: Production Setup with PM2

1. Start with PM2:
```bash
pm2 start ecosystem.config.js
```

2. Configure PM2 to start on system boot:
```bash
pm2 startup systemd
# Follow the instructions shown
pm2 save
```

3. Check status:
```bash
pm2 status
pm2 logs whatsapp-bot
```

### Step 5: Verify Resilience

Test that everything works after restarts:

1. **Server Restart Test:**
```bash
sudo reboot
# After reboot, SSH back in and verify:
pm2 status  # Should show whatsapp-bot as online
```

2. **Check Logs:**
```bash
pm2 logs whatsapp-bot
tail -f logs/application-*.log
```

## PM2 Management

```bash
# View status
pm2 status

# View logs
pm2 logs whatsapp-bot

# Restart
pm2 restart whatsapp-bot

# Stop
pm2 stop whatsapp-bot

# Delete
pm2 delete whatsapp-bot

# Monitor
pm2 monit
```

## Backup and Restore

### Automatic Backups

Backups run automatically daily (configurable in `.env`). Backups are stored in `./backups/` directory.

### Manual Backup

```bash
./scripts/backup-session.sh
```

### Restore from Backup

```bash
# List available backups
ls backups/

# Restore
./scripts/restore-session.sh whatsapp-session-2024-01-01-020000.tar.gz
```

## Monitoring and Logs

### Log Files

- `logs/application-YYYY-MM-DD.log` - General application logs
- `logs/error-YYYY-MM-DD.log` - Error logs only
- `logs/pm2-out.log` - PM2 stdout
- `logs/pm2-error.log` - PM2 stderr

### Health Monitoring

The application continuously monitors:
- Connection status
- Memory usage
- CPU usage
- Message send/receive rates
- Error rates

### Alerts

Alerts are triggered for:
- Connection lost > 5 minutes
- Memory usage > 80%
- High error rate (> 10 errors/minute)
- Authentication failures
- Session expiration

Check alerts in log files or configure email/webhook notifications.

## Scheduled Messaging

### Configuration

Add schedules in `.env` file:

```env
SCHEDULES=[
  {
    "id": "hourly-person-1",
    "recipient": "1234567890@c.us",
    "message": "Your hourly update message",
    "cron": "0 * * * *",
    "enabled": true,
    "timezone": "America/New_York"
  }
]
```

### Features

- **Cron-based scheduling**: Use standard cron expressions
- **Timezone support**: Schedule messages in specific timezones
- **Rate limit compliance**: Automatically respects rate limits
- **Persistence**: Schedules survive server restarts
- **Error handling**: Failed messages are logged and can be retried

## Rate Limiting

The application includes built-in rate limiting to prevent WhatsApp bans:

- **Global limits**: 20 messages/minute, 500 messages/hour (configurable)
- **Per-recipient limits**: 10 messages/minute per recipient (configurable)
- **Queue system**: Rate-limited messages are queued and sent when allowed
- **Automatic retry**: Queued messages are processed automatically

## Safety Features

1. **Rate Limiting**: Prevents spam and WhatsApp bans
2. **Input Validation**: Sanitizes phone numbers and messages
3. **Error Recovery**: Automatic reconnection with exponential backoff
4. **Resource Management**: Memory and CPU monitoring
5. **Session Backup**: Daily automated backups
6. **Graceful Shutdown**: Proper cleanup on termination
7. **Health Checks**: Continuous monitoring
8. **Alert System**: Critical failure notifications

## Troubleshooting

### QR Code Not Appearing
- Ensure terminal supports QR code display
- Check that the application has write permissions

### Connection Issues
- Verify your phone has internet connection
- Ensure WhatsApp is running on your phone
- Check server network connectivity

### Authentication Errors
- Delete `.wwebjs_auth/` folder and re-scan QR code
- Check logs for specific error messages
- Verify session backup is not corrupted

### High Memory Usage
- Monitor with `pm2 monit`
- Check for memory leaks in logs
- Consider upgrading instance size

### Scheduled Messages Not Sending
- Check schedule is enabled in configuration
- Verify cron expression is valid
- Check rate limiter isn't blocking
- Review logs for errors

### PM2 Not Starting on Boot
- Run `pm2 startup systemd` again
- Verify the generated command was executed
- Check systemd service status: `systemctl status pm2-<user>`

## File Structure

```
whatsapp/
├── index.js                 # Main application
├── config.js                # Configuration management
├── logger.js                # Winston logger setup
├── health.js                # Health monitoring
├── alerts.js                # Alert system
├── rateLimiter.js          # Rate limiting
├── scheduler.js             # Scheduled messaging
├── backup.js                # Session backup
├── browserManager.js        # Browser/Puppeteer management
├── ecosystem.config.js      # PM2 configuration
├── package.json             # Dependencies
├── .env.example            # Environment template
├── scripts/
│   ├── ec2-setup.sh        # EC2 setup script
│   ├── setup.sh            # Generic setup
│   ├── deploy.sh            # Deployment
│   ├── backup-session.sh   # Manual backup
│   └── restore-session.sh   # Restore backup
├── logs/                    # Log files
└── backups/                 # Session backups
```

## Technical Notes

- Uses WhatsApp Web protocol (not official Business API)
- Requires active WhatsApp mobile app connection
- Session data stored in `.wwebjs_auth/` (excluded from git)
- Suitable for personal projects and production use
- Designed for 24/7 operation on servers/VPS

## License

ISC

## Support

For issues and questions:
1. Check logs in `logs/` directory
2. Review PM2 logs: `pm2 logs whatsapp-bot`
3. Check health status in logs
4. Review troubleshooting section above
