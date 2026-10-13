const store = require('./store');
const { discover } = require('./discovery');
const { evaluate, selectNext } = require('./matching');
const browser = require('./browser');
let running = false;
function profile() { const p = store.read('profile', null); if (!p) throw new Error('Initialize your candidate profile first'); return p; }
function recover() { store.mutate(s => { for (const j of s.jobs) { if (['submitting', 'filling'].includes(j.status)) { j.status = 'submission_uncertain'; j.reason = 'Worker stopped during an attempt. Verify before retrying.'; } } for (const r of s.runs) if (r.status === 'running') { r.status = 'interrupted'; r.finishedAt = new Date().toISOString(); } }); }
function todays(s) { const day = store.indiaDay(); return s.jobs.filter(j => j.status === 'submitted' && j.submittedAt && store.indiaDay(new Date(j.submittedAt)) === day); }
function resumeResolvedBlocks(s, p) {
  const { resolve } = require('./answers');
  for (const j of s.jobs) {
    if (j.status !== 'needs_input' || !j.match?.eligible || j.requiresVerification) continue;
    // A Workday account wall clears once credentials exist; retry it once per day rather than never.
    if (j.requiresLogin) { if (j.ats === 'workday' && process.env.WORKDAY_PASSWORD && j.loginRetryDay !== store.indiaDay()) { j.status = 'queued'; j.requiresLogin = false; j.loginRetryDay = store.indiaDay(); j.reason = 'Retrying Workday with saved candidate credentials'; } continue; }
    const questions = j.questions || [];
    const answered = questions.length && questions.every(q => resolve(q, p, s.answers, q.origin, j));
    // Only migrate the old unsupported-connector block. Never retry an uncertain submission.
    const upgraded = (j.ats === 'workday' && /^This portal needs a dedicated application connector\.|^Workday step needs manual attention|^Workday page did not render/.test(j.reason || '') && j.connectorRetryVersion !== 'workday-v2') ||
      (j.ats === 'linkedin' && /locator\.check|did not advance after Next|resume upload has not been verified/i.test(j.reason || '') && j.connectorRetryVersion !== 'linkedin-v2');
    if (answered || upgraded) {
      j.status = 'queued';
      j.reason = answered ? 'Previously missing answers are now available' : `Retrying with the updated ${j.ats === 'workday' ? 'Workday' : 'LinkedIn'} connector`;
      if (upgraded) j.connectorRetryVersion = `${j.ats}-v2`;
    }
  }
}
async function run({ discovery = true, apply = true, dryRun = false, jobId, verificationCode } = {}) {
  if (running) throw new Error('A run is already active');
  const release = store.acquireLock(); running = true;
  const id = `${Date.now()}`;
  try {
    recover();
    const p = profile();
    store.mutate(s => { s.runs.unshift({ id, startedAt: new Date().toISOString(), status: 'running', dryRun, target: s.settings.dailyTarget }); });
    store.event(dryRun ? 'Started form validation without submission' : 'Started daily run');
    const prepare = () => {
      // Retry email-only blocks once per day after the local mailbox authenticates.
      if (require('./email').status().connected) store.mutate(s => {
        for (const j of s.jobs) if (j.status === 'needs_input' && j.requiresEmailCode && j.emailAutoRetryDay !== store.indiaDay() && !(j.questions || []).length) {
          j.status = 'queued'; j.emailAutoRetryDay = store.indiaDay(); j.reason = 'Retrying email verification with authenticated local Gmail';
        }
      });
      // Re-evaluate previously queued jobs after rule changes, without losing application history.
      store.mutate(s => { for (const j of s.jobs) if (['queued', 'ready', 'excluded', 'needs_input'].includes(j.status)) { j.match = evaluate(j, { ...p, excludedCompanies: [...p.excludedCompanies, ...s.excludedCompanies] }); if (!j.match.eligible) { j.status = 'excluded'; j.reason = j.match.blocked.join('; '); } else if (j.status !== 'needs_input') j.status = 'queued'; } });
      store.mutate(s => resumeResolvedBlocks(s, p));
    };
    const applyQueue = async () => {
      let attempts = 0;
      while (attempts < 80) {
        const s = store.state();
        if (s.settings.paused || !s.settings.autoApply || (!dryRun && todays(s).length >= s.settings.dailyTarget)) break;
        const next = selectNext(jobId ? s.jobs.filter(j => j.id === jobId) : s.jobs, todays(s), { ...p, excludedCompanies: [...p.excludedCompanies, ...s.excludedCompanies] });
        if (!next) break;
        next.match = evaluate(next, p);
        store.mutate(value => { const j = value.jobs.find(j => j.id === next.id); j.status = 'filling'; j.attempts.push({ at: new Date().toISOString(), dryRun }); });
        store.event(`Checking application: ${next.company} — ${next.title}`);
        const result = await browser.apply(next, p, s.answers, { dryRun, verificationCode });
        store.mutate(value => {
          Object.assign(value.jobs.find(j => j.id === next.id), result);
          // One account wall per Workday tenant: park that tenant's other queued jobs instead of hitting it again.
          if (result.requiresLogin && result.loginHost) for (const j of value.jobs) if (j.id !== next.id && j.status === 'queued' && /^https?:/.test(j.applyLink || '') && new URL(j.applyLink).hostname === result.loginHost) Object.assign(j, { status: 'needs_input', reason: result.reason, requiresLogin: true, loginHost: result.loginHost, questions: [] });
          if (result.requiresVerification) for (const j of value.jobs) if (j.company === next.company && j.status === 'queued') { j.status = 'needs_input'; j.reason = 'Company application portal needs manual verification before automatic applications can continue'; j.requiresVerification = true; j.questions = []; }
        });
        require('./reports').save();
        store.event(`${next.company}: ${result.status}${result.reason ? ` — ${result.reason}` : ''}`);
        attempts++;
        if (dryRun || jobId) break;
      }
    };
    // Apply to what is already queued before the slow discovery sweep, then apply to what discovery finds.
    prepare();
    if (apply && discovery) await applyQueue();
    if (discovery) { await discover(p, store.event); if (store.read('platform-status', []).some(s => s.name === 'LinkedIn' && s.status === 'authenticated')) await require('./linkedin').discover(p, store.event); }
    if (discovery) prepare();
    if (apply) await applyQueue();
    if (!dryRun && require('./email').status().connected) await require('./inbox').scan().catch(() => {});
    const s = store.state(), confirmed = todays(s).length;
    const summary = { finishedAt: new Date().toISOString(), status: 'complete', confirmedToday: confirmed, target: s.settings.dailyTarget, shortfall: Math.max(0, s.settings.dailyTarget - confirmed), queued: s.jobs.filter(j => j.status === 'queued').length, needsInput: s.jobs.filter(j => j.status === 'needs_input').length, uncertain: s.jobs.filter(j => j.status === 'submission_uncertain').length };
    store.mutate(value => { Object.assign(value.runs.find(r => r.id === id), summary); value.runs = value.runs.slice(0, 90); });
    store.event(`Daily result: ${confirmed}/${summary.target} confirmed submissions; ${summary.needsInput} need input`);
    return summary;
  } catch (error) { store.mutate(s => { const r = s.runs.find(r => r.id === id); if (r) Object.assign(r, { status: 'failed', error: error.message, finishedAt: new Date().toISOString() }); }); store.event(`Run failed: ${error.message}`); throw error; }
  finally { try { require('./reports').save(); } finally { running = false; release(); } }
}
module.exports = { run, profile, recover, todays, resumeResolvedBlocks, isRunning: () => running };
