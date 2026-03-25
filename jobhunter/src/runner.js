require('dotenv').config();
const mongoose = require('mongoose');
const { parseResume } = require('./parsers/resumeParser');
const { scrapeAllJobs } = require('./scrapers/jobScraper');
const { matchJobs, categorizeJobs } = require('./matchers/jobMatcher');
const { sendDailyReport, sendInstantJobAlert } = require('./notifiers/notifier');
const { Job, Resume, Report, User } = require('./models');
const path = require('path');

const MIN_SCORE     = parseInt(process.env.MIN_MATCH_SCORE) || 70;
const APPLY_LIMIT   = parseInt(process.env.DAILY_APPLY_LIMIT) || 10;
const RESUME_PATH   = process.env.RESUME_PATH || './resume.pdf';

// ── Run Status Tracking ───────────────────────────────────────────────────────
const runStatus = {
  running: false,
  step: '',
  progress: 0,
  totalSteps: 7,
  logs: [],
  lastRun: null,
  error: null,
};

function updateStatus(step, progress, message) {
  runStatus.step = step;
  runStatus.progress = progress;
  if (message) {
    runStatus.logs.push({ time: new Date().toISOString(), message });
  }
}

function getRunStatus() {
  return { ...runStatus, logs: [...runStatus.logs] };
}

// ── Connect MongoDB ───────────────────────────────────────────────────────────
async function connectDB() {
  if (mongoose.connection.readyState === 1) {
    console.log('✅ MongoDB already connected');
    return;
  }
  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/jobhunter');
  console.log('✅ MongoDB connected');
}

// ── Save Jobs to DB ───────────────────────────────────────────────────────────
async function saveJobs(jobs, userId) {
  let saved = 0;
  for (const job of jobs) {
    try {
      await Job.findOneAndUpdate(
        { jobId: job.jobId, userId },
        { ...job, userId, foundAt: job.foundAt || new Date() },
        { upsert: true, new: true }
      );
      saved++;
    } catch (err) {
      // Duplicate — skip
    }
  }
  return saved;
}

// ── Mark Jobs as Applied ──────────────────────────────────────────────────────
async function markApplied(jobs, userId) {
  for (const job of jobs) {
    await Job.findOneAndUpdate(
      { jobId: job.jobId, ...(userId ? { userId } : {}) },
      { status: 'applied', appliedAt: new Date() }
    );
  }
}

