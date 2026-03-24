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
      resumeProfile = userId ? await Resume.findOne({ userId }).lean() : await Resume.findOne().lean();
      if (!resumeProfile) {
        // Use default profile
        resumeProfile = {
          skills: ['nodejs', 'node.js', 'kotlin', 'mongodb', 'microservices', 'redis', 'elasticsearch'],
          experience: 4,
          roles: ['backend engineer', 'software engineer', 'platform engineer'],
        };
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
    const { highMatch, mediumMatch } = categorizeJobs(scoredJobs);
    console.log(`   ✅ High match (75%+): ${highMatch.length} jobs`);
    console.log(`   🟡 Medium match (50-74%): ${mediumMatch.length} jobs`);

    // Update scores in DB
    for (const job of scoredJobs) {
      await Job.findOneAndUpdate({ jobId: job.jobId, userId }, { matchScore: job.matchScore });
    }

    // ── Step 5: Identify top matches for manual review ─────────────────────
    updateStatus('applying', 4, `${highMatch.length} high matches, ${mediumMatch.length} medium. Ready for review.`);
    console.log('\n🚀 STEP 4: Identifying Top Matches...');
    const toReview  = highMatch.filter(j => j.matchScore >= MIN_SCORE);
    console.log(`   📋 ${toReview.length} jobs ready for review`);

    // ── Step 6: Build Report ───────────────────────────────────────────────
    updateStatus('building_report', 5, 'Building daily report...');
    console.log('\n📊 STEP 5: Building Report...');
    const report = await Report.create({
      userId:      userId,
      date:        new Date(),
      jobsFound:   enrichedJobs.length,
      highMatch:   highMatch.length,
      applied:     0,
      manualApply: toReview.length,
      topJobs:     highMatch.slice(0, 10).map(j => ({
        title:   j.title,
        company: j.company,
        score:   j.matchScore,
        link:    j.applyLink,
      })),
    });

    // ── Step 7: Send Notifications (to ALL users with notifications enabled) ──
    updateStatus('sending_notifications', 6, 'Sending notifications...');
    console.log('\n📬 STEP 6: Sending Notifications...');

    // Send daily report to the user who triggered the hunt
    await sendDailyReport(report);

    // Send instant alerts for top jobs (80%+ by default)
    if (userId) {
      const user = await User.findById(userId);
      if (user) {
        const minAlert = user.notifications?.minScoreAlert || 80;
        const instantJobs = highMatch.filter(j => j.matchScore >= minAlert).slice(0, 3);
        for (const job of instantJobs) {
          await sendInstantJobAlert(user, job);
        }
        if (instantJobs.length > 0) {
          console.log(`   🔔 Sent ${instantJobs.length} instant alerts to ${user.email}`);
        }
      }
    }

    // ── Final Summary ──────────────────────────────────────────────────────
    console.log('\n╔══════════════════════════════════════╗');
    console.log('║            ✅ Run Complete!            ║');
    console.log('╚══════════════════════════════════════╝');
    console.log(`\n📊 Summary:`);
    console.log(`   Jobs Found:    ${enrichedJobs.length}`);
    console.log(`   High Match:    ${highMatch.length}`);
    console.log(`   Ready to Review: ${toReview.length}`);
    console.log('\n🏆 Top 5 Jobs Today:');
    highMatch.slice(0, 5).forEach((j, i) => {
      console.log(`   ${i + 1}. ${j.title} — ${j.company} (${j.matchScore}%)`);
      console.log(`      👉 ${j.applyLink}`);
    });

    updateStatus('complete', 7, `Hunt complete! ${enrichedJobs.length} jobs found, ${highMatch.length} high matches, ${toReview.length} ready for review.`);
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

  // Load resume from DB
  let resumeProfile = userId ? await Resume.findOne({ userId }).lean() : await Resume.findOne().lean();
  if (!resumeProfile) {
    // Fallback default profile
    resumeProfile = {
      skills: ['nodejs', 'node.js', 'kotlin', 'mongodb', 'microservices', 'redis', 'elasticsearch'],
      experience: 4,
      roles: ['backend engineer', 'software engineer', 'platform engineer'],
    };
  }

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
