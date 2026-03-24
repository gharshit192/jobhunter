require('dotenv').config();
const express   = require('express');
const mongoose  = require('mongoose');
const cors      = require('cors');
const path      = require('path');
const routes    = require('./routes');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Connect MongoDB ───────────────────────────────────────────────────────────
async function connectDB() {
  try {
    const uri = process.env.MONGODB_URI || 'mongodb://localhost:27017/jobhunter';
    const opts = uri.includes('mongodb+srv') ? { tls: true, tlsAllowInvalidCertificates: true } : {};
    await mongoose.connect(uri, opts);
    console.log('✅ MongoDB connected');
  } catch (err) {
    console.error('❌ MongoDB connection failed:', err.message);
  }
}

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());

// ── Lazy DB connection for serverless ─────────────────────────────────────────
let dbConnected = false;
app.use('/api', async (req, res, next) => {
  if (!dbConnected && mongoose.connection.readyState === 0) {
    await connectDB();
    dbConnected = true;
  }
  next();
});

app.use(express.static(path.join(__dirname, '../public')));

// ── API Routes ────────────────────────────────────────────────────────────────
app.use('/api', routes);

// ── Telegram Webhook (public endpoint — Telegram sends updates here) ─────────
app.post('/api/telegram/webhook', async (req, res) => {
  try {
    const { handleWebhook } = require('./notifiers/telegramBot');
    const { User } = require('./models');
    await handleWebhook(req, User);
    res.sendStatus(200);
  } catch (err) {
    console.error('Telegram webhook error:', err.message);
    res.sendStatus(200); // Always 200 to prevent Telegram retries
  }
});

// ── Serve Dashboard ───────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// ── Cron Scheduler ────────────────────────────────────────────────────────────
if (!process.env.VERCEL) {
  const cron = require('node-cron');
  const { runJobHunt } = require('./runner');
  const { sendApplicationReminders, sendWeeklyDigest } = require('./notifiers/notifier');
  const { User } = require('./models');

  // Daily job hunt at 8:00 AM IST — runs for ALL users with a resume
  cron.schedule('0 8 * * *', async () => {
    console.log('⏰ Cron triggered — starting daily job hunt for all users');
    try {
      const users = await User.find();
      for (const user of users) {
        try {
          await runJobHunt(user._id, true); // true = send notifications
        } catch (err) {
          console.error(`Hunt failed for ${user.email}:`, err.message);
        }
      }
    } catch (err) {
      console.error('Cron run failed:', err.message);
    }
  }, { timezone: 'Asia/Kolkata' });

  // Application reminders at 10:00 AM IST — Mon/Wed/Fri
  cron.schedule('0 10 * * 1,3,5', async () => {
    console.log('⏰ Sending application follow-up reminders');
    try {
      await sendApplicationReminders();
    } catch (err) {
      console.error('Reminder cron failed:', err.message);
    }
  }, { timezone: 'Asia/Kolkata' });

  // Weekly digest at 9:00 AM IST on Sundays
  cron.schedule('0 9 * * 0', async () => {
    console.log('⏰ Sending weekly digest');
    try {
      await sendWeeklyDigest();
    } catch (err) {
      console.error('Weekly digest cron failed:', err.message);
    }
  }, { timezone: 'Asia/Kolkata' });
}

// ── Start Server (local only) ────────────────────────────────────────────────
if (!process.env.VERCEL) {
  (async () => {
    await connectDB();
    dbConnected = true;

    // Start Telegram bot polling (local dev only — use webhook in production)
    const { deleteWebhook, startPolling } = require('./notifiers/telegramBot');
    const { User } = require('./models');
    await deleteWebhook(); // Remove any existing webhook so polling works
    startPolling(User);

    app.listen(PORT, () => {
      console.log(`\n🚀 JobHunter Pro running at http://localhost:${PORT}`);
      console.log(`📊 Dashboard: http://localhost:${PORT}`);
      console.log(`🔌 API:       http://localhost:${PORT}/api/jobs`);
      console.log(`🤖 Telegram:  Bot polling active`);
      console.log(`⏰ Cron:      Daily at 8:00 AM IST\n`);
    });
  })();
}

module.exports = app;
