// ── Vercel Cron Endpoint ─────────────────────────────────────────────────────
// Runs daily at 8:00 AM IST (2:30 AM UTC) via vercel.json crons config
// Triggers job hunt for ALL users and sends notifications

const mongoose = require('mongoose');
require('dotenv').config();

async function connectDB() {
  if (mongoose.connection.readyState === 1) return;
  const uri = process.env.MONGODB_URI || 'mongodb://localhost:27017/jobhunter';
  const opts = uri.includes('mongodb+srv') ? { tls: true, tlsAllowInvalidCertificates: true } : {};
  await mongoose.connect(uri, opts);
}

module.exports = async (req, res) => {
  // Verify cron secret (Vercel sends this header for cron jobs)
  const authHeader = req.headers['authorization'];
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}` && !process.env.VERCEL) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    await connectDB();

    const { User, Resume, Job, Report } = require('../src/models');
    const { fetchRemotive, fetchArbeitnow, fetchHimalayas, fetchJobicy } = require('../src/scrapers/jobScraper');
    const { matchJobs } = require('../src/matchers/jobMatcher');
    const { sendDailyReport, sendInstantJobAlert, sendApplicationReminders } = require('../src/notifiers/notifier');

    const users = await User.find();
    const results = [];

    for (const user of users) {
      try {
        // Get user's resume
        const resumeProfile = await Resume.findOne({ userId: user._id }).lean();
        if (!resumeProfile) {
          results.push({ user: user.email, status: 'skipped', reason: 'no resume' });
          continue;
        }

        // Build keywords from resume
        const skills = resumeProfile.skills.slice(0, 5);
        const roles = resumeProfile.roles.slice(0, 3);
        const keywords = [...roles, ...skills.slice(0, 3)].filter(Boolean);

        // Scrape jobs from API sources
        const scrapeResults = await Promise.allSettled([
          fetchRemotive(keywords),
          fetchArbeitnow(keywords),
          fetchHimalayas(keywords),
          fetchJobicy(keywords),
        ]);

        let allJobs = [];
        scrapeResults.forEach(r => { if (r.status === 'fulfilled') allJobs.push(...r.value); });

        // Dedup
        const seen = new Set();
        const unique = allJobs.filter(j => { if (seen.has(j.jobId)) return false; seen.add(j.jobId); return true; });

        // Score
        const scored = matchJobs(unique, resumeProfile);

        // Save to DB
        let saved = 0;
        for (const job of scored) {
          try {
            await Job.findOneAndUpdate(
              { jobId: job.jobId, userId: user._id },
              { ...job, userId: user._id, foundAt: job.foundAt || new Date() },
              { upsert: true, new: true }
            );
            saved++;
          } catch (e) { /* duplicate */ }
        }

        const highMatch = scored.filter(j => j.matchScore >= 75);

        // Create report
        const report = await Report.create({
          userId: user._id,
          date: new Date(),
          jobsFound: unique.length,
          highMatch: highMatch.length,
          applied: 0,
          manualApply: highMatch.length,
          topJobs: highMatch.slice(0, 10).map(j => ({
            title: j.title, company: j.company, score: j.matchScore, link: j.applyLink,
          })),
        });

        // Send daily report notification
        await sendDailyReport(report);

        // Send instant alerts for top matches
        const minAlert = user.notifications?.minScoreAlert || 80;
        const instantJobs = highMatch.filter(j => j.matchScore >= minAlert).slice(0, 3);
        for (const job of instantJobs) {
          await sendInstantJobAlert(user, job);
        }

        results.push({
          user: user.email,
          status: 'ok',
          jobsFound: unique.length,
          saved,
          highMatch: highMatch.length,
          alertsSent: instantJobs.length,
        });
      } catch (err) {
        results.push({ user: user.email, status: 'error', error: err.message });
      }
    }

    // Also run application reminders on cron
    try {
      await sendApplicationReminders();
    } catch (e) {
      console.error('Reminder error:', e.message);
    }

    res.json({ success: true, timestamp: new Date().toISOString(), results });
  } catch (err) {
    console.error('Cron error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
};
