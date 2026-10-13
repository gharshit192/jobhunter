const axios = require('axios');
const cheerio = require('cheerio');
const redirects = require('follow-redirects');
const transport = { request(options, callback) { return redirects[options.protocol === 'https:' ? 'https' : 'http'].request({ ...options, maxHeaderSize: 128 * 1024 }, callback); } };
const { COMPANIES } = require('./companies');
const { clean, key, evaluate, canonical } = require('./matching');
const store = require('./store');
const http = axios.create({ timeout: 18000, transport, maxContentLength: 15 * 1024 * 1024, headers: { 'User-Agent': 'JobHunter/1.0 (personal career search)', Accept: 'application/json,text/html' } });
function safeUrl(url) {
  const u = new URL(url);
  if (u.protocol !== 'https:' || u.username || u.password || !/^[a-z0-9.-]+$/i.test(u.hostname) || /^localhost$|\.local$|^\d+\.\d+\.\d+\.\d+$|^127\.|^0\./i.test(u.hostname)) throw new Error('Use a public HTTPS career URL');
  return u;
}
function detectATS(url) {
  const u = new URL(url), parts = u.pathname.split('/').filter(Boolean);
  if (/^(?:boards|job-boards)\.greenhouse\.io$/.test(u.hostname) && parts[0]) return { ats: 'greenhouse', board: parts[0], id: parts[parts.indexOf('jobs') + 1] };
  if (/^jobs(?:\.eu)?\.lever\.co$/.test(u.hostname) && parts[0]) return { ats: 'lever', board: parts[0], id: parts[1], eu: u.hostname.includes('.eu.') };
  if (/^(?:careers|jobs)\.smartrecruiters\.com$/.test(u.hostname) && parts[0]) return { ats: 'smartrecruiters', board: parts[0] };
  if (/\.myworkdayjobs\.com$/.test(u.hostname)) {
    const tenant = u.hostname.split('.')[0];
    const site = parts.find(p => !/^en[-_]US$|^[a-z]{2}-[A-Z]{2}$/i.test(p));
    if (site) return { ats: 'workday', board: `${tenant}/${site}`, host: u.hostname };
  }
  return null;
}
function baseJob(company, raw) { return { company: company.name, category: company.category, source: 'Company careers', ...raw, discoveredAt: new Date().toISOString() }; }
async function fetchBoard(company, connector) {
  const { ats, board } = connector;
  if (ats === 'workday') {
    const host = connector.host || new URL(company.careersUrl).hostname;
    if (!/\.myworkdayjobs\.com$/.test(host)) throw new Error('Workday host not verified');
    const [tenant, site] = board.split('/');
    const base = `https://${host}/wday/cxs/${tenant}/${site}`;
    const jobs = [];
    for (let offset = 0; offset < 200; offset += 20) {
      const { data } = await http.post(`${base}/jobs`, { appliedFacets: {}, limit: 20, offset, searchText: 'Java' });
      for (const j of data.jobPostings || []) {
        const location = j.locationsText || '';
        if (!/pune|gurgaon|gurugram|indore|jaipur|vadodara|india.*remote|remote.*india/i.test(location)) continue;
        if (/test|qa|sdet|support|principal|architect|director/i.test(j.title)) continue;
        jobs.push(baseJob(company, { title: j.title, location, applyLink: `https://${host}/en-US/${site}${j.externalPath}`, requisitionId: `workday:${tenant}:${(j.bulletFields || [])[0] || j.externalPath}`, ats, detailPath: j.externalPath, description: '' }));
      }
      if (!(data.jobPostings || []).length || offset + 20 >= (data.total || 0)) break;
    }
    for (const job of jobs) {
      try {
        const { data } = await http.get(`${base}${job.detailPath}`);
        const info = data.jobPostingInfo || {};
        job.description = clean(info.jobDescription);
        job.location = [info.location, ...(info.additionalLocations || [])].filter(Boolean).join('; ') || job.location;
        job.employmentType = info.timeType || '';
        job.requisitionId = `workday:${tenant}:${info.jobReqId || job.requisitionId}`;
      } catch (error) { job.detailError = error.message; }
    }
    return jobs;
  }
  if (ats === 'greenhouse') {
    const { data } = await http.get(`https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(board)}/jobs?content=true`);
    return (data.jobs || []).map(j => baseJob(company, { title: j.title, location: j.location?.name || '', description: clean(j.content), applyLink: j.absolute_url, requisitionId: `greenhouse:${board}:${j.id}`, ats, publishedAt: j.updated_at }));
  }
  if (ats === 'lever') {
    const host = connector.eu ? 'api.eu.lever.co' : 'api.lever.co';
    const jobs = [];
    for (let skip = 0; skip < 2000; skip += 100) {
      const { data } = await http.get(`https://${host}/v0/postings/${encodeURIComponent(board)}?mode=json&limit=100&skip=${skip}`);
      if (!Array.isArray(data)) throw new Error('Unexpected Lever response');
      jobs.push(...data.map(j => baseJob(company, { title: j.text, location: j.categories?.allLocations?.join(', ') || j.categories?.location || '', employmentType: j.categories?.commitment || '', isRemote: j.workplaceType === 'remote', description: clean([j.descriptionPlain || j.description, ...(j.lists || []).map(l => `${l.text} ${l.content}`), j.additionalPlain || j.additional].join(' ')), applyLink: j.applyUrl || j.hostedUrl, requisitionId: `lever:${board}:${j.id}`, ats, publishedAt: j.createdAt ? new Date(j.createdAt).toISOString() : null })));
      if (data.length < 100) break;
    }
    return jobs;
  }
  if (ats === 'smartrecruiters') {
    const jobs = [];
    for (let offset = 0; offset < 2000; offset += 100) {
      const { data } = await http.get(`https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(board)}/postings?limit=100&offset=${offset}`);
      for (const j of data.content || []) {
        const location = [j.location?.city, j.location?.country].filter(Boolean).join(', ').replace(/\bin\b/i, 'India');
        if (!/india/i.test(location)) continue;
        if (!/engineer|developer|backend|software/i.test(j.name) || /test|qa|sdet|frontend|data scientist/i.test(j.name)) continue;
        jobs.push(baseJob(company, { title: j.name, location, isRemote: j.location?.remote, description: '', applyLink: `https://jobs.smartrecruiters.com/${board}/${j.id}`, requisitionId: `smartrecruiters:${board}:${j.id}`, ats, detailUrl: j.ref }));
      }
      if ((data.content || []).length < 100) break;
    }
    const profile = store.read('profile', { cities: [] });
    const relevant = jobs.filter(j => /java\b|kotlin|spring|node\.?js|backend|back.end/i.test(j.title) && /pune|gurgaon|gurugram|indore|jaipur|vadodara|remote/i.test(j.location) && !/principal|architect/i.test(j.title));
    for (const job of relevant.slice(0, 80)) {
      try {
        const { data } = await http.get(job.detailUrl);
        job.description = clean(Object.values(data.jobAd?.sections || {}).map(s => s.text).join(' '));
        if (data.applyUrl && /^https:\/\//.test(data.applyUrl)) job.applyLink = data.applyUrl;
        job.employmentType = data.typeOfEmployment?.label || '';
      } catch (error) { job.detailError = error.message; }
    }
    return jobs;
  }
  throw new Error('No discovery connector');
}
function jsonJobs($, company, url) {
  const jobs = [];
  function visit(value) {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) { value.forEach(visit); return; }
    if (value['@type'] === 'JobPosting' || (Array.isArray(value['@type']) && value['@type'].includes('JobPosting'))) {
      const locations = [value.jobLocation].flat().filter(Boolean).map(l => Object.values(l.address || {}).filter(v => typeof v === 'string').join(', '));
      const applicant = [value.applicantLocationRequirements].flat().filter(Boolean).map(l => l.name || '').join(', ');
      if (value.jobLocationType === 'TELECOMMUTE') locations.push(`Remote ${applicant}`);
      jobs.push(baseJob(company, { title: value.title, location: locations.join('; '), description: clean(value.description), employmentType: [value.employmentType].flat().join(' '), applyLink: value.url ? new URL(value.url, url).href : url, requisitionId: value.identifier?.value ? `${company.name}:${value.identifier.value}` : undefined, ats: detectATS(url)?.ats || 'unsupported', publishedAt: value.datePosted }));
    }
    if (value['@graph']) visit(value['@graph']);
    if (value.itemListElement) value.itemListElement.forEach(e => visit(e.item || e));
  }
  $('script[type="application/ld+json"]').each((_, el) => { try { visit(JSON.parse($(el).text())); } catch {} });
  return jobs;
}
async function discoverCompany(company) {
  let connector = company.ats ? { ats: company.ats, board: company.board } : null;
  if (connector) {
    try { return { jobs: await fetchBoard(company, connector), connector }; }
    catch (error) { store.event(`${company.name}: configured board unavailable; inspecting official career page`); }
  }
  const { data } = await http.get(company.careersUrl);
  const $ = cheerio.load(data);
  const candidates = [];
  $('a[href],iframe[src]').each((_, el) => {
    try { const link = new URL($(el).attr('href') || $(el).attr('src'), company.careersUrl).href; const ats = detectATS(link); if (ats) candidates.push(ats); } catch {}
  });
  // A board is attributed to a company only when linked by its official career page.
  for (const found of candidates.slice(0, 3)) {
    try { return { jobs: await fetchBoard(company, found), connector: found }; } catch {}
  }
  const jobs = jsonJobs($, company, company.careersUrl);
  if (!jobs.length) {
    const detailLinks = [];
    $('a[href]').each((_, el) => {
      try {
        const link = new URL($(el).attr('href'), company.careersUrl);
        if (link.hostname === new URL(company.careersUrl).hostname && /\/(?:job-details|vacancy|jobview|jobs?\/[^/]+\/[^/]+)/i.test(link.pathname) && /java|backend|spring|kotlin|node|software engineer/i.test($(el).text())) detailLinks.push(link.href);
      } catch {}
    });
    for (const link of [...new Set(detailLinks)].slice(0, 8)) {
      try { const response = await http.get(link); jobs.push(...jsonJobs(cheerio.load(response.data), company, link)); } catch {}
    }
  }
  return { jobs, connector: null, note: jobs.length ? 'Structured postings found; submission requires portal verification' : 'Career page needs a dedicated connector; no jobs assumed' };
}
function persistJobs(jobs, profile) {
  let inserted = 0;
  store.mutate(s => {
    for (const job of jobs) {
      if (!job.title || !job.company || !job.applyLink) continue;
      try { safeUrl(job.applyLink); } catch { continue; }
      job.id = key(job); job.match = evaluate(job, profile);
      const existing = s.jobs.find(j => j.id === job.id || canonical(j.applyLink) === canonical(job.applyLink));
      if (existing) {
        const status = ['queued', 'excluded'].includes(existing.status) ? (job.match.eligible ? 'queued' : 'excluded') : existing.status;
        Object.assign(existing, job, { status: !job.match.eligible && existing.status === 'needs_input' ? 'excluded' : status, discoveredAt: existing.discoveredAt, attempts: existing.attempts, confirmation: existing.confirmation, questions: existing.questions, submittedAt: existing.submittedAt });
      }
      else { s.jobs.push({ ...job, status: job.match.eligible ? 'queued' : 'excluded', attempts: [] }); inserted++; }
    }
  });
  return inserted;
}
async function discover(profile, onProgress = () => {}, onlyNames) {
  const companies = COMPANIES.filter(c => !profile.excludedCompanies.some(n => n.toLowerCase() === c.name.toLowerCase()) && (!onlyNames || onlyNames.includes(c.name)));
  const results = onlyNames ? store.read('companies-status', []).filter(s => !onlyNames.includes(s.company)) : [];
  let cursor = 0;
  async function work() {
    while (cursor < companies.length) {
      const company = companies[cursor++];
      try {
        const result = await discoverCompany(company);
        const inserted = persistJobs(result.jobs, profile);
        results.push({ company: company.name, checkedAt: new Date().toISOString(), jobsFound: result.jobs.length, inserted, connector: result.connector, note: result.note, status: result.note ? 'needs_connector' : 'checked' });
        onProgress(result.note && !result.jobs.length ? `${company.name}: discovery incomplete — dedicated connector needed; vacancy count unknown` : `${company.name}: ${result.jobs.length} postings checked`);
      } catch (error) { results.push({ company: company.name, status: 'failed', checkedAt: new Date().toISOString(), error: error.message }); onProgress(`${company.name}: ${error.message}`); }
      store.write('companies-status', results);
    }
  }
  await Promise.all(Array.from({ length: 5 }, work));
  return results;
}
async function importJob(url, profile, companyName) {
  safeUrl(url);
  const connector = detectATS(url);
  const registered = COMPANIES.find(c => c.name.toLowerCase() === (companyName || '').toLowerCase() || (connector && c.board === connector.board));
  if (!registered) throw new Error('Select a company from the watchlist for this link');
  const verified = store.read('companies-status', []).find(s => s.company === registered.name)?.connector;
  if (connector && !(connector.board === registered.board && connector.ats === registered.ats) && !(connector.board === verified?.board && connector.ats === verified?.ats)) throw new Error('This job board is not verified for the selected company. Use its official career link.');
  if (!connector && new URL(url).hostname !== new URL(registered.careersUrl).hostname) throw new Error('Use a job link on the selected company’s verified career website');
  if (connector && connector.id && ['greenhouse', 'lever'].includes(connector.ats)) {
    const jobs = await fetchBoard(registered, connector);
    const match = jobs.find(j => j.requisitionId.endsWith(`:${connector.id}`) || canonical(j.applyLink) === canonical(url));
    if (!match) throw new Error('The requested job is not an open posting on this board');
    persistJobs([match], profile); return match;
  }
  const { data } = await http.get(url);
  const jobs = jsonJobs(cheerio.load(data), registered, url);
  if (!jobs.length) throw new Error('Could not verify job details from this page. Use an official ATS job URL.');
  persistJobs(jobs, profile); return jobs[0];
}
module.exports = { discover, importJob, detectATS, persistJobs, safeUrl, jsonJobs };
