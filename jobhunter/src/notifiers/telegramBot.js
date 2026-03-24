// ── Telegram Bot — Per-User Linking & Notifications ─────────────────────────
// Users connect their Telegram by:
// 1. Clicking "Connect Telegram" in dashboard → generates a unique 6-digit code
// 2. Sending that code to the bot → bot links their Telegram chatId to their account
// 3. From then on, they receive personalized notifications

const axios = require('axios');
require('dotenv').config();

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const API_BASE  = `https://api.telegram.org/bot${BOT_TOKEN}`;

// ── Send message to a specific chat ──────────────────────────────────────────
async function sendToChat(chatId, message, options = {}) {
  if (!BOT_TOKEN || !chatId) return false;
  try {
    await axios.post(`${API_BASE}/sendMessage`, {
      chat_id: chatId,
      text: message,
      parse_mode: options.parseMode || 'Markdown',
      disable_web_page_preview: options.disablePreview ?? true,
    });
    return true;
  } catch (err) {
    console.error(`Telegram send error (chat ${chatId}):`, err.response?.data?.description || err.message);
    return false;
  }
}

// ── Send message with inline buttons ─────────────────────────────────────────
async function sendWithButtons(chatId, message, buttons) {
  if (!BOT_TOKEN || !chatId) return false;
  try {
    await axios.post(`${API_BASE}/sendMessage`, {
      chat_id: chatId,
      text: message,
      parse_mode: 'Markdown',
      disable_web_page_preview: true,
      reply_markup: {
        inline_keyboard: buttons,
      },
    });
    return true;
  } catch (err) {
    console.error(`Telegram button send error (chat ${chatId}):`, err.response?.data?.description || err.message);
    return false;
  }
}

