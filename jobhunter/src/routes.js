const express = require('express');
const router  = express.Router();
const bcrypt  = require('bcryptjs');
const { User, Job, Resume, Report, Application } = require('./models');
const { runJobHunt, getRunStatus, rescoreAllJobs } = require('./runner');
const { parseResume } = require('./parsers/resumeParser');
const { authenticate, signToken } = require('./middleware/auth');
const multer = require('multer');
const path   = require('path');
const fs     = require('fs');

const upload = multer({ dest: process.env.VERCEL ? '/tmp' : 'uploads/' });

// ══════════════════════════════════════════════════════════════════════════════
// IN-MEMORY RATE LIMITER FOR AUTH ROUTES
// ══════════════════════════════════════════════════════════════════════════════
const authRateLimitMap = new Map();
const AUTH_RATE_LIMIT = 10;         // max attempts
const AUTH_RATE_WINDOW = 15 * 60 * 1000; // 15 minutes

function authRateLimiter(req, res, next) {
  const ip = req.ip || req.connection.remoteAddress || 'unknown';
  const now = Date.now();
  let entry = authRateLimitMap.get(ip);

  if (!entry || now - entry.windowStart > AUTH_RATE_WINDOW) {
    entry = { windowStart: now, count: 0 };
    authRateLimitMap.set(ip, entry);
  }

  entry.count++;
  if (entry.count > AUTH_RATE_LIMIT) {
    const retryAfter = Math.ceil((entry.windowStart + AUTH_RATE_WINDOW - now) / 1000);
    return res.status(429).json({
      success: false,
      error: `Too many auth attempts. Try again in ${retryAfter} seconds.`,
    });
  }
  next();
}

// Clean up stale entries every 30 minutes
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of authRateLimitMap) {
    if (now - entry.windowStart > AUTH_RATE_WINDOW) authRateLimitMap.delete(ip);
  }
}, 30 * 60 * 1000);

// ══════════════════════════════════════════════════════════════════════════════
// AUTH ROUTES (public — no token needed)
// ══════════════════════════════════════════════════════════════════════════════

