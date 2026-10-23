const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const store = require('./store');
// Track employer replies to applications. Only sender, subject, date and a category are kept; bodies are read in memory to classify and never stored.
// Order matters: rejections often thank you first, confirmations often mention "next steps".
const CATEGORIES = [
  // A step only you can take (confirm the application, finish an account); without it some portals treat the application as inactive.
  ['action', /confirm your application|please confirm (?:your|the) application|complete your application|finish your application|create an? .{0,30}account to (?:confirm|complete|continue)/i],
  ['rejected', /unfortunately|not (?:be )?(?:moving|progressing) forward|decided to (?:move|proceed) with other|other candidates|not (?:been )?selected|position has been filled|will not be (?:proceeding|moving)|regret to inform/i],
  ['assessment', /assessment|coding (?:test|challenge)|hackerrank|codility|hackerearth|codesignal|take.home|online test|imocha|mettl/i],
  ['interview', /interview|schedule (?:a )?(?:call|time|chat|meeting)|shortlisted|technical round|calendly\.com|meet\.google\.com|zoom\.us\/j|teams\.microsoft\.com\/l\/meetup/i],
  ['received', /(?:thank you|thanks) for (?:applying|your application|your interest)|application (?:has been |was )?(?:successfully )?(?:received|submitted)|we(?:'ve| have) received your application/i],
  ['recruiter', /recruit(?:er|ing|ment)|talent acquisition|hiring for|opportunity with|exciting (?:role|opportunity)|your profile|are you (?:open|interested)|job opening/i],
];
const ATS_SENDERS = /greenhouse|lever\.co|myworkday|workday\.com|smartrecruiters|ashbyhq|linkedin\.com|naukri|instahyre|hirist|icims|successfactors|taleo|eightfold|phenom/i;
// Job alerts, connection requests and promotions are not replies to an application.
const ALERT_SENDERS = /jobs-noreply@linkedin\.com|invitations@linkedin\.com|jobalerts?|newsletter|marketing|promo|digest|ambitionbox|quora|medium\.com|glassdoor/i;
const MARKETING = /top companies are hiring|hiring on naukri right now|premium|% off|insights|fresh opportunities|recruitment 20\d\d|lakh.?s salary|resume will be|your application will be|we are impressed|finish your profile|immediate joiners preferred|is hiring for|^job \|/i;
const IGNORE = /security code|verification code|verify your (?:email|account)|password reset|one.time password|\botp\b|job alert|jobs you may be interested|new jobs? (?:for|matching)|recommended jobs|newsletter|webinar|jobs? matching your profile|new job match|\bopening at\b|^hiring \|/i;
// The subject decides first: "Application ... successfully submitted" is a receipt even if the body mentions an interview process.
const RECEIPT_SUBJECT = /application (?:to .{1,60} )?(?:was |has been )?(?:successfully )?(?:submitted|received)|thank(?:s| you) for (?:applying|your application)/i;
// Curly apostrophes are common ("we’ve"); "active application for another position" is EPAM's note that a further application was only recorded as interest.
const RECEIPT_BODY = /(?:confirm that )?we(?:['’]ve| have) received your application|thanks? (?:you )?for (?:taking the time to )?apply|(?:you have|there is) an active application for another position|only (?:be able to )?(?:connect|contact) (?:with )?(?:those|candidates) who are shortlisted/i;
const INVITE = /invitation to (?:your|an?) (?:technical )?interview|accept (?:the )?interview|interview scheduled|invite you (?:to|for) (?:an? )?(?:interview|call|discussion)|schedule (?:an? )?(?:interview|call|time)|calendly\.com|meet\.google\.com|zoom\.us\/j|teams\.microsoft\.com\/l\/meetup|available for (?:a|an) (?:call|interview)/i;
function classify(text, subject = '') { if (CATEGORIES[0][1].test(subject)) return 'action'; if (RECEIPT_SUBJECT.test(subject)) return 'received'; if (INVITE.test(text)) return 'interview'; if (RECEIPT_BODY.test(text) && !INVITE.test(text)) return 'received'; for (const [category, pattern] of CATEGORIES) if (pattern.test(text)) return category; return null; }
function companyFor(companies, from, subject, body) {
  const hay = `${from} ${subject} ${body.slice(0, 1500)}`.toLowerCase();
  return companies.find(c => c.length > 2 && new RegExp(`\\b${c.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(hay));
}
// Recruiter messages relayed by the job portals (not job alerts): these are the closest thing to a call.
const PORTAL_MESSAGE = /sent you a (?:new )?message|new message from|inmail|wants to connect with you about|is interested in your profile|(?:invited|invites) you to apply|recruiters? (?:expressed interest|viewed your profile|contacted you|sent you)|message from (?:a )?recruiter|shortlisted you/i;
const PORTAL_SENDERS = /messages-noreply@linkedin\.com|inmail-hit-reply@linkedin\.com|hit-reply@linkedin\.com|naukri\.com|instahyre\.com|hirist\.(?:tech|com)|wellfound\.com|angel\.co|cutshort\.io|iimjobs\.com|foundit\.in/i;
async function scan({ days } = {}) {
  const credentials = store.read('email-connection', null);
  if (!credentials) return { connected: false, items: store.read('inbox', { items: [] }).items };
  const state = store.state();
  const applied = state.jobs.filter(j => j.status === 'submitted');
  // Company names as they appear in mail: strip suffixes like "| Poultry Management Software" or "Private Limited".
  const companies = [...new Set(applied.map(j => j.company.split(/\s[|(–-]\s?/)[0].replace(/\b(?:private|pvt\.?|limited|ltd\.?|inc\.?|llc|technologies|systems|software|solutions)\b/gi, '').trim()).filter(Boolean))];
  // Look back to the first application (minus a day), or the requested window.
  const first = applied.map(j => Date.parse(j.submittedAt || '')).filter(Number.isFinite).sort((x, y) => x - y)[0];
  const since = days ? new Date(Date.now() - days * 86400000) : new Date((first || Date.now() - 30 * 86400000) - 86400000);
  const previous = store.read('inbox', { items: [] });
  const known = new Map(previous.items.map(i => [i.id, i]));
  const seen = new Set(store.read('inbox-seen', []));
  const client = new ImapFlow({ host: 'imap.gmail.com', port: 993, secure: true, auth: { user: credentials.email, pass: credentials.appPassword }, logger: false, connectionTimeout: 15000, greetingTimeout: 10000 });
  // ImapFlow emits socket timeouts as 'error' events; without a listener they crash the whole worker.
  client.on('error', error => store.event(`Inbox tracking: Gmail connection error (${error.code || error.message})`));
  let checked = 0;
  try {
    await client.connect();
    // All Mail covers archived and every category tab; Spam is separate in Gmail.
    const boxes = (await client.list()).filter(b => b.specialUse === '\\All' || b.specialUse === '\\Junk').map(b => ({ path: b.path, spam: b.specialUse === '\\Junk' }));
    if (!boxes.length) boxes.push({ path: 'INBOX', spam: false });
    for (const box of boxes) {
      await client.mailboxOpen(box.path, { readOnly: true });
      const uids = await client.search({ since }, { uid: true }) || [];
      for (const uid of uids.slice(-3000)) {
        const head = await client.fetchOne(uid, { envelope: true, size: true, headers: ['list-unsubscribe'] }, { uid: true });
        if (!head) continue;
        const id = head.envelope.messageId || `${box.path}:${uid}`;
        if (known.has(id) || seen.has(id)) continue;
        seen.add(id);
        const from = (head.envelope.from || []).map(f => `${f.name || ''} <${f.address || ''}>`).join(', ');
        const subject = head.envelope.subject || '';
        if (IGNORE.test(subject) || MARKETING.test(subject) || ALERT_SENDERS.test(from)) continue;
        const portal = PORTAL_SENDERS.test(from) && PORTAL_MESSAGE.test(subject);
        const fromAts = ATS_SENDERS.test(from);
        const subjectHit = companyFor(companies, from, subject, '');
        // Bulk mail (has an unsubscribe header) counts only when it names a company you applied to, or is a portal recruiter message.
        const bulk = /list-unsubscribe/i.test(String(head.headers || ''));
        if (bulk && !subjectHit && !portal && !/invitation to apply/i.test(subject)) continue;
        if (!portal && !fromAts && !subjectHit && !/application|interview|recruit|opportunit|role|position|candidate|hiring|profile/i.test(subject)) continue;
        checked++;
        let body = '';
        if (head.size < 300000) { const full = await client.fetchOne(uid, { source: true }, { uid: true }); const mail = await simpleParser(full.source, { skipTextToHtml: true }); body = String(mail.text || '').replace(/\s+/g, ' '); }
        if (IGNORE.test(body.slice(0, 600))) continue;
        const company = companyFor(companies, from, subject, body);
        let category = portal ? 'recruiter' : classify(`${subject} ${body.slice(0, 3000)}`, subject);
        // Anything from a company you applied to is kept, even if it fits no category.
        if (!category && company) category = 'other';
        if (!category || (!company && !fromAts && !portal && ['received', 'other'].includes(category))) continue;
        known.set(id, { id, date: new Date(head.envelope.date).toISOString(), from: from.slice(0, 160), subject: subject.slice(0, 200), company: company || '', category, spam: box.spam || undefined, portal: portal ? (from.match(PORTAL_SENDERS) || [''])[0] : undefined });
      }
    }
  } catch (error) { store.event(`Inbox tracking could not read Gmail: ${error.code || error.message}`); }
  finally { await client.logout().catch(() => {}); }
  store.write('inbox-seen', [...seen].slice(-20000));
  // Digests and job alerts can name a company you applied to (a Quora post about Infosys); they are never replies.
  const items = [...known.values()].filter(i => !ALERT_SENDERS.test(i.from) && !MARKETING.test(i.subject)).sort((a, b) => b.date.localeCompare(a.date)).slice(0, 1000);
  // Link replies to applications so the dashboard and reports show the latest response per job.
  // Replies dated more than a day before the application (recorded later than it happened) cannot belong to it.
  // Rebuilt from scratch each scan, so a corrected rule also clears earlier wrong links.
  store.mutate(s => { for (const j of s.jobs) delete j.response;
    for (const item of items) if (item.company && !item.portal) for (const j of s.jobs) if (j.status === 'submitted' && j.company.toLowerCase().includes(item.company.toLowerCase()) && Date.parse(item.date) >= (Date.parse(j.submittedAt || '') || 0) - 86400000 && replyFits(item, j) && (!j.response || RANK.indexOf(item.category) < RANK.indexOf(j.response.category) || (item.category === j.response.category && j.response.date < item.date))) j.response = { category: item.category, date: item.date, subject: item.subject }; });
  store.write('inbox', { checkedAt: new Date().toISOString(), items });
  const fresh = items.filter(i => !previous.items.some(p => p.id === i.id));
  if (fresh.length) store.event(`Inbox: ${fresh.length} new employer emails (${['action', 'interview', 'assessment', 'recruiter', 'rejected', 'received', 'other'].map(c => `${fresh.filter(i => i.category === c).length} ${c}`).filter(t => !t.startsWith('0')).join(', ')})${fresh.some(i => i.spam) ? ' — some were in Spam' : ''}`);
  return { connected: true, checked, items };
}
// A reply that names a specific role belongs to that application only; a generic one (no role in the subject) applies to all at the company.
// The most important reply wins: an unconfirmed application or an interview invite is never hidden behind a later receipt.
const RANK = ['action', 'interview', 'assessment', 'rejected', 'recruiter', 'received', 'other'];
function replyFits(item, job) {
  const subject = item.subject.toLowerCase().replace(/[^a-z0-9]+/g, ' ');
  const words = t => t.toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ').filter(w => w.length > 2 && !/^(?:the|and|for|with)$/.test(w));
  const roleNamed = /engineer|developer|\bsde\b|lead|architect/.test(subject);
  if (!roleNamed) return true;
  const title = words(job.title);
  return title.filter(w => subject.includes(w)).length >= Math.min(2, title.length);
}
function summary() {
  const { checkedAt, items } = store.read('inbox', { checkedAt: null, items: [] });
  const counts = {}; for (const i of items) counts[i.category] = (counts[i.category] || 0) + 1;
  return { checkedAt, counts, items };
}
module.exports = { scan, summary, classify };
