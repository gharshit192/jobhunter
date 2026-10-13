require('dotenv').config();
const express = require('express');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const cron = require('node-cron');
const store = require('./store');
const runner = require('./runner');
const { COMPANIES, PLATFORMS } = require('./companies');
const { importJob } = require('./discovery');
const { normalize } = require('./answers');
const { evaluate } = require('./matching');
const browser = require('./browser');
function isRunning() { return runner.isRunning() || store.workerActive(); }
const PORT = Number(process.env.AUTOMATION_PORT || 4129);
const token = crypto.randomBytes(32).toString('hex');
const app = express();
app.disable('x-powered-by');
app.use((req, res, next) => {
  if (!['127.0.0.1', 'localhost'].includes(req.hostname)) return res.sendStatus(403);
  res.set('Cache-Control', 'no-store');
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'DENY');
  res.set('Referrer-Policy', 'no-referrer');
  if (!['GET', 'HEAD'].includes(req.method) && req.get('X-JobHunter-Token') !== token) return res.status(403).json({ error: 'Open the local dashboard to perform this action' });
  next();
});
app.use(express.json({ limit: '100kb' }));
app.use((req, res, next) => { if (!['GET', 'HEAD'].includes(req.method)) res.on('finish', () => { try { require('./reports').save(); } catch (e) { console.error('Report save failed:', e.message); } }); next(); });
app.get('/', (req, res) => {
  const html = fs.readFileSync(path.join(__dirname, '../../public/automation.html'), 'utf8').replace('__LOCAL_TOKEN__', token);
  res.type('html').send(html);
});
app.get('/api/state', (req, res) => {
  const s = store.state(), p = runner.profile();
  res.json({ ...s, profile: p, companies: COMPANIES, companyStatus: store.read('companies-status', []), platforms: PLATFORMS, platformStatus: store.read('platform-status', []), running: isRunning(), day: store.indiaDay(), confirmedToday: runner.todays(s).length });
});
app.get('/api/health', (req, res) => res.json({ ok: true, mode: 'local-automation', running: isRunning(), browserMode: 'headless', browserActive: browser.isBackground() }));
app.get('/api/email/status', (req, res) => res.json(require('./email').status()));
app.get('/api/inbox', (req, res) => res.json(require('./inbox').summary()));
app.post('/api/inbox/scan', async (req, res, next) => { try { await require('./inbox').scan(); res.json(require('./inbox').summary()); } catch (e) { next(e); } });
app.get('/api/shortlist', (req, res) => res.json(require('./shortlist').build()));
app.post('/api/email/connect', async (req, res, next) => {
  try { res.json(await require('./email').connect(req.body.email, req.body.appPassword, runner.profile().email)); } catch (error) { next(error); }
});
app.post('/api/jobs/:id/verify', (req, res) => {
  if (isRunning()) return res.status(409).json({ error: 'A run is already active' });
  if (!/^[A-Za-z0-9]{8}$/.test(req.body.code || '')) return res.status(400).json({ error: 'Enter the 8-character email security code' });
  const s = store.state(), j = s.jobs.find(j => j.id === req.params.id);
  if (!j || !['needs_input', 'submission_uncertain'].includes(j.status)) return res.status(400).json({ error: 'Select the application waiting for verification' });
  if (!evaluate(j, runner.profile()).eligible) return res.status(400).json({ error: 'This job is outside your confirmed preferences' });
  store.mutate(value => { const job = value.jobs.find(job => job.id === j.id); job.status = 'queued'; job.reason = 'Candidate supplied a one-time email verification code'; });
  runner.run({ discovery: false, apply: true, jobId: j.id, verificationCode: req.body.code }).catch(error => console.error(error.message));
  res.json({ ok: true });
});
app.get('/api/reports', (req, res) => {
  const dir = path.join(store.ROOT, 'reports');
  const days = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).map(f => f.replace('.json', '')).sort().reverse() : [];
  res.json({ days });
});
app.get('/reports/:file', (req, res) => {
  if (!/^(?:shortlist-)?\d{4}-\d{2}-\d{2}\.(json|csv|html)$/.test(req.params.file)) return res.sendStatus(400);
  if (req.params.file.endsWith('.csv')) res.attachment(req.params.file);
  res.sendFile(path.join(store.ROOT, 'reports', req.params.file));
});
app.post('/api/run', (req, res) => {
  if (isRunning()) return res.status(409).json({ error: 'A run is already active' });
  const allowed = ['discover', 'apply', 'dry-run', 'daily'];
  if (!allowed.includes(req.body.mode)) return res.status(400).json({ error: 'Unknown run mode' });
  const mode = req.body.mode;
  runner.run({ discovery: ['discover', 'daily'].includes(mode), apply: mode !== 'discover', dryRun: mode === 'dry-run', jobId: req.body.jobId }).catch(e => console.error(e.message));
  res.json({ ok: true });
});
app.patch('/api/settings', (req, res) => {
  const { paused, autoApply, dailyTarget } = req.body;
  if (dailyTarget !== undefined && (!Number.isInteger(dailyTarget) || dailyTarget < 15 || dailyTarget > 50)) return res.status(400).json({ error: 'Daily target must be an integer between 15 and 50' });
  store.mutate(s => { if (typeof paused === 'boolean') s.settings.paused = paused; if (typeof autoApply === 'boolean') s.settings.autoApply = autoApply; if (dailyTarget !== undefined) s.settings.dailyTarget = dailyTarget; });
  res.json({ ok: true });
});
app.post('/api/exclusions', (req, res) => {
  if (!Array.isArray(req.body.companies) || req.body.companies.some(c => typeof c !== 'string' || c.length > 100)) return res.status(400).json({ error: 'Provide company names' });
  store.mutate(s => { s.excludedCompanies = [...new Set(req.body.companies.map(c => c.trim()).filter(Boolean))]; for (const j of s.jobs) if (j.status === 'queued' && s.excludedCompanies.some(c => c.toLowerCase() === j.company.toLowerCase())) { j.status = 'excluded'; j.reason = 'Previously applied or excluded by you'; } });
  res.json({ ok: true });
});
app.post('/api/jobs/import', async (req, res, next) => {
  try { res.json({ ok: true, job: await importJob(req.body.url, runner.profile(), req.body.company) }); } catch (error) { next(error); }
});
app.post('/api/jobs/:id/answers', (req, res) => {
  const s = store.state(), job = s.jobs.find(j => j.id === req.params.id);
  if (!job || job.status !== 'needs_input') return res.status(400).json({ error: 'Select an application that needs answers' });
  const answers = req.body.answers;
  if (!Array.isArray(answers)) return res.status(400).json({ error: 'Provide answers' });
  for (const a of answers) {
    if (typeof a.label !== 'string' || typeof a.value !== 'string' || a.value.length > 5000 || !job.questions?.some(q => q.label === a.label && q.origin === a.origin && q.type !== 'file')) return res.status(400).json({ error: 'Answer does not belong to this application' });
  }
  store.mutate(value => {
    for (const a of answers) value.answers[`${job.company}|${a.origin}|${normalize(a.label)}`] = a.value;
    const j = value.jobs.find(j => j.id === job.id);
    j.status = evaluate(j, runner.profile()).eligible ? 'queued' : 'excluded'; j.questions = []; j.reason = '';
  });
  res.json({ ok: true });
});
app.post('/api/jobs/:id/open', async (req, res, next) => {
  try { if (isRunning()) return res.status(409).json({ error: 'Pause and wait for the current application to finish before opening an interactive browser' }); const job = store.state().jobs.find(j => j.id === req.params.id); if (!job) return res.sendStatus(404); await browser.open(job.applyLink, { interactive: true }); res.json({ ok: true }); } catch (error) { next(error); }
});
app.post('/api/jobs/:id/finish', async (req, res, next) => {
  try {
    if (isRunning()) return res.status(409).json({ error: 'Wait for the current run to finish before manual verification' });
    const s = store.state(), job = s.jobs.find(j => j.id === req.params.id);
    if (!job || !['needs_input', 'submission_uncertain', 'queued', 'ready'].includes(job.status)) return res.status(400).json({ error: 'Select an unfinished application' });
    const p = runner.profile();
    const match = evaluate(job, { ...p, excludedCompanies: [...p.excludedCompanies, ...s.excludedCompanies] });
    if (!match.eligible) return res.status(400).json({ error: match.blocked.join('; ') });
    const result = await browser.apply(job, p, s.answers, { dryRun: true, interactive: true });
    if (job.ats === 'workday') await browser.open(job.applyLink, { interactive: true });
    res.json({ ok: true, message: 'Finish the application and verification in the window you opened. Record confirmation afterward.', questions: result.questions || [] });
  } catch (error) { next(error); }
});
app.post('/api/platforms/:name/open', async (req, res, next) => {
  try { if (isRunning()) return res.status(409).json({ error: 'Wait for the active run to finish before signing in' }); const platform = PLATFORMS.find(p => p.name.toLowerCase() === req.params.name.toLowerCase()); if (!platform) return res.sendStatus(404); if (!platform.url) return res.status(400).json({ error: 'The exact website URL must be confirmed first' }); await browser.open(platform.url, { interactive: true }); res.json({ ok: true }); } catch (error) { next(error); }
});
app.patch('/api/jobs/:id/outcome', (req, res) => {
  const allowed = ['recruiter_call', 'screening', 'interview', 'offer', 'rejected'];
  if (!allowed.includes(req.body.outcome)) return res.status(400).json({ error: 'Unknown outcome' });
  const found = store.state().jobs.find(j => j.id === req.params.id);
  if (!found) return res.sendStatus(404);
  store.mutate(s => { const j = s.jobs.find(j => j.id === req.params.id); j.outcome = req.body.outcome; j.outcomeAt = new Date().toISOString(); if (typeof req.body.notes === 'string') j.notes = req.body.notes.slice(0, 5000); if (typeof req.body.contact === 'string') j.contact = req.body.contact.slice(0, 300); });
  res.json({ ok: true });
});
app.post('/api/jobs/:id/reconcile', (req, res) => {
  const job = store.state().jobs.find(j => j.id === req.params.id);
  if (!job || !['submission_uncertain', 'needs_input'].includes(job.status)) return res.status(400).json({ error: 'This application does not need reconciliation' });
  if (req.body.submitted !== true || typeof req.body.evidence !== 'string' || req.body.evidence.trim().length < 10) return res.status(400).json({ error: 'Record the actual confirmation or application reference' });
  store.mutate(s => { const j = s.jobs.find(j => j.id === req.params.id); j.status = 'submitted'; j.submittedAt = new Date().toISOString(); j.confirmation = { text: req.body.evidence.trim(), source: 'Confirmed by candidate', at: j.submittedAt }; });
  res.json({ ok: true });
});
app.get('/evidence/:name', (req, res) => {
  if (!/^[a-z0-9-]+\.png$/i.test(req.params.name)) return res.sendStatus(400);
  res.sendFile(path.join(store.ROOT, 'evidence', req.params.name));
});
app.use((error, req, res, next) => { console.error(error.message); res.status(400).json({ error: error.message }); });
function start() {
  runner.profile();
  try { require('node:os').setPriority(process.pid, 10); } catch { /* best effort on supported platforms */ }
  const server = app.listen(PORT, '127.0.0.1', () => {
    console.log(`JobHunter daily applications: http://127.0.0.1:${PORT}`);
    console.log('Schedule: 8:00 AM IST. Keep this worker running and your Mac awake.');
    console.log('Applications run silently in a headless browser. Interactive windows open only on your explicit dashboard action.');
    if (process.argv.includes('--run-today')) runner.run().catch(e => console.error(e.message));
  });
  // Track employer replies every 30 minutes while the worker is up.
  cron.schedule('*/30 * * * *', () => { if (require('./email').status().connected) require('./inbox').scan().catch(e => console.error(e.message)); });
  cron.schedule('0 8 * * *', () => { const s = store.state(); if (!s.settings.paused && !isRunning()) runner.run().catch(e => console.error(e.message)); }, { timezone: 'Asia/Kolkata' });
  async function stop() { await browser.close(); server.close(() => process.exit(0)); }
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  return server;
}
if (require.main === module) start();
module.exports = { app, start };