// ── Process incoming updates (webhook or polling) ────────────────────────────
async function processUpdate(update, User) {
  if (!update.message) return;

  const chatId   = String(update.message.chat.id);
  const text     = (update.message.text || '').trim();
  const username = update.message.from?.username || '';
  const firstName = update.message.from?.first_name || '';

  // Handle /start command
  if (text === '/start') {
    await sendToChat(chatId, `
*Welcome to JobHunter Pro Bot!* 🔥

I'll send you personalized job alerts based on your resume.

*How to connect:*
1. Go to your JobHunter dashboard
2. Click *Settings* → *Connect Telegram*
3. Copy the 6-digit code
4. Send it to me here

*Commands:*
/status — Check your connection status
/pause — Pause notifications
/resume — Resume notifications
/settings — View notification preferences
/help — Show this message
    `.trim());
    return;
  }

  // Handle /help command
  if (text === '/help') {
    await sendToChat(chatId, `
*JobHunter Pro Bot Commands* 🤖

/start — Welcome message
/status — Check connection & notification status
/pause — Pause all notifications
/resume — Resume notifications
/settings — View your notification preferences
/stats — Your job hunt stats
/top — Show today's top 5 job matches
/help — Show this message

💡 _Send your 6-digit link code to connect your account_
    `.trim());
    return;
  }

  // Handle /status command
  if (text === '/status') {
    const user = await User.findOne({ 'telegram.chatId': chatId });
    if (user) {
      const prefs = user.notifications || {};
      await sendToChat(chatId, `
*Connected!* ✅

*Account:* ${user.email}
*Name:* ${user.name || 'Not set'}
*Linked:* ${user.telegram.linkedAt ? new Date(user.telegram.linkedAt).toLocaleDateString('en-IN') : 'Unknown'}

*Notifications:*
• Daily Report: ${prefs.dailyReport !== false ? '✅' : '❌'}
• Instant Alerts: ${prefs.instantAlerts !== false ? '✅' : '❌'}
• Application Reminders: ${prefs.applicationReminders !== false ? '✅' : '❌'}
• Min Score Alert: ${prefs.minScoreAlert || 80}%+
      `.trim());
    } else {
      await sendToChat(chatId, '❌ *Not connected.* Send your 6-digit link code from the dashboard to connect.');
    }
    return;
  }

  // Handle /pause command
  if (text === '/pause') {
    const user = await User.findOneAndUpdate(
      { 'telegram.chatId': chatId },
      { 'notifications.telegram': false },
      { new: true }
    );
    if (user) {
      await sendToChat(chatId, '⏸ *Notifications paused.* Send /resume to turn them back on.');
    } else {
      await sendToChat(chatId, '❌ Account not linked. Send your 6-digit code first.');
    }
    return;
  }

  // Handle /resume command
  if (text === '/resume') {
    const user = await User.findOneAndUpdate(
      { 'telegram.chatId': chatId },
      { 'notifications.telegram': true },
      { new: true }
    );
    if (user) {
      await sendToChat(chatId, '▶️ *Notifications resumed!* You\'ll receive alerts again.');
    } else {
      await sendToChat(chatId, '❌ Account not linked. Send your 6-digit code first.');
    }
    return;
  }

  // Handle /settings command
  if (text === '/settings') {
    const user = await User.findOne({ 'telegram.chatId': chatId });
    if (!user) {
      await sendToChat(chatId, '❌ Account not linked.');
      return;
    }
    const p = user.notifications || {};
    await sendToChat(chatId, `
*Your Notification Settings* ⚙️

• *Telegram:* ${p.telegram !== false ? 'ON' : 'OFF'}
• *Email:* ${p.email !== false ? 'ON' : 'OFF'}
• *Daily Report:* ${p.dailyReport !== false ? 'ON' : 'OFF'}
• *Instant High-Match Alerts:* ${p.instantAlerts !== false ? 'ON' : 'OFF'}
• *Weekly Digest:* ${p.weeklyDigest ? 'ON' : 'OFF'}
• *Application Reminders:* ${p.applicationReminders !== false ? 'ON' : 'OFF'}
• *Min Score for Alerts:* ${p.minScoreAlert || 80}%

_Change these in your dashboard under Settings → Notifications_
    `.trim());
    return;
  }

  // Handle /stats command
  if (text === '/stats') {
    const user = await User.findOne({ 'telegram.chatId': chatId });
    if (!user) {
      await sendToChat(chatId, '❌ Account not linked.');
      return;
    }
    try {
      const { Job, Application } = require('../models');
      const uid = user._id;
      const [totalJobs, highMatch, applied, interviews, offers] = await Promise.all([
        Job.countDocuments({ userId: uid }),
        Job.countDocuments({ userId: uid, matchScore: { $gte: 75 } }),
        Application.countDocuments({ userId: uid, status: 'applied' }),
        Application.countDocuments({ userId: uid, status: 'interview' }),
        Application.countDocuments({ userId: uid, status: 'offer' }),
      ]);
      await sendToChat(chatId, `
*Your Job Hunt Stats* 📊

• Total Jobs Found: *${totalJobs}*
• High Matches (75%+): *${highMatch}*
• Applied: *${applied}*
• Interviews: *${interviews}*
• Offers: *${offers}*

_Run a hunt from your dashboard to find more jobs!_
      `.trim());
    } catch (err) {
      await sendToChat(chatId, '⚠️ Could not fetch stats. Try again later.');
    }
    return;
  }

  // Handle /top command
  if (text === '/top') {
    const user = await User.findOne({ 'telegram.chatId': chatId });
    if (!user) {
      await sendToChat(chatId, '❌ Account not linked.');
      return;
    }
    try {
      const { Job } = require('../models');
      const topJobs = await Job.find({ userId: user._id })
        .sort({ matchScore: -1 })
        .limit(5)
        .select('title company matchScore applyLink source');

      if (topJobs.length === 0) {
        await sendToChat(chatId, '📭 No jobs found yet. Run a hunt from your dashboard first!');
        return;
      }

      const jobList = topJobs.map((j, i) =>
        `${i + 1}. *${j.title}* — ${j.company}\n   Score: ${j.matchScore}% | ${j.source}\n   👉 ${j.applyLink}`
      ).join('\n\n');

      await sendToChat(chatId, `*Your Top 5 Matches* 🏆\n\n${jobList}`);
    } catch (err) {
      await sendToChat(chatId, '⚠️ Could not fetch jobs. Try again later.');
    }
    return;
  }

  // Handle 6-digit link code
  const codeMatch = text.match(/^(\d{6})$/);
  if (codeMatch) {
    const code = codeMatch[1];
    const user = await User.findOne({
      'telegram.linkToken': code,
      'telegram.linkExpires': { $gt: new Date() },
    });

    if (!user) {
      await sendToChat(chatId, '❌ *Invalid or expired code.* Generate a new one from your dashboard.');
      return;
    }

    // Link the account
    user.telegram.chatId = chatId;
    user.telegram.username = username;
    user.telegram.linkedAt = new Date();
    user.telegram.linkToken = '';  // Clear the token
    user.telegram.linkExpires = null;
    await user.save();

    await sendToChat(chatId, `
✅ *Account linked successfully!*

Welcome, *${user.name || user.email}*! 🎉

You'll now receive:
• 📊 Daily job hunt reports
• 🔥 Instant alerts for high-match jobs (${user.notifications?.minScoreAlert || 80}%+)
• ⏰ Application follow-up reminders

Use /settings to check your preferences or /pause to mute notifications.
    `.trim());
    return;
  }

  // Unknown input
  await sendToChat(chatId, '🤔 I didn\'t understand that. Send /help for available commands, or send your 6-digit link code to connect your account.');
}