// ── POST /api/auth/signup ───────────────────────────────────────────────────
router.post('/auth/signup', authRateLimiter, async (req, res) => {
  try {
    const { email, password, name } = req.body;
    if (!email || !password) return res.status(400).json({ success: false, error: 'Email and password required' });
    if (password.length < 6) return res.status(400).json({ success: false, error: 'Password must be at least 6 characters' });

    const existing = await User.findOne({ email: email.toLowerCase() });
    if (existing) return res.status(400).json({ success: false, error: 'Email already registered' });

    const hash = await bcrypt.hash(password, 10);

    // First user becomes admin
    const userCount = await User.countDocuments();
    const user = await User.create({
      email: email.toLowerCase(),
      password: hash,
      name: name || '',
      isAdmin: userCount === 0,
    });

    const token = signToken(user._id);
    res.json({
      success: true,
      token,
      user: { id: user._id, email: user.email, name: user.name, isAdmin: user.isAdmin },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── POST /api/auth/login ────────────────────────────────────────────────────
router.post('/auth/login', authRateLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ success: false, error: 'Email and password required' });

    const user = await User.findOne({ email: email.toLowerCase() });
    if (!user) return res.status(401).json({ success: false, error: 'Invalid email or password' });

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(401).json({ success: false, error: 'Invalid email or password' });

    const token = signToken(user._id);
    res.json({
      success: true,
      token,
      user: { id: user._id, email: user.email, name: user.name, isAdmin: user.isAdmin },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── GET /api/auth/me ────────────────────────────────────────────────────────
router.get('/auth/me', authenticate, (req, res) => {
  res.json({
    success: true,
    user: {
      id: req.user._id,
      email: req.user.email,
      name: req.user.name,
      isAdmin: req.user.isAdmin,
      telegramLinked: !!(req.user.telegram?.chatId),
      notifications: req.user.notifications || {},
    },
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// ALL ROUTES BELOW REQUIRE AUTH
// ══════════════════════════════════════════════════════════════════════════════
router.use(authenticate);

// ── GET /api/jobs ─────────────────────────────────────────────────────────────
router.get('/jobs', async (req, res) => {
  try {
    const { status, minScore = 0, source, company, location, directApply, sortBy, search, days, limit = 50, page = 1 } = req.query;
    const filter = { userId: req.user._id };
    // Hide rejected jobs from "All Jobs" — only show if explicitly filtered
    if (status) {
      filter.status = status;
    } else {
      filter.status = { $ne: 'rejected' };
    }
    if (source) filter.source = source;
    if (company) filter.company = { $regex: `^${company.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, $options: 'i' };
    if (minScore) filter.matchScore = { $gte: parseInt(minScore) };
    if (days) {
      const since = new Date();
      since.setDate(since.getDate() - parseInt(days));
      filter.foundAt = { $gte: since };
    }
    if (location) filter.location = { $regex: location, $options: 'i' };
    if (directApply !== undefined) filter.directApply = directApply === 'true';
    if (search) {
      filter.$or = [
        { title: { $regex: search, $options: 'i' } },
        { company: { $regex: search, $options: 'i' } },
        { skills: { $regex: search, $options: 'i' } },
        { description: { $regex: search, $options: 'i' } },
      ];
    }

    let sort = { matchScore: -1, foundAt: -1 };
    if (sortBy === 'newest' || sortBy === 'foundAt') sort = { foundAt: -1 };
    else if (sortBy === 'companyAZ' || sortBy === 'company') sort = { company: 1 };
    else if (sortBy === 'bestMatch' || sortBy === 'matchScore') sort = { matchScore: -1 };

    const jobs = await Job.find(filter)
      .sort(sort)
      .limit(parseInt(limit))
      .skip((parseInt(page) - 1) * parseInt(limit));

    const total = await Job.countDocuments(filter);
    res.json({ success: true, total, page: parseInt(page), jobs });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── POST /api/jobs/rescore ───────────────────────────────────────────────────
router.post('/jobs/rescore', async (req, res) => {
  try {
    const count = await rescoreAllJobs(req.user._id);
    res.json({ success: true, message: `Rescored ${count} jobs`, count });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── POST /api/jobs/enrich ───────────────────────────────────────────────────
router.post('/jobs/enrich', async (req, res) => {
  try {
    const { enrichJobs } = require('./scrapers/jobEnricher');
    const jobs = await Job.find({ userId: req.user._id, $or: [{ description: '' }, { description: null }, { description: { $exists: false } }] }).lean();
    if (!jobs.length) return res.json({ success: true, message: 'No jobs need enrichment', count: 0 });

    const enriched = await enrichJobs(jobs.slice(0, 50), 3);
    let updated = 0;
    for (const job of enriched) {
      if (job.description) {
        await Job.findOneAndUpdate({ jobId: job.jobId, userId: req.user._id }, {
          description: job.description, skills: job.skills, experience: job.experience
        });
        updated++;
      }
    }
    res.json({ success: true, message: `Enriched ${updated} jobs`, count: updated });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── GET /api/jobs/locations ─────────────────────────────────────────────────
router.get('/jobs/locations', async (req, res) => {
  try {
    const rawLocations = await Job.distinct('location', { userId: req.user._id });

    // Normalize and group locations
    const indiaKeywords = ['india', 'bangalore', 'bengaluru', 'mumbai', 'delhi', 'ncr', 'hyderabad', 'pune', 'chennai', 'kolkata', 'noida', 'gurgaon', 'gurugram', 'ahmedabad', 'jaipur', 'kochi', 'thiruvananthapuram', 'indore', 'chandigarh', 'lucknow', 'coimbatore', 'nagpur', 'surat', 'vadodara', 'visakhapatnam', 'bhubaneswar', 'mysore', 'mangalore', 'karnataka', 'maharashtra', 'tamil nadu', 'telangana', 'kerala', 'uttar pradesh', 'west bengal', 'rajasthan', 'gujarat'];

    const normalized = new Map(); // normalized name -> { display, isIndia, count }

    for (const loc of rawLocations) {
      if (!loc || !loc.trim()) continue;
      const lower = loc.toLowerCase().trim();

      // Normalize common variations
      let key = lower
        .replace(/,?\s*(india|in)$/i, '')
        .replace(/bengaluru/i, 'bangalore')
        .replace(/gurugram/i, 'gurgaon')
        .replace(/\s*\(.*?\)\s*/g, '')
        .trim();

      if (!key) key = lower;

      const isIndia = indiaKeywords.some(k => lower.includes(k));
      const isRemote = lower.includes('remote') || lower.includes('worldwide') || lower.includes('anywhere');

      if (normalized.has(key)) {
        normalized.get(key).count++;
      } else {
        // Clean display name
        let display = loc.trim();
        if (display.length > 40) display = display.slice(0, 40) + '...';
        normalized.set(key, { display, isIndia, isRemote, count: 1, raw: loc });
      }
    }

    // Sort: India first, then Remote, then International
    const india = [];
    const remote = [];
    const international = [];

    for (const [, v] of normalized) {
      if (v.isRemote) remote.push(v);
      else if (v.isIndia) india.push(v);
      else international.push(v);
    }

    india.sort((a, b) => b.count - a.count);
    remote.sort((a, b) => b.count - a.count);
    international.sort((a, b) => b.count - a.count);

    res.json({
      success: true,
      locations: [
        ...india.map(v => v.raw),
        ...remote.map(v => v.raw),
        ...international.map(v => v.raw),
      ],
      grouped: { india: india.map(v => v.raw), remote: remote.map(v => v.raw), international: international.map(v => v.raw) },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── GET /api/jobs/companies — Distinct companies sorted by job count ────────
router.get('/jobs/companies', async (req, res) => {
  try {
    const companies = await Job.aggregate([
      { $match: { userId: req.user._id } },
      { $group: { _id: '$company', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 100 },
    ]);
    res.json({ success: true, companies: companies.map(c => ({ name: c._id, count: c.count })) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── GET /api/jobs/sources ───────────────────────────────────────────────────
router.get('/jobs/sources', async (req, res) => {
  try {
    const sources = await Job.distinct('source', { userId: req.user._id });
    res.json({ success: true, sources });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── GET /api/jobs/stats ───────────────────────────────────────────────────────
router.get('/jobs/stats', async (req, res) => {
  try {
    const uid = req.user._id;
    const [total, highMatch, applied, directApply, sources] = await Promise.all([
      Job.countDocuments({ userId: uid }),
      Job.countDocuments({ userId: uid, matchScore: { $gte: 75 } }),
      Job.countDocuments({ userId: uid, status: 'applied' }),
      Job.countDocuments({ userId: uid, directApply: true }),
      Job.aggregate([{ $match: { userId: uid } }, { $group: { _id: '$source', count: { $sum: 1 } } }]),
    ]);

    const topJobs = await Job.find({ userId: uid })
      .sort({ matchScore: -1 }).limit(5)
      .select('title company matchScore source applyLink');

    res.json({ success: true, stats: { total, highMatch, applied, directApply, sources, topJobs } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── GET /api/reports ──────────────────────────────────────────────────────────
router.get('/reports', async (req, res) => {
  try {
    const reports = await Report.find({ userId: req.user._id }).sort({ date: -1 }).limit(30);
    res.json({ success: true, reports });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── GET /api/resume ───────────────────────────────────────────────────────────
router.get('/resume', async (req, res) => {
  try {
    const resume = await Resume.findOne({ userId: req.user._id }).select('-rawText');
    res.json({ success: true, resume });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── POST /api/resume/upload ───────────────────────────────────────────────────
router.post('/resume/upload', upload.single('resume'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, error: 'No file uploaded' });
    console.log('Resume upload:', req.file.path, 'size:', req.file.size, 'userId:', req.user._id);
    const resumeProfile = await parseResume(req.file.path, req.user._id);
    try { fs.unlinkSync(req.file.path); } catch (e) { /* cleanup failed, ok */ }
    res.json({ success: true, resume: resumeProfile });
  } catch (err) {
    console.error('Resume upload error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── POST /api/run ─────────────────────────────────────────────────────────────
router.post('/run', async (req, res) => {
  try {
    const userMinScore = parseInt(req.body?.minScore) || 70;

    if (process.env.VERCEL) {
      const { fetchRemotive, fetchArbeitnow, fetchHimalayas, fetchJobicy, fetchRemoteOK, fetchTheMuse, scrapeLinkedIn, scrapeNaukri } = require('./scrapers/jobScraper');
      const { matchJobs } = require('./matchers/jobMatcher');
      const { sendDailyReport } = require('./notifiers/notifier');

      let resumeProfile = await Resume.findOne({ userId: req.user._id }).lean();
      if (!resumeProfile) {
        return res.json({ success: false, message: 'No resume found. Please upload a resume first.' });
      }

      const skills = resumeProfile.skills.slice(0, 5);
      const roles = resumeProfile.roles.slice(0, 3);
      const keywords = [...roles, ...skills.slice(0, 3)].filter(Boolean);

      const indiaKeywords = keywords.map(k => `${k} india`);
      const indiaRoles = roles.map(r => `${r} india`);

      const { fetchCompanyCareers } = require('./scrapers/companyScraper');
      const companyJobsPromise = fetchCompanyCareers(resumeProfile).catch(() => []);

      const results = await Promise.allSettled([
        scrapeLinkedIn(indiaKeywords),
        scrapeLinkedIn(indiaRoles),
        scrapeNaukri(keywords.map(k => `${k} developer`)),
        fetchRemotive(keywords),
        fetchArbeitnow(keywords),
        fetchHimalayas(keywords),
        fetchJobicy(keywords),
        fetchRemoteOK(keywords),
        fetchTheMuse(keywords),
      ]);

      const companyJobs = await companyJobsPromise;

      let allJobs = [...companyJobs];
      results.forEach(r => { if (r.status === 'fulfilled') allJobs.push(...r.value); });

      const seen = new Set();
      const unique = allJobs.filter(j => { if (seen.has(j.jobId)) return false; seen.add(j.jobId); return true; });

      const scored = matchJobs(unique, resumeProfile);

      let saved = 0;
      for (const job of scored) {
        try {
          await Job.findOneAndUpdate(
            { jobId: job.jobId, userId: req.user._id },
            { ...job, userId: req.user._id, foundAt: job.foundAt || new Date() },
            { upsert: true, new: true }
          );
          saved++;
        } catch (e) { /* duplicate */ }
      }

      // Use user's preference for filtering
      const fullUser = await User.findById(req.user._id);
      const effectiveMinScore = fullUser?.notifications?.minScoreAlert || userMinScore || 65;
      const highMatch = scored.filter(j => j.matchScore >= effectiveMinScore);
      const readyToApply = highMatch.filter(j => j.directApply);

      // Send notifications
      try {
        const report = await Report.create({
          userId: req.user._id,
          date: new Date(),
          jobsFound: unique.length,
          highMatch: highMatch.length,
          applied: 0,
          manualApply: readyToApply.length,
          topJobs: highMatch.slice(0, 10).map(j => ({
            title: j.title, company: j.company, score: j.matchScore, link: j.applyLink,
          })),
        });
        await sendDailyReport(report);

        // Send instant Telegram alerts for top jobs above user's threshold
        if (fullUser) {
          const { sendInstantJobAlert } = require('./notifiers/notifier');
          const alertJobs = highMatch.slice(0, 5);
          for (const job of alertJobs) {
            await sendInstantJobAlert(fullUser, job);
          }
        }
      } catch (e) { console.error('Report/notify error:', e.message); }

      return res.json({
        success: true,
        message: `Hunt complete! Found ${unique.length} jobs, saved ${saved}, ${highMatch.length} high matches.`,
      });
    }

    // Local: run full hunt in background
    const status = getRunStatus();
    if (status.running) return res.json({ success: false, message: 'Job hunt already running' });
    res.json({ success: true, message: 'Job hunt started in background' });
    runJobHunt(req.user._id, req.user.isAdmin).catch(console.error);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── GET /api/run/status ───────────────────────────────────────────────────────
router.get('/run/status', (req, res) => {
  res.json({ success: true, status: getRunStatus() });
});

// ── PATCH /api/jobs/:id/status ────────────────────────────────────────────────
router.patch('/jobs/:id/status', async (req, res) => {
  try {
    const { status } = req.body;
    const job = await Job.findOneAndUpdate(
      { _id: req.params.id, userId: req.user._id },
      { status, ...(status === 'applied' ? { appliedAt: new Date() } : {}) },
      { new: true }
    );
    if (!job) return res.status(404).json({ success: false, error: 'Job not found' });

    if (status === 'applied') {
      const existing = await Application.findOne({ jobId: job._id, userId: req.user._id });
      if (!existing) {
        await Application.create({
          userId: req.user._id,
          jobId: job._id,
          company: job.company, title: job.title, location: job.location,
          source: job.source, applyLink: job.applyLink, matchScore: job.matchScore,
          status: 'applied', appliedAt: new Date(),
        });
      }
    }

    res.json({ success: true, job });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// APPLICATION TRACKING
// ══════════════════════════════════════════════════════════════════════════════

router.get('/applications', async (req, res) => {
  try {
    const { status } = req.query;
    const filter = { userId: req.user._id };
    if (status) filter.status = status;
    const applications = await Application.find(filter).sort({ appliedAt: -1 });
    const uid = req.user._id;
    const stats = {
      total: await Application.countDocuments({ userId: uid }),
      applied: await Application.countDocuments({ userId: uid, status: 'applied' }),
      interview: await Application.countDocuments({ userId: uid, status: 'interview' }),
      offer: await Application.countDocuments({ userId: uid, status: 'offer' }),
      rejected: await Application.countDocuments({ userId: uid, status: 'rejected' }),
      ghosted: await Application.countDocuments({ userId: uid, status: 'ghosted' }),
    };

    // Auto-detect ghosted: applications with status "applied" and appliedAt > 14 days ago
    const fourteenDaysAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
    const ghostedSuggestions = applications
      .filter(app => app.status === 'applied' && app.appliedAt && new Date(app.appliedAt) < fourteenDaysAgo)
      .map(app => app._id);

    res.json({ success: true, applications, stats, ghostedSuggestions });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.patch('/applications/:id', async (req, res) => {
  try {
    const { status, notes, nextStep } = req.body;
    const update = { updatedAt: new Date() };
    if (status) update.status = status;
    if (notes !== undefined) update.notes = notes;
    if (nextStep !== undefined) update.nextStep = nextStep;
    const app = await Application.findOneAndUpdate({ _id: req.params.id, userId: req.user._id }, update, { new: true });
    res.json({ success: true, application: app });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.delete('/applications/:id', async (req, res) => {
  try {
    await Application.findOneAndDelete({ _id: req.params.id, userId: req.user._id });
    res.json({ success: true, message: 'Application removed' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── DELETE /api/jobs/clear ────────────────────────────────────────────────────
router.delete('/jobs/clear', async (req, res) => {
  try {
    await Job.deleteMany({ userId: req.user._id });
    res.json({ success: true, message: 'All jobs cleared' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── GET /api/analytics ──────────────────────────────────────────────────────
router.get('/analytics', async (req, res) => {
  try {
    const uid = req.user._id;
    const [bySource, scoreDistribution, byDay, appFunnel, topCompanies] = await Promise.all([
      Job.aggregate([{ $match: { userId: uid } }, { $group: { _id: '$source', count: { $sum: 1 } } }, { $sort: { count: -1 } }]),
      Job.aggregate([{ $match: { userId: uid } },
        { $bucket: { groupBy: '$matchScore', boundaries: [0, 25, 50, 75, 101], default: 'other', output: { count: { $sum: 1 } } } }
      ]),
      Job.aggregate([
        { $match: { userId: uid, foundAt: { $gte: new Date(Date.now() - 14 * 86400000) } } },
        { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$foundAt' } }, count: { $sum: 1 } } },
        { $sort: { _id: 1 } }
      ]),
      Application.aggregate([{ $match: { userId: uid } }, { $group: { _id: '$status', count: { $sum: 1 } } }]),
      Job.aggregate([{ $match: { userId: uid } }, { $group: { _id: '$company', count: { $sum: 1 } } }, { $sort: { count: -1 } }, { $limit: 10 }]),
    ]);

    res.json({ success: true, analytics: { bySource, scoreDistribution, byDay, appFunnel, topCompanies } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── EXPORTS ────────────────────────────────────────────────────────────────
router.get('/export/jobs', async (req, res) => {
  try {
    const jobs = await Job.find({ userId: req.user._id }).sort({ matchScore: -1 }).lean();
    const headers = ['Title', 'Company', 'Location', 'Match Score', 'Status', 'Source', 'Skills', 'Experience', 'Salary', 'Remote', 'Direct Apply', 'Apply Link', 'Found At'];
    const csvRows = [headers.join(',')];
    for (const j of jobs) {
      csvRows.push([
        csvEsc(j.title), csvEsc(j.company), csvEsc(j.location), j.matchScore || 0,
        j.status || 'found', j.source || '', csvEsc((j.skills || []).join('; ')),
        csvEsc(j.experience || ''), csvEsc(j.salary || ''), j.isRemote ? 'Yes' : 'No',
        j.directApply ? 'Yes' : 'No', csvEsc(j.applyLink || ''),
        j.foundAt ? new Date(j.foundAt).toISOString().slice(0, 10) : ''
      ].join(','));
    }
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=jobhunter-jobs.csv');
    res.send(csvRows.join('\n'));
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/export/applications', async (req, res) => {
  try {
    const apps = await Application.find({ userId: req.user._id }).sort({ appliedAt: -1 }).lean();
    const headers = ['Title', 'Company', 'Location', 'Source', 'Match Score', 'Status', 'Applied At', 'Notes', 'Next Step'];
    const csvRows = [headers.join(',')];
    for (const a of apps) {
      csvRows.push([
        csvEsc(a.title), csvEsc(a.company), csvEsc(a.location || ''), a.source || '',
        a.matchScore || 0, a.status || 'applied',
        a.appliedAt ? new Date(a.appliedAt).toISOString().slice(0, 10) : '',
        csvEsc(a.notes || ''), csvEsc(a.nextStep || '')
      ].join(','));
    }
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=jobhunter-applications.csv');
    res.send(csvRows.join('\n'));
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

function csvEsc(str) {
  if (!str) return '';
  str = String(str);
  if (str.includes(',') || str.includes('"') || str.includes('\n')) return '"' + str.replace(/"/g, '""') + '"';
  return str;
}

// ══════════════════════════════════════════════════════════════════════════════
// TELEGRAM LINKING & NOTIFICATION SETTINGS
// ══════════════════════════════════════════════════════════════════════════════

// ── POST /api/telegram/generate-link — Generate a 6-digit code for Telegram linking
router.post('/telegram/generate-link', async (req, res) => {
  try {
    const code = String(Math.floor(100000 + Math.random() * 900000)); // 6-digit code
    const expires = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

    await User.findByIdAndUpdate(req.user._id, {
      'telegram.linkToken': code,
      'telegram.linkExpires': expires,
    });

    const botUsername = process.env.TELEGRAM_BOT_USERNAME || '';
    res.json({
      success: true,
      code,
      expiresIn: '10 minutes',
      botLink: botUsername ? `https://t.me/${botUsername}` : '',
      instructions: `Send this code to the JobHunter bot on Telegram: ${code}`,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── GET /api/telegram/status — Check if Telegram is linked
router.get('/telegram/status', async (req, res) => {
  try {
    const user = await User.findById(req.user._id).select('telegram notifications isAdmin');

    // Auto-migrate: if admin has no chatId but .env has TELEGRAM_CHAT_ID, auto-link
    if (user.isAdmin && !user.telegram?.chatId && process.env.TELEGRAM_CHAT_ID) {
      user.telegram = user.telegram || {};
      user.telegram.chatId = process.env.TELEGRAM_CHAT_ID;
      user.telegram.linkedAt = new Date();
      user.telegram.username = 'admin (auto-linked)';
      await User.findByIdAndUpdate(req.user._id, {
        'telegram.chatId': process.env.TELEGRAM_CHAT_ID,
        'telegram.linkedAt': new Date(),
        'telegram.username': 'admin (auto-linked)',
      });
    }

    res.json({
      success: true,
      linked: !!(user.telegram?.chatId),
      username: user.telegram?.username || '',
      linkedAt: user.telegram?.linkedAt || null,
      notifications: user.notifications || {},
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── POST /api/telegram/link-manual — Link by chat ID directly (for users who know their chat ID)
router.post('/telegram/link-manual', async (req, res) => {
  try {
    const { chatId } = req.body;
    if (!chatId) return res.status(400).json({ success: false, error: 'chatId is required' });

    // Verify the chat ID works by sending a test message
    const { sendToChat } = require('./notifiers/telegramBot');
    const sent = await sendToChat(String(chatId), '✅ *JobHunter Pro linked!* You\'ll now receive job alerts here.');

    if (!sent) {
      return res.status(400).json({ success: false, error: 'Could not send message to this chat ID. Make sure you\'ve started the bot first.' });
    }

    await User.findByIdAndUpdate(req.user._id, {
      'telegram.chatId': String(chatId),
      'telegram.username': 'manual-link',
      'telegram.linkedAt': new Date(),
      'telegram.linkToken': '',
    });

    res.json({ success: true, message: 'Telegram linked successfully!' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── DELETE /api/telegram/unlink — Disconnect Telegram
router.delete('/telegram/unlink', async (req, res) => {
  try {
    const { sendToChat } = require('./notifiers/telegramBot');
    const user = await User.findById(req.user._id);

    // Notify the user on Telegram before unlinking
    if (user.telegram?.chatId) {
      await sendToChat(user.telegram.chatId, '🔌 *Account unlinked.* You won\'t receive notifications anymore. Re-link anytime from the dashboard.');
    }

    await User.findByIdAndUpdate(req.user._id, {
      'telegram.chatId': '',
      'telegram.username': '',
      'telegram.linkedAt': null,
    });

    res.json({ success: true, message: 'Telegram unlinked' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── PATCH /api/notifications/settings — Update notification preferences
router.patch('/notifications/settings', async (req, res) => {
  try {
    const allowed = ['telegram', 'email', 'dailyReport', 'instantAlerts', 'weeklyDigest', 'applicationReminders', 'minScoreAlert'];
    const update = {};

    for (const key of allowed) {
      if (req.body[key] !== undefined) {
        update[`notifications.${key}`] = req.body[key];
      }
    }

    if (Object.keys(update).length === 0) {
      return res.status(400).json({ success: false, error: 'No valid settings provided' });
    }

    const user = await User.findByIdAndUpdate(req.user._id, update, { new: true });
    res.json({ success: true, notifications: user.notifications });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── GET /api/notifications/settings — Get notification preferences
router.get('/notifications/settings', async (req, res) => {
  try {
    const user = await User.findById(req.user._id).select('notifications telegram.chatId telegram.username telegram.linkedAt');
    res.json({
      success: true,
      notifications: user.notifications || {},
      telegramLinked: !!(user.telegram?.chatId),
      telegramUsername: user.telegram?.username || '',
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── POST /api/telegram/test — Send a test notification
router.post('/telegram/test', async (req, res) => {
  try {
    const user = await User.findById(req.user._id);
    if (!user.telegram?.chatId) {
      return res.status(400).json({ success: false, error: 'Telegram not linked. Connect first.' });
    }

    const { sendToChat } = require('./notifiers/telegramBot');
    const sent = await sendToChat(user.telegram.chatId, `
✅ *Test Notification*

This is a test from JobHunter Pro!
Your Telegram notifications are working correctly.

*Your Settings:*
• Daily Report: ${user.notifications?.dailyReport !== false ? 'ON' : 'OFF'}
• Instant Alerts: ${user.notifications?.instantAlerts !== false ? 'ON' : 'OFF'}
• Min Score: ${user.notifications?.minScoreAlert || 80}%
    `.trim());

    if (sent) {
      res.json({ success: true, message: 'Test notification sent! Check your Telegram.' });
    } else {
      res.status(500).json({ success: false, error: 'Failed to send. Check bot token.' });
    }
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// NAUKRI SYNC — One-time cookie-based fetch
// ══════════════════════════════════════════════════════════════════════════════

router.post('/naukri/sync', async (req, res) => {
  try {
    const { cookies } = req.body;
    if (!cookies || cookies.length < 50) {
      return res.status(400).json({ success: false, error: 'Paste the full cookie string from Naukri browser DevTools' });
    }

    // Load user's resume for keywords
    const resume = await Resume.findOne({ userId: req.user._id }).lean();
    if (!resume) {
      return res.status(400).json({ success: false, error: 'Upload a resume first' });
    }

    // Build search queries from resume — roles as primary, skills as combined keyword
    const roles = (resume.roles || []).slice(0, 3);
    const skills = (resume.skills || []).slice(0, 6);
    const experience = resume.experience || 2;

    // Create smart search queries: role-based + skill combo
    const searches = [
      ...roles.map(r => r),
      skills.slice(0, 3).join(', '),                         // "nodejs, mongodb, redis"
      ...skills.slice(0, 2).map(s => `${s} developer`),      // "nodejs developer"
    ].filter(Boolean).slice(0, 5); // max 5 searches

    const axios = require('axios');
    const { matchJobs } = require('./matchers/jobMatcher');
    let allJobs = [];

    const naukriHeaders = {
      'accept': 'application/json',
      'appid': '109',
      'clientid': 'd3skt0p',
      'systemid': 'Naukri',
      'gid': 'LOCATION,INDUSTRY,EDUCATION,FAREA_ROLE',
      'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36',
      'sec-fetch-dest': 'empty',
      'sec-fetch-mode': 'cors',
      'sec-fetch-site': 'same-origin',
      'Cookie': cookies,
    };

    // Fetch from Naukri API — multiple keywords, 2 pages each
    for (const keyword of searches) {
      for (let page = 1; page <= 2; page++) {
        try {
          const slug = keyword.replace(/[,\s]+/g, '-').toLowerCase().replace(/--+/g, '-');
          const url = `https://www.naukri.com/jobapi/v3/search?noOfResults=25&urlType=search_by_keyword&searchType=adv&keyword=${encodeURIComponent(keyword)}&pageNo=${page}&experience=${experience}&seoKey=${slug}-jobs&src=jobsearchDesk&sort=r&latLong=`;

          const apiRes = await axios.get(url, {
            headers: { ...naukriHeaders, 'referer': `https://www.naukri.com/${slug}-jobs` },
            timeout: 15000,
          });

          const jobs = apiRes.data?.jobDetails || [];
          jobs.forEach(job => {
            if (!job.title || !job.companyName) return;
            const loc = job.placeholders?.find(p => p.type === 'location')?.label || 'India';
            allJobs.push({
              title: job.title,
              company: job.companyName,
              location: loc,
              experience: job.placeholders?.find(p => p.type === 'experience')?.label || '',
              salary: job.placeholders?.find(p => p.type === 'salary')?.label || '',
              skills: (job.tagsAndSkills || '').split(',').map(s => s.trim()).filter(Boolean).slice(0, 8),
              applyLink: job.jdURL ? `https://www.naukri.com${job.jdURL}` : `https://www.naukri.com/${slug}-jobs`,
              source: 'Naukri',
              directApply: false,
              isRemote: loc.toLowerCase().includes('remote') || loc.toLowerCase().includes('work from home'),
              jobId: `naukri_${job.jobId || require('uuid').v4().slice(0, 8)}`,
              description: (job.jobDescription || '').slice(0, 2000),
            });
          });
        } catch (kwErr) {
          if (kwErr.response?.status === 406) {
            return res.status(400).json({ success: false, error: 'Cookies expired. Open naukri.com in browser, copy fresh cookies, and try again.' });
          }
          console.error(`Naukri sync error for "${keyword}" page ${page}:`, kwErr.response?.status || kwErr.message);
          break; // skip remaining pages for this keyword
        }
      }
    }

    // Dedup
    const seen = new Set();
    const unique = allJobs.filter(j => {
      const key = j.title.toLowerCase() + '|' + j.company.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    // Score jobs
    const scored = matchJobs(unique, resume);

    // Save to DB
    let saved = 0;
    for (const job of scored) {
      try {
        await Job.findOneAndUpdate(
          { jobId: job.jobId, userId: req.user._id },
          { ...job, userId: req.user._id, foundAt: new Date() },
          { upsert: true, new: true }
        );
        saved++;
      } catch (e) { /* dup */ }
    }

    const highMatch = scored.filter(j => j.matchScore >= 70);
    res.json({
      success: true,
      message: `Synced ${saved} Naukri jobs! ${highMatch.length} high matches.`,
      total: unique.length,
      saved,
      highMatch: highMatch.length,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Company Config ──────────────────────────────────────────────────────────
router.get('/config/companies', (req, res) => {
  const configPath = path.join(__dirname, '../config.json');
  try {
    const config = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, 'utf-8')) : { preferred: [], blocked: [] };
    res.json({ success: true, companies: config });
  } catch (e) {
    res.json({ success: true, companies: { preferred: [], blocked: [] } });
  }
});

router.post('/config/companies', (req, res) => {
  const configPath = path.join(__dirname, '../config.json');
  try {
    const { preferred, blocked } = req.body;
    fs.writeFileSync(configPath, JSON.stringify({ preferred: preferred || [], blocked: blocked || [] }, null, 2));
    res.json({ success: true, message: 'Company lists updated' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
