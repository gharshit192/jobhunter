const fs = require('node:fs');
const path = require('node:path');
const store = require('./store');
function esc(value) { return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function cell(value) { let text = String(value ?? ''); if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`; return `"${text.replace(/"/g, '""')}"`; }
function build(s, day = store.indiaDay()) {
  const sameDay = value => value && store.indiaDay(new Date(value)) === day;
  const dayJobs = s.jobs.filter(j => sameDay(j.discoveredAt) || sameDay(j.submittedAt) || (j.attempts || []).some(a => sameDay(a.at)));
  const jobs = dayJobs.filter(j => j.status !== 'excluded');
  const submitted = jobs.filter(j => j.status === 'submitted' && sameDay(j.submittedAt));
  return { day, generatedAt: new Date().toISOString(), target: s.settings.dailyTarget, excludedPostings: dayJobs.filter(j => j.status === 'excluded').length, confirmedSubmissions: submitted.length, shortfall: Math.max(0, s.settings.dailyTarget - submitted.length), productSubmissions: submitted.filter(j => j.category === 'product').length, serviceSubmissions: submitted.filter(j => j.category === 'service').length, jobs: jobs.map(j => ({ id: j.id, company: j.company, title: j.title, category: j.category, location: j.location, applyLink: j.applyLink, matchScore: j.match?.score, salaryStatus: j.match?.salaryStatus, status: j.status, reason: j.reason || j.match?.blocked?.join('; ') || '', submittedAt: j.submittedAt || null, confirmation: j.confirmation || null, evidence: j.evidence || null, submissionResponses: j.submissionResponses || [], outcome: j.outcome || '', outcomeAt: j.outcomeAt || '', notes: j.notes || '', contact: j.contact || '', questions: (j.questions || []).map(q => ({ label: q.label, reason: q.reason })), attempts: j.attempts || [] })) };
}
function save(s = store.state(), day = store.indiaDay()) {
  const report = build(s, day);
  const dir = path.join(store.ROOT, 'reports'); fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, `${day}.json`), JSON.stringify(report, null, 2), { mode: 0o600 });
  const columns = ['company', 'title', 'category', 'location', 'status', 'submittedAt', 'applyLink', 'matchScore', 'salaryStatus', 'reason', 'outcome', 'outcomeAt', 'contact', 'notes'];
  const csv = [columns.map(cell).join(','), ...report.jobs.map(j => columns.map(k => cell(j[k])).join(','))].join('\r\n');
  fs.writeFileSync(path.join(dir, `${day}.csv`), '\ufeff' + csv, { mode: 0o600 });
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>JobHunter ${esc(day)}</title><style>body{font:15px system-ui;margin:30px;color:#17243b}table{border-collapse:collapse;width:100%}td,th{padding:10px;text-align:left;border:1px solid #ccd4df}th{background:#eff3f8}.submitted{color:#087542}small{color:#64748b}</style></head><body><h1>Job applications — ${esc(day)}</h1><p><strong>${report.confirmedSubmissions} confirmed submissions</strong> / ${report.target} target · ${report.shortfall} shortfall · Product: ${report.productSubmissions} · Services: ${report.serviceSubmissions}</p><p>Queued, excluded, and blocked jobs are not counted as submitted. Generated ${esc(report.generatedAt)}. Recruiter outcomes are recorded by you.</p><table><thead><tr><th>Company / role</th><th>Location</th><th>Application status</th><th>Confirmation</th><th>Recruiter outcome / notes</th></tr></thead><tbody>${report.jobs.map(j => `<tr><td><strong>${esc(j.company)}</strong><br><a href="${esc(j.applyLink)}">${esc(j.title)}</a><br><small>${esc(j.category)} · ${j.matchScore || 0}% match</small></td><td>${esc(j.location)}<br><small>Salary ${esc(j.salaryStatus)}</small></td><td class="${esc(j.status)}">${esc(j.status)}<br><small>${esc(j.reason)}</small></td><td>${esc(j.submittedAt || '')}<br>${esc(j.confirmation?.text || '')}${j.evidence ? `<br><a href="../evidence/${esc(j.evidence)}">Screenshot</a>` : ''}</td><td>${esc(j.outcome)}<br>${esc(j.contact)}<br>${esc(j.notes)}</td></tr>`).join('')}</tbody></table></body></html>`;
  fs.writeFileSync(path.join(dir, `${day}.html`), html, { mode: 0o600 });
  if (store.read('profile', null)) require('./shortlist').save();
  return report;
}
module.exports = { build, save, cell };