// ── Main Hunt Runner ──────────────────────────────────────────────────────────
async function runJobHunt(userId, isAdmin = false) {
  runStatus.running = true;
  runStatus.error = null;
  runStatus.logs = [];
  updateStatus('starting', 0, 'Job hunt started');

  console.log('\n╔══════════════════════════════════════╗');
  console.log('║     🔥 JobHunter Pro — Daily Run      ║');
  console.log(`║     ${new Date().toLocaleDateString('en-IN')} ${new Date().toLocaleTimeString('en-IN')}       ║`);
  console.log('╚══════════════════════════════════════╝\n');

  try {
    // ── Step 1: Parse Resume ───────────────────────────────────────────────
    updateStatus('parsing_resume', 1, 'Parsing resume...');
    console.log('\n📄 STEP 1: Parsing Resume...');
    let resumeProfile;
    try {
      resumeProfile = await parseResume(path.resolve(RESUME_PATH));
    } catch (err) {
      console.log('⚠️  Resume file not found — using saved profile from DB');
      if (!userId) {
        throw new Error('userId is required to run job hunt');
      }
      resumeProfile = await Resume.findOne({ userId }).lean();
      if (!resumeProfile) {
        throw new Error('No resume found. Please upload a resume first.');
      }
    }

    // ── Step 3: Scrape Jobs ────────────────────────────────────────────────
    updateStatus('scraping_jobs', 2, 'Scraping jobs from all sources...');
    console.log('\n🔍 STEP 2: Scraping Jobs...');
    const rawJobs = await scrapeAllJobs(resumeProfile);

    // ── Step 2b: Enrich Jobs ──────────────────────────────────────────────
    updateStatus('enriching_jobs', 2, `Found ${rawJobs.length} jobs. Enriching with descriptions...`);
    console.log('\n🔎 STEP 2b: Enriching Jobs...');
    const { enrichJobs } = require('./scrapers/jobEnricher');
    // Only enrich jobs that have no description
    const toEnrich = rawJobs.filter(j => !j.description && j.source === 'LinkedIn').slice(0, 30);
    const notEnrich = rawJobs.filter(j => j.description || j.source !== 'LinkedIn');
    const enrichedBatch = await enrichJobs(toEnrich, 3);
    const enrichedJobs = [...notEnrich, ...enrichedBatch];

    const savedCount = await saveJobs(enrichedJobs, userId);
    console.log(`   💾 Saved ${savedCount} new jobs to database`);
    updateStatus('matching_jobs', 3, `Scraped ${enrichedJobs.length} jobs, saved ${savedCount} new. Matching to resume...`);

    // ── Step 4: Match & Score Jobs ─────────────────────────────────────────
    console.log('\n🎯 STEP 3: Matching Jobs to Resume...');
    const scoredJobs = matchJobs(enrichedJobs, resumeProfile);

    // Use user's preference for min score (from DB), fallback to env, fallback to 65
    const user = userId ? await User.findById(userId) : null;
    const userMinScore = user?.notifications?.minScoreAlert || MIN_SCORE || 65;

    const highMatch = scoredJobs.filter(j => j.matchScore >= userMinScore);
    const readyToApply = highMatch.filter(j => j.directApply);
    console.log(`   ✅ High match (${userMinScore}%+): ${highMatch.length} jobs`);
    console.log(`   🚀 Ready to apply (direct): ${readyToApply.length} jobs`);

    // Update scores in DB
    for (const job of scoredJobs) {
      await Job.findOneAndUpdate({ jobId: job.jobId, userId }, { matchScore: job.matchScore });
    }

    // ── Step 5: Build Report ─────────────────────────────────────────────
    updateStatus('building_report', 5, 'Building daily report...');
    console.log('\n📊 STEP 5: Building Report...');
    const report = await Report.create({
      userId:      userId,
      date:        new Date(),
      jobsFound:   enrichedJobs.length,
      highMatch:   highMatch.length,
      applied:     0,
      manualApply: readyToApply.length,
      topJobs:     highMatch.slice(0, 10).map(j => ({
        title:   j.title,
        company: j.company,
        score:   j.matchScore,
        link:    j.applyLink,
      })),
    });

    // ── Step 6: Send Notifications ───────────────────────────────────────
    updateStatus('sending_notifications', 6, 'Sending notifications...');
    console.log('\n📬 STEP 6: Sending Notifications...');

    // Send daily report
    await sendDailyReport(report);

    // Send instant Telegram alerts for jobs >= user's minScoreAlert preference
    if (user) {
      const alertJobs = highMatch.slice(0, 5); // top 5 matching jobs
      for (const job of alertJobs) {
        await sendInstantJobAlert(user, job);
      }
      if (alertJobs.length > 0) {
        console.log(`   🔔 Sent ${alertJobs.length} instant alerts to ${user.email}`);
      }
    }

    // ── Final Summary ──────────────────────────────────────────────────────
    console.log('\n╔══════════════════════════════════════╗');
    console.log('║            ✅ Run Complete!            ║');
    console.log('╚══════════════════════════════════════╝');
    console.log(`\n📊 Summary:`);
    console.log(`   Jobs Found:      ${enrichedJobs.length}`);
    console.log(`   High Match:      ${highMatch.length}`);
    console.log(`   Ready to Apply:  ${readyToApply.length}`);
    console.log('\n🏆 Top 5 Jobs Today:');
    highMatch.slice(0, 5).forEach((j, i) => {
      console.log(`   ${i + 1}. ${j.title} — ${j.company} (${j.matchScore}%) ${j.directApply ? '🟢 Direct' : ''}`);
      console.log(`      👉 ${j.applyLink}`);
    });

    updateStatus('complete', 7, `Hunt complete! ${enrichedJobs.length} jobs found, ${highMatch.length} high matches, ${readyToApply.length} ready to apply.`);
    runStatus.running = false;
    runStatus.lastRun = new Date().toISOString();

    return report;

  } catch (err) {
    console.error('❌ Runner error:', err);
    runStatus.running = false;
    runStatus.error = err.message;
    updateStatus('error', 0, `Error: ${err.message}`);
    throw err;
  }
}

// ── Run directly ──────────────────────────────────────────────────────────────
if (require.main === module) {
  (async () => {
    try {
      await connectDB();
      await runJobHunt();
    } catch (err) {
      // error already logged
    } finally {
      await mongoose.disconnect();
      process.exit(0);
    }
  })();
}

// ── Rescore All Jobs ─────────────────────────────────────────────────────────
async function rescoreAllJobs(userId) {
  await connectDB();

  if (!userId) return 0;
  // Load resume from DB — strictly per user
  const resumeProfile = await Resume.findOne({ userId }).lean();
  if (!resumeProfile) return 0;

  // Load all jobs from DB
  const allJobs = userId ? await Job.find({ userId }).lean() : await Job.find().lean();
  if (allJobs.length === 0) return 0;

  // Re-run matching/scoring
  const scoredJobs = matchJobs(allJobs, resumeProfile);

  // Update each job's matchScore in DB
  let updated = 0;
  for (const job of scoredJobs) {
    await Job.findOneAndUpdate(
      { jobId: job.jobId, ...(userId ? { userId } : {}) },
      { matchScore: job.matchScore }
    );
    updated++;
  }

  console.log(`Rescored ${updated} jobs`);
  return updated;
}

module.exports = { runJobHunt, getRunStatus, rescoreAllJobs };