// ── Polling mode (for local development) ─────────────────────────────────────
let pollingOffset = 0;
let pollingActive = false;

async function startPolling(User) {
  if (!BOT_TOKEN) {
    console.log('⚠️  Telegram bot not configured — skipping polling');
    return;
  }
  if (pollingActive) return;
  pollingActive = true;
  console.log('🤖 Telegram bot polling started');

  while (pollingActive) {
    try {
      const res = await axios.get(`${API_BASE}/getUpdates`, {
        params: { offset: pollingOffset, timeout: 30 },
        timeout: 35000,
      });

      const updates = res.data?.result || [];
      for (const update of updates) {
        pollingOffset = update.update_id + 1;
        await processUpdate(update, User);
      }
    } catch (err) {
      if (err.code !== 'ECONNABORTED') {
        console.error('Telegram polling error:', err.message);
      }
      // Wait before retrying on error
      await new Promise(r => setTimeout(r, 5000));
    }
  }
}

function stopPolling() {
  pollingActive = false;
}

// ── Webhook handler (for Vercel/production) ──────────────────────────────────
async function handleWebhook(req, User) {
  if (req.body) {
    await processUpdate(req.body, User);
  }
}

// ── Setup webhook URL ────────────────────────────────────────────────────────
async function setWebhook(url) {
  if (!BOT_TOKEN) return;
  try {
    await axios.post(`${API_BASE}/setWebhook`, { url });
    console.log(`✅ Telegram webhook set to: ${url}`);
  } catch (err) {
    console.error('Failed to set webhook:', err.message);
  }
}

// ── Remove webhook (for switching to polling) ────────────────────────────────
async function deleteWebhook() {
  if (!BOT_TOKEN) return;
  try {
    await axios.post(`${API_BASE}/deleteWebhook`);
    console.log('✅ Telegram webhook removed');
  } catch (err) {
    console.error('Failed to delete webhook:', err.message);
  }
}

module.exports = {
  sendToChat,
  sendWithButtons,
  processUpdate,
  handleWebhook,
  startPolling,
  stopPolling,
  setWebhook,
  deleteWebhook,
};
