// ── Notification System — Per-User Telegram + Email ─────────────────────────
const nodemailer = require('nodemailer');
const { sendToChat } = require('./telegramBot');
require('dotenv').config();

const APP_URL = process.env.APP_URL || 'https://jobhunter-ochre.vercel.app';

// ── Email Notification ────────────────────────────────────────────────────────
async function sendEmail(to, subject, htmlContent) {
  const emailFrom = process.env.EMAIL_FROM;
  const emailPass = process.env.EMAIL_PASSWORD;

  if (!emailFrom || !emailPass) {
    console.log('⚠️  Email not configured — skipping');
    return false;
  }

  try {
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: emailFrom, pass: emailPass },
    });

    await transporter.sendMail({
      from: emailFrom,
      to: to || emailFrom,
      subject,
      html: htmlContent,
    });

    console.log(`✅ Email sent to ${to}`);
    return true;
  } catch (err) {
    console.error(`Email error (${to}):`, err.message);
    return false;
  }
}

// ── Build Daily Report Messages ──────────────────────────────────────────────
function buildDailyReport(report, userName) {
  const { jobsFound, highMatch, applied, manualApply, topJobs, date } = report;
  const dateStr = new Date(date).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' });
  const greeting = userName ? `Hi ${userName}! ` : '';

  // Telegram message
  const telegramMsg = `
🔥 *Job Hunt Report — ${dateStr}*

${greeting}Here's your daily job hunt summary:

📊 *Summary*
• Jobs Found: ${jobsFound}
• High Match (75%+): ${highMatch}
• Ready to Apply: ${manualApply}

🏆 *Top Matches Today*
${topJobs.slice(0, 5).map((j, i) =>
  `${i + 1}. *${j.title}* — ${j.company} (${j.score}% match)\n   👉 ${j.link}`
).join('\n\n')}

💡 _Open dashboard for full list & apply_
`.trim();

  // Email HTML
  const emailHtml = `
<!DOCTYPE html>
<html>
<head>
<style>
  body { font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #f5f5f5; }
  .header { background: linear-gradient(135deg, #7C3AED, #EC4899); color: white; padding: 30px; border-radius: 12px 12px 0 0; text-align: center; }
  .header h1 { margin: 0; font-size: 24px; }
  .header p  { margin: 8px 0 0; opacity: 0.85; }
  .body   { background: white; padding: 24px; }
  .stats  { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin: 20px 0; }
  .stat   { background: #f8f5ff; border: 1px solid #e9d5ff; border-radius: 8px; padding: 16px; text-align: center; }
  .stat .num { font-size: 32px; font-weight: 800; color: #7C3AED; }
  .stat .lbl { font-size: 12px; color: #6b7280; margin-top: 4px; }
  .job-card { border: 1px solid #e5e7eb; border-radius: 8px; padding: 14px; margin: 10px 0; }
  .job-card .title { font-weight: 700; color: #111827; font-size: 15px; }
  .job-card .company { color: #6b7280; font-size: 13px; margin: 2px 0; }
  .score { display: inline-block; background: #7C3AED; color: white; padding: 2px 10px; border-radius: 20px; font-size: 12px; font-weight: 700; }
  .score.high  { background: #059669; }
  .score.med   { background: #D97706; }
  .btn { display: inline-block; background: #7C3AED; color: white; padding: 10px 20px; border-radius: 8px; text-decoration: none; font-weight: 700; margin-top: 8px; }
  .footer { text-align: center; padding: 16px; color: #9ca3af; font-size: 12px; }
</style>
</head>
<body>
  <div class="header">
    <h1>🔥 Job Hunt Report</h1>
    <p>${dateStr}</p>
  </div>
  <div class="body">
    ${userName ? `<p>Hi <strong>${userName}</strong>, here's your daily summary:</p>` : ''}
    <div class="stats">
      <div class="stat"><div class="num">${jobsFound}</div><div class="lbl">Jobs Found</div></div>
      <div class="stat"><div class="num">${highMatch}</div><div class="lbl">High Matches</div></div>
      <div class="stat"><div class="num">${applied || 0}</div><div class="lbl">Applied</div></div>
      <div class="stat"><div class="num">${manualApply}</div><div class="lbl">Ready to Apply</div></div>
    </div>

    <h3>🏆 Top Matches Today</h3>
    ${topJobs.slice(0, 8).map(j => `
      <div class="job-card">
        <div class="title">${j.title}</div>
        <div class="company">${j.company}</div>
        <span class="score ${j.score >= 75 ? 'high' : 'med'}">${j.score}% match</span>
        <br/>
        <a href="${j.link}" class="btn" style="font-size:12px;padding:6px 14px;margin-top:8px;">Apply Now →</a>
      </div>
    `).join('')}

    <div style="text-align:center;margin-top:24px;">
      <a href="${APP_URL}" class="btn">Open Dashboard →</a>
    </div>
  </div>
  <div class="footer">JobHunterPro • Auto-generated daily report</div>
</body>
</html>
`.trim();

  return { telegramMsg, emailHtml };
}

// ── Send Daily Report to a specific user ─────────────────────────────────────
async function sendDailyReportToUser(report, user) {
  const prefs = user.notifications || {};
  const { telegramMsg, emailHtml } = buildDailyReport(report, user.name);
  const results = { telegram: false, email: false };

  // Send Telegram if user has it linked and enabled
  if (prefs.telegram !== false && prefs.dailyReport !== false && user.telegram?.chatId) {
    results.telegram = await sendToChat(user.telegram.chatId, telegramMsg);
  }

  // Send Email if enabled
  if (prefs.email !== false && prefs.dailyReport !== false && user.email) {
    results.email = await sendEmail(
      user.email,
      `🔥 Job Hunt Report — ${report.jobsFound} jobs found today`,
      emailHtml
    );
  }

  return results;
}

// ── Send Daily Report (backward compatible — sends to all enabled users) ─────
async function sendDailyReport(report) {
  const { User } = require('../models');

  // Find the user who owns this report
  if (report.userId) {
    const user = await User.findById(report.userId);
    if (user) {
      return sendDailyReportToUser(report, user);
    }
  }

  // Fallback: send to all admins (backward compatibility)
  const admins = await User.find({ isAdmin: true });
  for (const admin of admins) {
    await sendDailyReportToUser(report, admin);
  }
}

// ── Instant Job Alert (when a high-match job is found) ───────────────────────
async function sendInstantJobAlert(user, job) {
  const prefs = user.notifications || {};
  const minScore = prefs.minScoreAlert || 80;

  // Only send if job meets minimum score and instant alerts are enabled
  if (job.matchScore < minScore) return;
  if (prefs.instantAlerts === false) return;
  if (prefs.telegram === false || !user.telegram?.chatId) return;

  const msg = `
🔥 *New High-Match Job Found!*

*${job.title}*
🏢 ${job.company}
📍 ${job.location || 'Not specified'}
💯 Match Score: *${job.matchScore}%*
${job.salary ? `💰 ${job.salary}` : ''}
${job.isRemote ? '🏠 Remote' : ''}

👉 [Apply Now](${job.applyLink})

_Found on ${job.source}_
  `.trim();

  await sendToChat(user.telegram.chatId, msg);
}

// ── Application Reminder (jobs applied but no update in 7+ days) ─────────────
async function sendApplicationReminders() {
  const { User, Application } = require('../models');

  // Find users with reminder preference enabled
  const users = await User.find({
    'telegram.chatId': { $ne: '' },
    'notifications.telegram': { $ne: false },
    'notifications.applicationReminders': { $ne: false },
  });

  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  for (const user of users) {
    const staleApps = await Application.find({
      userId: user._id,
      status: 'applied',
      appliedAt: { $lt: sevenDaysAgo },
      updatedAt: { $lt: sevenDaysAgo },
    }).sort({ appliedAt: 1 }).limit(5);

    if (staleApps.length === 0) continue;

    const appList = staleApps.map((a, i) => {
      const daysAgo = Math.floor((Date.now() - new Date(a.appliedAt).getTime()) / (24 * 60 * 60 * 1000));
      return `${i + 1}. *${a.title}* — ${a.company} (${daysAgo} days ago)`;
    }).join('\n');

    const msg = `
⏰ *Application Follow-Up Reminder*

These applications haven't been updated in 7+ days:

${appList}

💡 *Tips:*
• Follow up with a polite email
• Check if the job posting is still active
• Mark as "ghosted" if no response after 2 weeks

_Update status in your dashboard_
    `.trim();

    await sendToChat(user.telegram.chatId, msg);
    console.log(`📬 Sent application reminder to ${user.email}`);
  }
}

// ── Weekly Digest ────────────────────────────────────────────────────────────
async function sendWeeklyDigest() {
  const { User, Job, Application, Report } = require('../models');

  const users = await User.find({
    'notifications.weeklyDigest': true,
    'telegram.chatId': { $ne: '' },
    'notifications.telegram': { $ne: false },
  });

  const oneWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  for (const user of users) {
    const [jobsThisWeek, highMatchCount, appliedCount, interviewCount] = await Promise.all([
      Job.countDocuments({ userId: user._id, foundAt: { $gte: oneWeekAgo } }),
      Job.countDocuments({ userId: user._id, foundAt: { $gte: oneWeekAgo }, matchScore: { $gte: 75 } }),
      Application.countDocuments({ userId: user._id, appliedAt: { $gte: oneWeekAgo } }),
      Application.countDocuments({ userId: user._id, status: 'interview', updatedAt: { $gte: oneWeekAgo } }),
    ]);

    const topJobs = await Job.find({ userId: user._id, foundAt: { $gte: oneWeekAgo } })
      .sort({ matchScore: -1 })
      .limit(3)
      .select('title company matchScore applyLink');

    const msg = `
📊 *Weekly Job Hunt Digest*

*This Week's Numbers:*
• New Jobs Found: *${jobsThisWeek}*
• High Matches (75%+): *${highMatchCount}*
• Applications Sent: *${appliedCount}*
• Interviews Scheduled: *${interviewCount}*

${topJobs.length > 0 ? `🏆 *Best Matches This Week*\n${topJobs.map((j, i) =>
  `${i + 1}. *${j.title}* — ${j.company} (${j.matchScore}%)\n   👉 ${j.applyLink}`
).join('\n\n')}` : '📭 No new high matches this week.'}

💪 _Keep going! Consistency is key._
    `.trim();

    await sendToChat(user.telegram.chatId, msg);
    console.log(`📊 Sent weekly digest to ${user.email}`);
  }
}

module.exports = {
  sendDailyReport,
  sendDailyReportToUser,
  sendInstantJobAlert,
  sendApplicationReminders,
  sendWeeklyDigest,
  sendEmail,
  buildDailyReport,
};
