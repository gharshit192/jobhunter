const crypto = require('node:crypto');
function clean(html = '') { const cheerio = require('cheerio'); let text = cheerio.load(String(html), null, false).text(); if (/<\/?[a-z][^>]*>/i.test(text)) text = cheerio.load(text, null, false).text(); return text.replace(/\s+/g, ' ').trim(); }
function canonical(url) { const u = new URL(url); ['utm_source', 'utm_medium', 'utm_campaign', 'gh_src', 'source', 'trid'].forEach(k => u.searchParams.delete(k)); u.hash = ''; return u.toString().replace(/\/$/, ''); }
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
function evaluate(job, profile) {
  const reasons = [], blocked = [];
  const title = job.title.toLowerCase(), location = (job.location || '').toLowerCase();
  const desc = clean(job.description).toLowerCase();
  if ((profile.excludedCompanies || []).some(c => c.toLowerCase() === job.company.toLowerCase())) blocked.push('Excluded company');
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
  if (maxSalary !== null && maxSalary < profile.minimumCtcLpa) blocked.push('Published salary maximum below ₹26 LPA');
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
  return { eligible: !blocked.length, score: Math.min(score, 100), reasons, blocked, pythonOnly, salaryStatus: maxSalary === null ? 'unverified' : 'published' };
}
function selectNext(jobs, submitted, profile) {
  const eligible = jobs.filter(j => j.status === 'queued' && evaluate(j, profile).eligible && !j.match?.pythonOnly && !submitted.some(s => s.company.toLowerCase() === j.company.toLowerCase() && normalizeTitle(s.title) === normalizeTitle(j.title) && s.location === j.location));
  const productCount = submitted.filter(j => j.category === 'product').length;
  const serviceCount = submitted.filter(j => j.category === 'service').length;
  const wanted = productCount <= serviceCount ? 'product' : 'service';
  const supported = job => ['greenhouse', 'lever', 'smartrecruiters', 'linkedin', 'workday'].includes(job.ats) || /^(?:https:\/\/)?(?:job-boards|boards)\.greenhouse\.io\/|^https:\/\/jobs(?:\.eu)?\.lever\.co\/|^https:\/\/jobs\.smartrecruiters\.com\//.test(job.applyLink);
  // Companies known for LeetCode-style rounds still get applications, but after the rest of the queue.
  const heavy = job => (profile.dsaHeavyCompanies || []).some(c => c.toLowerCase() === job.company.toLowerCase());
  return eligible.sort((a, b) => Number(supported(b)) - Number(supported(a)) || Number(heavy(a)) - Number(heavy(b)) || Number(b.category === wanted) - Number(a.category === wanted) || b.match.score - a.match.score)[0];
}
function normalizeTitle(title) { return title.toLowerCase().replace(/[^a-z0-9]/g, ''); }
module.exports = { clean, canonical, key, salaryMaxLpa, evaluate, selectNext };
