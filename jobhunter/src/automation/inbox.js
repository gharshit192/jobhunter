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
const IGNORE = /security code|verification code|verify your (?:email|account)|password reset|one.time password|\botp\b|job alert|jobs you may be interested|new jobs? (?:for|matching)|recommended jobs|newsletter|webinar|apply now|jobs? matching your profile|new job match|\bopening at\b|^hiring \|/i;
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
        // Personal mail from a company you applied to is kept even if it fits no category;
        // bulk mail is not, or brand newsletters (Tata NeuCard, Tata 1mg) land under a Tata application.
        if (!category && company && !bulk) category = 'other';
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
    for (const item of items) if (item.company && !item.portal) for (const j of linkable(item, s.jobs)) if (!j.response || RANK.indexOf(item.category) < RANK.indexOf(j.response.category) || (item.category === j.response.category && j.response.date < item.date)) j.response = { category: item.category, date: item.date, subject: item.subject }; });
  store.write('inbox', { checkedAt: new Date().toISOString(), items });
  const fresh = items.filter(i => !previous.items.some(p => p.id === i.id));
  if (fresh.length) store.event(`Inbox: ${fresh.length} new employer emails (${['action', 'interview', 'assessment', 'recruiter', 'rejected', 'received', 'other'].map(c => `${fresh.filter(i => i.category === c).length} ${c}`).filter(t => !t.startsWith('0')).join(', ')})${fresh.some(i => i.spam) ? ' — some were in Spam' : ''}`);
  return { connected: true, checked, items };
}
// One entry per conversation: calendar updates, reminders and your own replies collapse into the latest employer email.
function threadKey(item) {
  const subject = item.subject.toLowerCase()
    .replace(/^(?:(?:re|fwd?|fw|aw)\s*:\s*|(?:updated |new )?invitation(?: from an unknown sender)?\s*:\s*|accepted\s*:\s*|declined\s*:\s*|reminder\s*:\s*)+/g, '')
    .replace(/\s@\s.*$/, '').replace(/[^a-z0-9]+/g, ' ').trim();
  return `${(item.company || item.from.replace(/.*<|>.*/g, '')).toLowerCase()}|${subject}`;
}
function dedupe(items, ownAddresses = []) {
  const own = ownAddresses.filter(Boolean).map(a => a.toLowerCase());
  const latest = new Map();
  for (const item of items) {
    if (own.some(a => item.from.toLowerCase().includes(a))) continue;
    const k = threadKey(item), prev = latest.get(k);
    if (!prev || prev.date < item.date) latest.set(k, item);
  }
  return [...latest.values()].sort((a, b) => b.date.localeCompare(a.date));
}
function ownAddresses() { return [store.read('email-connection', {})?.email, store.read('profile', {})?.email]; }
// A reply that names a specific role belongs to that application only; a generic one (no role in the subject) applies to all at the company.
// The most important reply wins: an unconfirmed application or an interview invite is never hidden behind a later receipt.
// An email that names neither the role nor comes from the company's own domain (an agency thread mentioning
// "Infosys") cannot tell which of several applications it answers, so it links to none of them.
function linkable(item, jobs) {
  const matches = jobs.filter(j => j.status === 'submitted' && j.company.toLowerCase().includes(item.company.toLowerCase()) && Date.parse(item.date) >= (Date.parse(j.submittedAt || '') || 0) - 86400000 && replyFits(item, j));
  if (matches.length <= 2 || ROLE_NAMED.test(item.subject.toLowerCase())) return matches;
  const domain = (item.from.match(/@([^>\s]+)/) || ['', ''])[1].toLowerCase();
  const stem = item.company.toLowerCase().replace(/[^a-z0-9 ]/g, '').split(' ')[0];
  return stem.length > 2 && domain.includes(stem) ? matches : [];
}
const ROLE_NAMED = /engineer|developer|\bsde\b|lead|architect/;
const RANK = ['action', 'interview', 'assessment', 'rejected', 'recruiter', 'received', 'other'];
function replyFits(item, job) {
  const subject = item.subject.toLowerCase().replace(/[^a-z0-9]+/g, ' ');
  const words = t => t.toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ').filter(w => w.length > 2 && !/^(?:the|and|for|with)$/.test(w));
  const roleNamed = ROLE_NAMED.test(subject);
  if (!roleNamed) return true;
  const title = words(job.title);
  return title.filter(w => subject.includes(w)).length >= Math.min(2, title.length);
}
// Only mail a recruiter or hiring team sent about you is listed: receipts, newsletters and the portals'
// mass notices ("2 recruiters expressed interest", "Urgently hiring for…") are not recruiter contact.
const SHOWN = ['action', 'interview', 'assessment', 'recruiter', 'rejected'];
const MASS_NOTICE = /naukrialerts@|recruiter\(s\) expressed interest|urgently hiring for/i;
const SHARED_DOMAIN = /gmail|yahoo|outlook|hotmail|hackerrank|greenhouse|lever|smartrecruiters|workday|ashby|naukri|linkedin|google/i;
// One contact per employer: several emails from the same recruiter (Loadsmart round 1, round 2, a reschedule) are one call, shown by the latest.
function contactKey(item) {
  const domain = (item.from.match(/@([^>\s]+)/) || ['', ''])[1].toLowerCase();
  if (domain && !SHARED_DOMAIN.test(domain)) return domain.split('.').slice(-2)[0];
  return (item.company || item.from.replace(/<.*$/, '').trim().split(/\s+/)[0] || domain).toLowerCase();
}
function contacts(items) {
  const latest = new Map();
  for (const i of items) if (['interview', 'assessment', 'recruiter'].includes(i.category)) { const k = contactKey(i), prev = latest.get(k); if (!prev || prev.date < i.date) latest.set(k, i); }
  const label = i => { const domain = (i.from.match(/@([^>\s]+)/) || ['', ''])[1].toLowerCase(); const stem = domain && !SHARED_DOMAIN.test(domain) ? domain.split('.').slice(-2)[0] : ''; const name = i.from.replace(/<.*$/, '').replace(/hiring team|careers|recruiting( at)?/ig, '').trim(); return i.company || (stem ? stem[0].toUpperCase() + stem.slice(1) : name); };
  return [...latest.values()].map(i => ({ ...i, label: label(i) })).sort((a, b) => b.date.localeCompare(a.date));
}
function summary() {
  const { checkedAt, items: stored } = store.read('inbox', { checkedAt: null, items: [] });
  const items = dedupe(stored.filter(i => SHOWN.includes(i.category) && !MASS_NOTICE.test(`${i.from} ${i.subject}`) && !ALERT_SENDERS.test(i.from) && !IGNORE.test(i.subject) && !MARKETING.test(i.subject)), ownAddresses());
  const counts = {}; for (const i of items) counts[i.category] = (counts[i.category] || 0) + 1;
  return { checkedAt, counts, items, contacts: contacts(items) };
}
module.exports = { scan, summary, classify, dedupe, contacts };
