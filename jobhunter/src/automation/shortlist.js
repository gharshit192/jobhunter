const fs = require('node:fs');
const path = require('node:path');
const store = require('./store');
const { evaluate } = require('./matching');
const { resolve } = require('./answers');
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const csvCell = value => '"' + String(value ?? '').replace(/^[=+@\-]/, "'$&").replace(/"/g, '""') + '"';
const roleKey = j => `${j.company.toLowerCase()}|${j.title.toLowerCase().replace(/[^a-z0-9]/g, '')}`;
function build(state = store.state(), profile = store.read('profile', {}), leads = store.read('web-leads', [])) {
  const completed = new Set(state.jobs.filter(j => j.status === 'submitted').map(roleKey));
  const seen = new Set(), jobs = [];
  for (const j of [...leads, ...state.jobs]) {
    const match = evaluate(j, { ...profile, excludedCompanies: [...(profile.excludedCompanies || []), ...state.excludedCompanies] });
    if (!match.eligible || match.pythonOnly || completed.has(roleKey(j)) || /\bvp\b|vice president|agentic|engineering lead/i.test(j.title)) continue;
    // Foreign eligibility questions contradict the preferred India location; omit until clarified.
    if (j.foreignEligibilityConflict || (j.questions || []).some(q => /united states|czech republic|united kingdom/i.test(q.label))) continue;
    const key = `${roleKey(j)}|${j.location.toLowerCase()}`;
    if (seen.has(key)) continue; seen.add(key);
    const questions = (j.questions || []).filter(q => !resolve(q, profile, state.answers, q.origin, j)).map(q => q.label);
    const uncertain = j.status === 'submission_uncertain';
    const action = uncertain ? 'Check whether already submitted before applying again' : j.manualAction || (j.requiresVerification ? 'Complete portal verification, then apply manually' : questions.length ? `Complete required questions: ${questions.join('; ')}` : j.status === 'queued' ? 'Queued for worker; coordinate before submitting manually' : 'Worker blocked: open the direct job link and complete manually');
    jobs.push({ company: j.company, title: j.title, location: j.location, category: j.category || 'unverified', source: j.source || 'Company career site', applyLink: j.applyLink, salaryStatus: match.salaryStatus, score: match.score, priority: j.manualPriority || 0, applicationStatus: j.status || 'not_applied', action, blocker: j.reviewNote || j.reason || '', evidenceLevel: j.evidenceLevel || 'Company job description previously fetched; vacancy availability needs recheck', checkedAt: j.checkedAt || j.discoveredAt || '', description: j.description });
  }
  jobs.sort((a,b) => b.priority - a.priority || b.score - a.score);
  return { generatedAt: new Date().toISOString(), day: store.indiaDay(), count: jobs.length, jobs };
}
function save() {
  const result = build(), dir = path.join(store.ROOT, 'reports'), name = `shortlist-${result.day}`;
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(result, null, 2), { mode: 0o600 });
  const cols = ['company','title','location','source','applicationStatus','salaryStatus','action','blocker','evidenceLevel','checkedAt','applyLink'];
  fs.writeFileSync(path.join(dir, `${name}.csv`), '\ufeff' + [cols.map(csvCell).join(','), ...result.jobs.map(j => cols.map(c => csvCell(j[c])).join(','))].join('\r\n'), { mode: 0o600 });
  fs.writeFileSync(path.join(dir, `${name}.html`), `<!doctype html><meta charset="utf-8"><title>Backend job shortlist</title><style>body{font:15px system-ui;margin:24px;color:#17243b}table{border-collapse:collapse;width:100%}td,th{border:1px solid #cbd5e1;padding:12px;text-align:left;vertical-align:top}th{background:#eff3f8}small{color:#475569}</style><h1>Backend job shortlist — ${result.day}</h1><p>${result.count} relevant opportunities. Generated ${escape(result.generatedAt)}.</p><p>These are job leads, not confirmed submissions. Undisclosed salaries remain unverified against your ₹26 LPA minimum. Search-index leads require checking that the vacancy is still open. Coordinate queued applications with the worker to avoid duplicates.</p><table><tr><th>Company / direct job link</th><th>Location / source</th><th>Action / blocker</th><th>Evidence</th></tr>${result.jobs.map(j => `<tr><td><b>${escape(j.company)}</b><br><a href="${escape(j.applyLink)}" target="_blank" rel="noopener noreferrer">${escape(j.title)}</a><br><small>Salary ${escape(j.salaryStatus)} · ${escape(j.applicationStatus)}</small></td><td>${escape(j.location)}<br>${escape(j.source)}</td><td><b>${escape(j.action)}</b><br>${escape(j.blocker)}</td><td>${escape(j.evidenceLevel)}<br>${escape(j.checkedAt)}</td></tr>`).join('')}</table>`, { mode: 0o600 });
  return result;
}
module.exports = { build, save };
