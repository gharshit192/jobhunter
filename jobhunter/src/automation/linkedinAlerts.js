const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const store = require('./store');
// LinkedIn job-alert emails are turned into applications on the employer's own job board.
// Nothing here contacts LinkedIn: links in these emails are account-tracking links and are never opened.
// Only the plain text (title, company, location, job id) is read.
const SENDERS = ['jobalerts-noreply@linkedin.com', 'jobs-noreply@linkedin.com'];
const EXTRA_LINE = /connections?$|actively hiring|actively recruiting|easy apply|reviewing applicants|responds|apply with resume|early applicant|promoted|alumni|school|^applied on|^view job|^<|^https?:\/\/|\[url\]|^(?:remote|api|aws|java|backend|kotlin|spring)[\w ]* jobs$|jobs in /i;
const SUFFIX = /\b(?:private|pvt|limited|ltd|inc|llc|plc|corp|corporation|technologies|technology|tech|systems|software|solutions|services|consulting|global|india|group|labs|co)\b\.?/g;

function companyKey(name) { return String(name || '').toLowerCase().replace(/\(.*?\)/g, '').replace(SUFFIX, '').replace(/[^a-z0-9]/g, ''); }
function titleTokens(title) { return new Set(String(title || '').toLowerCase().replace(/[^a-z0-9+#]+/g, ' ').split(' ').filter(t => t.length > 1 && !/^(?:the|and|for|with|of|in|at|to|ii|iii|sr|senior|developer|engineer)$/.test(t))); }
function similarTitle(a, b) {
  if (String(a).toLowerCase().replace(/[^a-z0-9]/g, '') === String(b).toLowerCase().replace(/[^a-z0-9]/g, '')) return true;
  const x = titleTokens(a), y = titleTokens(b);
  if (!x.size || !y.size) return false;
  const shared = [...x].filter(t => y.has(t)).length;
  return shared / Math.max(x.size, y.size) >= 0.6;
}
// Each job in an alert is a block: title, company, location, optional extras, then "View job: <link>".
function parseAlert(text) {
  const jobs = [];
  for (const block of String(text || '').split(/-{10,}/)) {
    const view = block.match(/View job:\s*(\S+)/i);
    if (!view) continue;
    const id = (view[1].match(/jobs\/view\/(\d+)/) || [])[1];
    const lines = block.slice(0, view.index).split('\n').map(l => l.trim()).filter(l => l && !EXTRA_LINE.test(l));
    if (lines.length < 3 || !id) continue;
    const [title, company, location] = lines.slice(-3);
    jobs.push({ id, title, company, location: /remote|work from home/i.test(title) && !/remote/i.test(location) ? `${location} (Remote)` : location });
  }
  return jobs;
}
function watchlistCompany(name) {
  const { COMPANIES } = require('./companies');
  const k = companyKey(name);
  return k ? COMPANIES.find(c => companyKey(c.name) === k) : null;
}
// Employer boards to try: the configured one, else public Greenhouse/Lever boards named after the company.
function candidateBoards(company, registered) {
  if (registered?.ats && registered.board) return [{ ats: registered.ats, board: registered.board }];
  const slugs = [...new Set([company.toLowerCase().replace(/[^a-z0-9]/g, ''), companyKey(company)])].filter(s => s.length > 2);
  return slugs.flatMap(board => [{ ats: 'greenhouse', board }, { ats: 'lever', board }]);
}
async function findOnEmployerBoard(alert, profile) {
  const { fetchBoard, discoverCompany } = require('./discovery');
  const registered = watchlistCompany(alert.company);
  const company = registered || { name: alert.company, category: 'unlisted', careersUrl: '' };
  const known = store.state().jobs.find(j => j.ats !== 'linkedin_manual' && j.ats !== 'linkedin' && companyKey(j.company) === companyKey(alert.company) && similarTitle(j.title, alert.title));
  if (known) return known;
  for (const connector of candidateBoards(alert.company, registered)) {
    try {
      const jobs = await fetchBoard(company, connector);
      const match = jobs.find(j => similarTitle(j.title, alert.title));
      if (match) return match;
      if (registered) return null;
    } catch {}
  }
  // A watchlist company without a configured board: inspect its official career page for one.
  if (registered && !registered.ats) {
    try { const { jobs } = await discoverCompany(registered); return jobs.find(j => similarTitle(j.title, alert.title)) || null; } catch {}
  }
  return null;
}
async function scan(profile, onProgress = store.event, { days = 7 } = {}) {
  const credentials = store.read('email-connection', null);
  if (!credentials) return { checked: 0 };
  const { persistJobs } = require('./discovery');
  const seen = new Set(store.read('linkedin-alerts-seen', []));
  const client = new ImapFlow({ host: 'imap.gmail.com', port: 993, secure: true, auth: { user: credentials.email, pass: credentials.appPassword }, logger: false, connectionTimeout: 15000, greetingTimeout: 10000 });
  client.on('error', error => store.event(`LinkedIn alerts: Gmail connection error (${error.code || error.message})`));
  const alerts = [], appliedByYou = [];
  try {
    await client.connect();
    const lock = await client.getMailboxLock('[Gmail]/All Mail');
    try {
      for (const from of SENDERS) {
        const uids = await client.search({ from, since: new Date(Date.now() - days * 86400000) }, { uid: true });
        for (const uid of uids) {
          const { source, envelope } = await client.fetchOne(uid, { source: true, envelope: true }, { uid: true });
          const id = envelope.messageId || `${from}:${uid}`;
          if (seen.has(id)) continue;
          const mail = await simpleParser(source);
          const jobs = parseAlert(mail.text);
          const date = (envelope.date || new Date()).toISOString();
          // "Your application was sent to X": the first job is one you applied to yourself on LinkedIn.
          if (/your application was sent to/i.test(envelope.subject || '') && jobs[0]) appliedByYou.push({ ...jobs.shift(), date });
          for (const job of jobs) alerts.push({ ...job, date });
          seen.add(id);
        }
      }
    } finally { lock.release(); }
  } finally { await client.logout().catch(() => {}); }

  recordOwnApplications(appliedByYou, profile);
  const unique = [...new Map(alerts.map(a => [a.id, a])).values()];
  const already = new Set(store.state().jobs.map(j => (/^linkedin:(\d+)$/.exec(j.requisitionId || '') || [])[1]).filter(Boolean));
  let employer = 0, manual = 0;
  for (const alert of unique.filter(a => !already.has(a.id))) {
    const found = await findOnEmployerBoard(alert, profile);
    if (found) {
      persistJobs([{ ...found, linkedinAlertId: alert.id }], profile);
      employer++;
    } else {
      // LinkedIn-only posting: listed for you to apply with Easy Apply yourself; the worker never opens it.
      persistJobs([{ title: alert.title, company: alert.company, location: alert.location, description: '', source: 'LinkedIn alert', ats: 'linkedin_manual',
        applyLink: `https://www.linkedin.com/jobs/view/${alert.id}/`, requisitionId: `linkedin:${alert.id}`, publishedAt: alert.date, discoveredAt: new Date().toISOString() }], profile);
      manual++;
    }
  }
  holdManualJobs();
  store.write('linkedin-alerts-seen', [...seen].slice(-2000));
  if (unique.length || appliedByYou.length) onProgress(`LinkedIn alerts: ${unique.length} jobs read from email; ${employer} found on employer sites, ${manual} LinkedIn-only for you; ${appliedByYou.length} of your own LinkedIn applications recorded`);
  return { checked: unique.length, employer, manual, appliedByYou: appliedByYou.length };
}
function holdManualJobs() {
  store.mutate(s => {
    for (const j of s.jobs) if (j.ats === 'linkedin_manual' && j.status === 'queued') {
      j.status = 'needs_input'; j.questions = [];
      j.reason = 'LinkedIn only: apply yourself with Easy Apply, then mark it applied (the worker never opens LinkedIn)';
    }
  });
}
// Applications you made yourself on LinkedIn count as submitted, so nothing applies to them again.
function recordOwnApplications(applied, profile) {
  if (!applied.length) return;
  const { persistJobs } = require('./discovery');
  for (const a of applied) {
    const exists = store.state().jobs.find(j => j.requisitionId === `linkedin:${a.id}`);
    if (!exists) persistJobs([{ title: a.title, company: a.company, location: a.location, description: '', source: 'LinkedIn (you applied)', ats: 'linkedin_manual',
      applyLink: `https://www.linkedin.com/jobs/view/${a.id}/`, requisitionId: `linkedin:${a.id}`, publishedAt: a.date, discoveredAt: new Date().toISOString() }], profile);
    store.mutate(s => {
      const j = s.jobs.find(j => j.requisitionId === `linkedin:${a.id}`);
      if (j && j.status !== 'submitted') { j.status = 'submitted'; j.submittedAt = a.date; j.completionMethod = 'You applied on LinkedIn'; j.confirmation = { text: 'LinkedIn email: "Your application was sent"', source: 'LinkedIn confirmation email', at: a.date }; j.reason = ''; }
    });
  }
}
module.exports = { scan, parseAlert, similarTitle, companyKey };
