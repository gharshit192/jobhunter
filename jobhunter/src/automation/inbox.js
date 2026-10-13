const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const store = require('./store');
// Track employer replies to applications. Only sender, subject, date and a category are kept; bodies are read in memory to classify and never stored.
// Order matters: rejections often thank you first, confirmations often mention "next steps".
const CATEGORIES = [
  ['rejected', /unfortunately|not (?:be )?(?:moving|progressing) forward|decided to (?:move|proceed) with other|other candidates|not (?:been )?selected|position has been filled|will not be (?:proceeding|moving)|regret to inform/i],
  ['assessment', /assessment|coding (?:test|challenge)|hackerrank|codility|hackerearth|codesignal|take.home|online test|imocha|mettl/i],
  ['interview', /interview|schedule (?:a )?(?:call|time|chat|meeting)|shortlisted|technical round|calendly\.com|meet\.google\.com|zoom\.us\/j|teams\.microsoft\.com\/l\/meetup/i],
  ['received', /(?:thank you|thanks) for (?:applying|your application|your interest)|application (?:has been |was )?(?:successfully )?(?:received|submitted)|we(?:'ve| have) received your application/i],
  ['recruiter', /recruit(?:er|ing|ment)|talent acquisition|hiring for|opportunity with|exciting (?:role|opportunity)|your profile|are you (?:open|interested)|job opening/i],
];
const ATS_SENDERS = /greenhouse|lever\.co|myworkday|workday\.com|smartrecruiters|ashbyhq|linkedin\.com|naukri|instahyre|hirist|icims|successfactors|taleo|eightfold|phenom/i;
// Job alerts, connection requests and promotions are not replies to an application.
const ALERT_SENDERS = /jobs-noreply@linkedin\.com|invitations@linkedin\.com|jobalerts?|newsletter|marketing|promo|digest/i;
const MARKETING = /premium|% off|insights|fresh opportunities|recruitment 20\d\d|lakh.?s salary|resume will be|your application will be|we are impressed|finish your profile|immediate joiners preferred|is hiring for|^job \|/i;
const IGNORE = /security code|verification code|verify your (?:email|account)|password reset|one.time password|\botp\b|job alert|jobs you may be interested|new jobs? (?:for|matching)|recommended jobs|newsletter|webinar/i;
function classify(text) { for (const [category, pattern] of CATEGORIES) if (pattern.test(text)) return category; return null; }
function companyFor(companies, from, subject, body) {
  const hay = `${from} ${subject} ${body.slice(0, 1500)}`.toLowerCase();
  return companies.find(c => c.length > 2 && new RegExp(`\\b${c.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(hay));
}
async function scan({ days = 21 } = {}) {
  const credentials = store.read('email-connection', null);
  if (!credentials) return { connected: false, items: store.read('inbox', { items: [] }).items };
  const state = store.state();
  const applied = state.jobs.filter(j => j.status === 'submitted');
  // Company names as they appear in mail: strip suffixes like "| Poultry Management Software" or "Private Limited".
  const companies = [...new Set(applied.map(j => j.company.split(/\s[|(–-]\s?/)[0].replace(/\b(?:private|pvt\.?|limited|ltd\.?|inc\.?|llc|technologies|systems|software|solutions)\b/gi, '').trim()).filter(Boolean))];
  const previous = store.read('inbox', { items: [] });
  const known = new Map(previous.items.map(i => [i.id, i]));
  const client = new ImapFlow({ host: 'imap.gmail.com', port: 993, secure: true, auth: { user: credentials.email, pass: credentials.appPassword }, logger: false, connectionTimeout: 15000, greetingTimeout: 10000 });
  let checked = 0;
  try {
    await client.connect(); await client.mailboxOpen('INBOX', { readOnly: true });
    const uids = await client.search({ since: new Date(Date.now() - days * 86400000) }, { uid: true }) || [];
    for (const uid of uids.slice(-400)) {
      const id = `${uid}`;
      if (known.has(id)) continue;
      const head = await client.fetchOne(uid, { envelope: true, size: true, headers: ['list-unsubscribe'] }, { uid: true });
      if (!head) continue;
      const from = (head.envelope.from || []).map(f => `${f.name || ''} <${f.address || ''}>`).join(', ');
      const subject = head.envelope.subject || '';
      if (IGNORE.test(subject) || MARKETING.test(subject) || ALERT_SENDERS.test(from)) continue;
      const fromAts = ATS_SENDERS.test(from);
      const subjectHit = companyFor(companies, from, subject, '');
      // Bulk mail (has an unsubscribe header) counts only when it names a company you applied to, or is a portal's recruiter-interest notice.
      const bulk = /list-unsubscribe/i.test(String(head.headers || ''));
      if (bulk && !subjectHit && !/recruiters? (?:expressed interest|viewed|contacted)|invitation to apply/i.test(subject)) continue;
      if (!fromAts && !subjectHit && !/application|interview|recruit|opportunit|role|position|candidate|hiring/i.test(subject)) continue;
      checked++;
      let body = '';
      if (head.size < 300000) { const full = await client.fetchOne(uid, { source: true }, { uid: true }); const mail = await simpleParser(full.source, { skipTextToHtml: true }); body = String(mail.text || '').replace(/\s+/g, ' '); }
      if (IGNORE.test(body.slice(0, 600))) continue;
      const company = companyFor(companies, from, subject, body);
      const category = classify(`${subject} ${body.slice(0, 3000)}`);
      if (!category || (!company && !fromAts && category === 'received')) continue;
      known.set(id, { id, date: new Date(head.envelope.date).toISOString(), from: from.slice(0, 160), subject: subject.slice(0, 200), company: company || '', category });
    }
  } catch (error) { store.event(`Inbox tracking could not read Gmail: ${error.code || error.message}`); }
  finally { await client.logout().catch(() => {}); }
  const items = [...known.values()].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 500);
  // Link replies to applications so the dashboard and reports show the latest response per job.
  store.mutate(s => { for (const item of items) if (item.company) for (const j of s.jobs) if (j.status === 'submitted' && j.company.toLowerCase().includes(item.company.toLowerCase()) && (!j.response || j.response.date < item.date)) j.response = { category: item.category, date: item.date, subject: item.subject }; });
  store.write('inbox', { checkedAt: new Date().toISOString(), items });
  const fresh = items.filter(i => !previous.items.some(p => p.id === i.id));
  if (fresh.length) store.event(`Inbox: ${fresh.length} new employer emails (${['interview', 'assessment', 'recruiter', 'rejected', 'received'].map(c => `${fresh.filter(i => i.category === c).length} ${c}`).filter(t => !t.startsWith('0')).join(', ')})`);
  return { connected: true, checked, items };
}
function summary() {
  const { checkedAt, items } = store.read('inbox', { checkedAt: null, items: [] });
  const counts = {}; for (const i of items) counts[i.category] = (counts[i.category] || 0) + 1;
  return { checkedAt, counts, items };
}
module.exports = { scan, summary, classify };
