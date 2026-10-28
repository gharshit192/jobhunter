const crypto = require('node:crypto');
function clean(html = '') { const cheerio = require('cheerio'); let text = cheerio.load(String(html), null, false).text(); if (/<\/?[a-z][^>]*>/i.test(text)) text = cheerio.load(text, null, false).text(); return text.replace(/\s+/g, ' ').trim(); }
// Hand-recorded leads (an email or recruiter form) have no link; they must not break duplicate checks.
function canonical(url) { let u; try { u = new URL(url); } catch { return String(url || ''); } ['utm_source', 'utm_medium', 'utm_campaign', 'gh_src', 'source', 'trid'].forEach(k => u.searchParams.delete(k)); u.hash = ''; return u.toString().replace(/\/$/, ''); }
function key(job) { return crypto.createHash('sha256').update(`${job.company.toLowerCase()}|${job.requisitionId || canonical(job.applyLink)}`).digest('hex').slice(0, 24); }
function salaryMaxLpa(job) {
  if (Number.isFinite(job.salaryMaxLpa)) return job.salaryMaxLpa;
  const text = String(job.salary || '');
  if (/USD|EUR|GBP|\$/i.test(text)) return null;
  if (/lpa|lakhs?|lacs?/i.test(text)) {
    const numbers = text.match(/\d+(?:\.\d+)?/g);
    return numbers ? Math.max(...numbers.map(Number)) : null;
  }
  return null;
}
// Early applicants get read: postings older than a week are skipped, and fresher ones go first.
const MAX_AGE_DAYS = 7;
// Turn "Just now", "Posted Today", "3 days ago", "Posted 30+ Days Ago" or an ISO date into an ISO timestamp.
function postedFrom(text, now = Date.now()) {
  const t = String(text || '').toLowerCase().trim();
  if (!t) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(t) && !Number.isNaN(Date.parse(text))) return new Date(text).toISOString();
  if (/just now|few (?:minutes|hours)|today|\b\d+\s*(?:min|minute|hour|hr)s?\b.*ago|\b(?:an?|one) hour ago/.test(t)) return new Date(now).toISOString();
  if (/yesterday/.test(t)) return new Date(now - 86400000).toISOString();
  const m = t.match(/(\d+)\+?\s*(day|week|month|year)s?/);
  if (!m) return null;
  const days = Number(m[1]) * { day: 1, week: 7, month: 30, year: 365 }[m[2]];
  return new Date(now - days * 86400000).toISOString();
}
// Days since posting; when the site gave no date, days since the worker first saw it (the posting is at least that old).
function ageDays(job, now = Date.now()) {
  const at = Date.parse(job.publishedAt || '') || Date.parse(job.discoveredAt || '');
  return at ? Math.max(0, (now - at) / 86400000) : null;
}
// 0: posted within a day, 1: within 3 days, 2: within a week or date unknown.
function freshness(job) {
  const age = Date.parse(job.publishedAt || '') ? ageDays(job) : null;
  return age === null ? 2 : age <= 1 ? 0 : age <= 3 ? 1 : 2;
}
// Recruiters see many applications to one employer as spam: at most two per company, and never the same role twice (reposts included).
const MAX_PER_COMPANY = 2;
const COMPANY_SUFFIX = /\b(?:private|pvt|limited|ltd|inc|llc|plc|corp|corporation|technologies|technology|systems|software|solutions|services|consulting|global|india|group|labs|co)\b\.?/g;
function companyKey(name) { return String(name || '').toLowerCase().replace(/\(.*?\)/g, '').replace(COMPANY_SUFFIX, '').replace(/[^a-z0-9]/g, ''); }
function repeatReason(job, history) {
  const k = companyKey(job.company);
  if (!k) return null;
  const same = history.filter(h => h.id !== job.id && companyKey(h.company) === k);
  if (same.some(h => normalizeTitle(h.title) === normalizeTitle(job.title))) return 'Already applied to this role at this company (repost)';
  if (same.length >= MAX_PER_COMPANY) return `Already ${same.length} applications at ${job.company}; limit is ${MAX_PER_COMPANY} per company`;
  return null;
}
function evaluate(job, profile) {
  const reasons = [], blocked = [];
  const title = job.title.toLowerCase(), location = (job.location || '').toLowerCase();
  const desc = clean(job.description).toLowerCase();
  if ((profile.excludedCompanies || []).some(c => c.toLowerCase() === job.company.toLowerCase())) blocked.push('Excluded company');
  if (ageDays(job) > MAX_AGE_DAYS) blocked.push('Posted more than a week ago');
  if (/train(?:ing)? (?:ai|llm|foundation(?:al)?) models?|ai (?:training|tutor)|rlhf|data annotation|\$\d+\s*\/\s*h(?:ou)?r/i.test(`${title} ${(job.description || '').slice(0, 3000)}`)) blocked.push('AI-training gig, not a full-time role');
  if (/intern\b|internship|\bcontract\b|freelance|temporary|part.time/.test(`${title} ${job.employmentType || ''}`.toLowerCase())) blocked.push('Not a full-time role');
  if (/\b(qa|sdet|test engineer|in test|testing|support engineer|frontend|front.end|ui|ux|react|angular|ios|android|mobile|golang|c\+\+|data engineer|data scientist|data analyst|devops|site reliability|sales|recruiter)\b/.test(title)) blocked.push('Outside backend role preferences');
  if (!/engineer|developer|\bsde\b|software|backend|back.end/.test(title)) blocked.push('Not a backend engineering title');
  if (/account|marketing|recruit|human resources|\bhr\b|customer|finance analyst|business analyst|sales|people|rewards|payable|procurement/.test(title)) blocked.push('Outside your backend engineering domain');
  if (/principal|\barchitect\b|engineering manager|manager.*software|software.*manager|director|head of|graduate|fresher|junior|software engineer i\b/.test(title)) blocked.push('Outside agreed seniority');
  const cities = profile.cities || [];
  const cityMatch = cities.some(city => location.includes(city.toLowerCase())) || (cities.includes('Gurgaon') && /gurugram/.test(location));
  const remote = /remote|work.from.home/.test(location) || job.isRemote === true;
  const inIndia = /\bindia\b|\bworldwide\b|\banywhere\b/.test(location);
  const foreignOnly = /united states|\busa\b|\bus only\b|\buk\b|europe|emea|germany|singapore|canada|australia/.test(location) && !/india|worldwide/.test(location);
  if (!(cityMatch || (remote && inIndia && !foreignOnly))) blocked.push('Location not confirmed within your preferences');
  const maxSalary = salaryMaxLpa(job);
  if (maxSalary !== null && maxSalary < profile.minimumCtcLpa) blocked.push(`Published salary maximum below ₹${profile.minimumCtcLpa} LPA`);
  const experiencePatterns = [ /(?:at least|minimum(?: of)?|minimum experience[: ]*|total experience[: ]*)\s*(\d+)\s*\+?\s*years?/g, /\b(\d+)\s*(?:[-–]|to)\s*\d+\+?\s*years?\s+(?:of\s+)?[a-z -]{0,60}?experience/g, /\b(\d+)\+\s*years?\s+(?:experience|of experience|of relevant|of professional|building|developing|designing|in software)/g ];
  const minimums = experiencePatterns.flatMap(pattern => [...desc.matchAll(pattern)].map(m => Number(m[1])));
  if (minimums.some(n => n > profile.experienceYears)) blocked.push('Experience requirement exceeds profile');
  let score = 0;
  const keywords = [ ['java', 12], ['kotlin', 10], ['spring', 15], ['kafka', 10], ['microservices', 8], ['mongodb', 6], ['redis', 4], ['node.js', 6], ['nodejs', 6], ['gcp', 5], ['google cloud', 5], ['kubernetes', 4], ['inventory', 5], ['logistics', 5], ['commerce', 5] ];
  for (const [term, points] of keywords) if (new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(`${title} ${desc}`)) { score += points; reasons.push(term); }
  const coreStack = reasons.some(r => ['java', 'kotlin', 'spring', 'node.js', 'nodejs'].includes(r));
  if (/backend|back.end|java|spring|kotlin/.test(title)) score += 20;
  if (/senior|\bii\b|\b2\b|lead/.test(title)) score += 10;
  const pythonOnly = /python/.test(title) && !/java|kotlin|node|spring/.test(title);
  if (!coreStack && !pythonOnly) blocked.push('No confirmed Java/Kotlin/Spring Boot/Node.js requirement');
  if (/\b(?:full.?stack|fullstack|angular|react|ai engineer|machine learning|ml engineer|analytics portal|sterling developer)\b/.test(title)) blocked.push('Full-stack role needs your review; automatic applications target backend roles');
  if (pythonOnly) reasons.push('Python allocation: at most 1 per 100 applications');
  if (score < 25 && !pythonOnly) blocked.push('Insufficient evidence of stack match');
  // A LinkedIn-only alert carries no description, so its stack cannot be checked; you review it before applying by hand.
  if (job.ats === 'linkedin_manual' && !desc) for (const unknown of ['No confirmed Java/Kotlin/Spring Boot/Node.js requirement', 'Insufficient evidence of stack match']) { const i = blocked.indexOf(unknown); if (i >= 0) blocked.splice(i, 1); }
  return { eligible: !blocked.length, score: Math.min(score, 100), reasons, blocked, pythonOnly, salaryStatus: maxSalary === null ? 'unverified' : 'published' };
}
function selectNext(jobs, submitted, profile) {
  const settings = require('./store').state().settings;
  // Workday is skipped by choice; portals that need a real window wait for the quiet hours.
  // Daily quota per platform (Naukri 20, 5 each elsewhere); company job boards share one quota.
  const platform = j => ['greenhouse', 'lever', 'smartrecruiters', 'workday'].includes(j.ats) ? 'company' : j.ats;
  const quotas = settings.quotas || {};
  const withinQuota = j => quotas[platform(j)] === undefined || submitted.filter(x => platform(x) === platform(j)).length < quotas[platform(j)];
  // LinkedIn-only alert jobs are for the candidate to apply to by hand; the worker never opens LinkedIn.
  const allowed = j => j.ats !== 'linkedin_manual' && !(settings.skipAts || []).includes(j.ats) && (j.ats !== 'naukri' || require('./browser').quietHours(settings)) && withinQuota(j);
  const history = require('./store').state().jobs.filter(j => APPLIED.includes(j.status));
  const eligible = jobs.filter(j => j.status === 'queued' && allowed(j) && evaluate(j, profile).eligible && !j.match?.pythonOnly && !repeatReason(j, history));
  // Startups count with product companies when balancing against service companies.
  const productCount = submitted.filter(j => ['product', 'startup'].includes(j.category)).length;
  const serviceCount = submitted.filter(j => j.category === 'service').length;
  const wanted = productCount <= serviceCount ? 'product' : 'service';
  const kind = j => j.category === 'startup' ? 'product' : j.category;
  const supported = job => ['greenhouse', 'lever', 'smartrecruiters', 'linkedin', 'workday', 'naukri', 'wellfound'].includes(job.ats) || /^(?:https:\/\/)?(?:job-boards|boards)\.greenhouse\.io\/|^https:\/\/jobs(?:\.eu)?\.lever\.co\/|^https:\/\/jobs\.smartrecruiters\.com\//.test(job.applyLink);
  // Companies known for LeetCode-style rounds still get applications, but after the rest of the queue.
  const heavy = job => (profile.dsaHeavyCompanies || []).some(c => c.toLowerCase() === job.company.toLowerCase());
  // Inside the quiet hours, do the window-only portal first so the browser switches mode once.
  const quiet = j => Number(j.ats === 'naukri');
  // Among Naukri jobs, the newest discovery goes first: early applicants get read.
  const fresh = (a, b) => a.ats === 'naukri' && b.ats === 'naukri' ? String(b.discoveredAt || '').localeCompare(String(a.discoveredAt || '')) : 0;
  // Newest first within the same freshness band, for every source.
  const newest = (a, b) => (Date.parse(b.publishedAt || b.discoveredAt || '') || 0) - (Date.parse(a.publishedAt || a.discoveredAt || '') || 0);
  return eligible.sort((a, b) => Number(supported(b)) - Number(supported(a)) || freshness(a) - freshness(b) || quiet(b) - quiet(a) || fresh(a, b) || newest(a, b) || Number(heavy(a)) - Number(heavy(b)) || Number(kind(b) === wanted) - Number(kind(a) === wanted) || b.match.score - a.match.score)[0];
}
const APPLIED = ['submitted', 'submission_uncertain', 'filling'];
function normalizeTitle(title) { return title.toLowerCase().replace(/[^a-z0-9]/g, ''); }
module.exports = { companyKey, repeatReason, APPLIED, MAX_PER_COMPANY, clean, canonical, key, salaryMaxLpa, evaluate, selectNext, postedFrom, ageDays, freshness, MAX_AGE_DAYS };
