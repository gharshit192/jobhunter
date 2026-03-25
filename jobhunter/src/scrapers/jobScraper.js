const axios = require('axios');
const cheerio = require('cheerio');
const { v4: uuidv4 } = require('uuid');

// ── Shared Axios Config ───────────────────────────────────────────────────────
const axiosConfig = {
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
  },
  timeout: 20000,
};

// ── Direct Apply Detection ───────────────────────────────────────────────────
function isDirectApply(url, source) {
  if (!url) return false;
  const lowerUrl = url.toLowerCase();
  const lowerSource = (source || '').toLowerCase();

  const loginRequired = ['linkedin', 'naukri', 'instahyre', 'wellfound'];
  if (loginRequired.some(site => lowerUrl.includes(site) || lowerSource === site)) {
    return false;
  }

  const directApplyPatterns = [
    'careers', 'lever.co', 'greenhouse.io', 'workable.com',
    'jobs.', 'apply.', 'boards.', 'ashbyhq.com', 'smartrecruiters.com',
    'remotive.com', 'arbeitnow.com', 'himalayas.app', 'jobicy.com', 'remoteok.com', 'themuse.com',
  ];
  return directApplyPatterns.some(p => lowerUrl.includes(p)) || !loginRequired.some(site => lowerUrl.includes(site));
}

// ══════════════════════════════════════════════════════════════════════════════
// FREE JOB APIs (no scraping needed, reliable, return JSON)
// ══════════════════════════════════════════════════════════════════════════════

// ── Remotive API (Remote jobs) ──────────────────────────────────────────────
async function fetchRemotive(keywords = ['software', 'backend']) {
  const jobs = [];
  const isVercel = !!process.env.VERCEL;
  try {
    for (const keyword of keywords.slice(0, 3)) {
      const url = `https://remotive.com/api/remote-jobs?search=${encodeURIComponent(keyword)}&limit=30`;
      const res = await axios.get(url, { timeout: isVercel ? 8000 : 15000 });
      const data = res.data;

      (data.jobs || []).forEach(job => {
        const tags = (job.tags || []).map(t => t.toLowerCase());
        jobs.push({
          title: job.title,
          company: job.company_name,
          location: job.candidate_required_location || 'Remote',
          skills: tags.slice(0, 6),
          experience: '',
          salary: job.salary || '',
          applyLink: job.url,
          source: 'Remotive',
          isRemote: true,
          directApply: isDirectApply(job.url, 'Remotive'),
          jobId: `remotive_${job.id}`,
          description: stripHtml(job.description || '').slice(0, 2000),
        });
      });

      if (!isVercel) await sleep(1000);
    }
  } catch (err) {
    console.error('Remotive error:', err.message);
  }
  return jobs;
}

// ── Arbeitnow API (Global jobs, many India/Remote) ────────────────────────────
async function fetchArbeitnow(keywords = ['software', 'backend']) {
  const jobs = [];
  try {
    const url = `https://www.arbeitnow.com/api/job-board-api`;
    const res = await axios.get(url, { timeout: process.env.VERCEL ? 8000 : 15000 });
    const data = res.data;

    const kw = keywords.map(k => k.toLowerCase());

    (data.data || []).forEach(job => {
      const title = (job.title || '').toLowerCase();
      const desc = (job.description || '').toLowerCase();
      const tags = (job.tags || []).map(t => t.toLowerCase());

      // Filter by keywords
      const matches = kw.some(k => title.includes(k) || desc.includes(k) || tags.some(t => t.includes(k)));
      if (!matches) return;

      jobs.push({
        title: job.title,
        company: job.company_name,
        location: job.location || 'Remote',
        skills: (job.tags || []).slice(0, 6),
        experience: '',
        salary: '',
        applyLink: job.url,
        source: 'Arbeitnow',
        isRemote: job.remote || false,
        directApply: isDirectApply(job.url, 'Arbeitnow'),
        jobId: `arbeitnow_${job.slug || uuidv4().slice(0, 8)}`,
        description: stripHtml(job.description || '').slice(0, 2000),
      });
    });
  } catch (err) {
    console.error('Arbeitnow error:', err.message);
  }
  return jobs;
}

// ── Himalayas API (Remote jobs, good for India) ──────────────────────────────
async function fetchHimalayas(keywords = ['backend', 'software']) {
  const jobs = [];
  try {
    const url = `https://himalayas.app/jobs/api?limit=50`;
    const res = await axios.get(url, { timeout: process.env.VERCEL ? 8000 : 15000 });
    const data = res.data;

    const kw = keywords.map(k => k.toLowerCase());

    (data.jobs || []).forEach(job => {
      const title = (job.title || '').toLowerCase();
      const desc = (job.excerpt || job.description || '').toLowerCase();
      const categories = (job.categories || []).map(c => c.toLowerCase());

      const matches = kw.some(k => title.includes(k) || desc.includes(k) || categories.some(c => c.includes(k)));
      if (!matches) return;

      const salaryStr = job.salaryCurrency && job.salaryMin
        ? `${job.salaryCurrency} ${job.salaryMin}-${job.salaryMax}`
        : '';

      jobs.push({
        title: job.title,
        company: job.companyName,
        location: job.locationRestrictions?.join(', ') || 'Remote / Worldwide',
        skills: (job.categories || []).slice(0, 6),
        experience: job.seniority || '',
        salary: salaryStr,
        applyLink: job.applicationLink || `https://himalayas.app/jobs/${job.slug}`,
        source: 'Himalayas',
        isRemote: true,
        directApply: isDirectApply(job.applicationLink || '', 'Himalayas'),
        jobId: `himalayas_${job.id || uuidv4().slice(0, 8)}`,
        description: stripHtml(job.excerpt || job.description || '').slice(0, 2000),
      });
    });
  } catch (err) {
    console.error('Himalayas error:', err.message);
  }
  return jobs;
}

// ── Jobicy API (Remote jobs) ────────────────────────────────────────────────
async function fetchJobicy(keywords = ['developer', 'engineer']) {
  const jobs = [];
  try {
    // Determine tag from keywords — map common roles to Jobicy tags
    const kwLower = keywords.map(k => k.toLowerCase()).join(' ');
    let tag = 'engineering'; // default
    if (kwLower.includes('product') || kwLower.includes('manager')) tag = 'product';
    else if (kwLower.includes('design') || kwLower.includes('ux')) tag = 'design';
    else if (kwLower.includes('market') || kwLower.includes('growth')) tag = 'marketing';
    else if (kwLower.includes('data') || kwLower.includes('analyst')) tag = 'data-science';
    else if (kwLower.includes('sales') || kwLower.includes('business')) tag = 'sales';
    else if (kwLower.includes('devops') || kwLower.includes('sre')) tag = 'devops-sysadmin';

    const url = `https://jobicy.com/api/v2/remote-jobs?count=50&tag=${tag}`;
    const res = await axios.get(url, { timeout: process.env.VERCEL ? 8000 : 15000 });
    const data = res.data;

    const kw = keywords.map(k => k.toLowerCase());

    (data.jobs || []).forEach(job => {
      const title = (job.jobTitle || '').toLowerCase();
      const desc = (job.jobDescription || '').toLowerCase();

      const matches = kw.some(k => title.includes(k) || desc.includes(k));
      if (!matches) return;

      jobs.push({
        title: job.jobTitle,
        company: job.companyName,
        location: job.jobGeo || 'Remote',
        skills: [],
        experience: job.jobLevel || '',
        salary: job.annualSalaryMin ? `$${job.annualSalaryMin}-${job.annualSalaryMax}` : '',
        applyLink: job.url,
        source: 'Jobicy',
        isRemote: true,
        directApply: isDirectApply(job.url, 'Jobicy'),
        jobId: `jobicy_${job.id || uuidv4().slice(0, 8)}`,
        description: stripHtml(job.jobDescription || '').slice(0, 2000),
      });
    });
  } catch (err) {
    console.error('Jobicy error:', err.message);
  }
  return jobs;
}

// ── RemoteOK API (All remote jobs, free, no auth) ───────────────────────────
async function fetchRemoteOK(keywords = ['software', 'backend']) {
  const jobs = [];
  const isVercel = !!process.env.VERCEL;
  try {
    const url = `https://remoteok.com/api`;
    const res = await axios.get(url, {
      timeout: isVercel ? 8000 : 15000,
      headers: { 'User-Agent': axiosConfig.headers['User-Agent'] },
    });
    const data = Array.isArray(res.data) ? res.data : [];

    const kw = keywords.map(k => k.toLowerCase());

    // RemoteOK returns an array; the first element is a metadata/legal notice object
    data.forEach(job => {
      if (!job.id || !job.position) return; // skip non-job entries

      const title = (job.position || '').toLowerCase();
      const desc = (job.description || '').toLowerCase();
      const tags = (job.tags || []).map(t => t.toLowerCase());

      const matches = kw.some(k => title.includes(k) || desc.includes(k) || tags.some(t => t.includes(k)));
      if (!matches) return;

      const salaryStr = job.salary_min && job.salary_max
        ? `$${job.salary_min}-$${job.salary_max}`
        : job.salary || '';

      jobs.push({
        title: job.position,
        company: job.company || 'Unknown',
        location: job.location || 'Remote',
        skills: (job.tags || []).slice(0, 6),
        experience: '',
        salary: salaryStr,
        applyLink: job.url ? `https://remoteok.com${job.url}` : `https://remoteok.com/remote-jobs/${job.id}`,
        source: 'RemoteOK',
        isRemote: true,
        directApply: isDirectApply(job.apply_url || job.url || '', 'RemoteOK'),
        jobId: `remoteok_${job.id}`,
        description: stripHtml(job.description || '').slice(0, 2000),
      });
    });
  } catch (err) {
    console.error('RemoteOK error:', err.message);
  }
  return jobs;
}

// ── TheMuse API (Free public API, no auth) ──────────────────────────────────
async function fetchTheMuse(keywords = ['software', 'backend']) {
  const jobs = [];
  const isVercel = !!process.env.VERCEL;
  try {
    for (const keyword of keywords.slice(0, 3)) {
      const url = `https://www.themuse.com/api/public/jobs?page=0&descending=true&category=${encodeURIComponent(keyword)}`;
      const res = await axios.get(url, { timeout: isVercel ? 8000 : 15000 });
      const data = res.data;

      (data.results || []).forEach(job => {
        const locations = (job.locations || []).map(l => l.name).join(', ') || 'Unknown';
        const categories = (job.categories || []).map(c => c.name);
        const isRemote = locations.toLowerCase().includes('remote') ||
          locations.toLowerCase().includes('flexible');

        jobs.push({
          title: job.name || '',
          company: job.company?.name || 'Unknown',
          location: locations,
          skills: categories.slice(0, 6),
          experience: job.levels?.map(l => l.name).join(', ') || '',
          salary: '',
          applyLink: job.refs?.landing_page || `https://www.themuse.com/jobs/${job.id}`,
          source: 'TheMuse',
          isRemote,
          directApply: isDirectApply(job.refs?.landing_page || '', 'TheMuse'),
          jobId: `themuse_${job.id || uuidv4().slice(0, 8)}`,
          description: stripHtml(job.contents || '').slice(0, 2000),
        });
      });

      if (!isVercel) await sleep(1000);
    }
  } catch (err) {
    console.error('TheMuse error:', err.message);
  }
  return jobs;
}

// ══════════════════════════════════════════════════════════════════════════════
// SCRAPERS (HTML parsing)
// ══════════════════════════════════════════════════════════════════════════════

// ── LinkedIn (via public search — server-rendered) ──────────────────────────
async function scrapeLinkedIn(keywords = ['backend engineer india', 'nodejs developer india']) {
  const jobs = [];
  try {
    for (const keyword of keywords.slice(0, 3)) {
      const url = `https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?keywords=${encodeURIComponent(keyword)}&location=India&sortBy=DD&start=0`;

      const res = await axios.get(url, {
        ...axiosConfig,
        headers: {
          ...axiosConfig.headers,
          'Accept': 'text/html',
        },
      });
      const $ = cheerio.load(res.data);

      // LinkedIn guest API returns <li> cards with these selectors (2024-2026)
      $('li').each((i, el) => {
        const title   = $(el).find('.base-search-card__title, h3').text().trim();
        const company = $(el).find('.base-search-card__subtitle, h4').text().trim();
        const loc     = $(el).find('.job-search-card__location, .base-search-card__metadata span').text().trim();
        const link    = $(el).find('a.base-card__full-link, a').first().attr('href');

        if (title && company && title.length > 3) {
          jobs.push({
            title,
            company,
            location: loc || 'India',
            skills: [],
            applyLink: link ? link.split('?')[0] : 'https://www.linkedin.com/jobs/',
            source: 'LinkedIn',
            isRemote: (loc || '').toLowerCase().includes('remote'),
            directApply: false,
            jobId: `linkedin_${Buffer.from(title + company).toString('base64').slice(0, 12)}`,
            description: '',
          });
        }
      });

      await sleep(2000);
    }
  } catch (err) {
    console.error('LinkedIn scrape error:', err.message);
  }
  return jobs;
}

// ── Naukri Scraper (with Puppeteer fallback) ─────────────────────────────────
async function scrapeNaukri(keywords = ['nodejs developer', 'backend engineer'], location = 'india') {
  // Skip Puppeteer on serverless (Vercel)
  if (process.env.VERCEL) {
    return scrapeNaukriAxios(keywords, location);
  }
  const jobs = [];
  try {
    const puppeteer = require('puppeteer');
    const browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });

    for (const keyword of keywords.slice(0, 2)) {
      const slug = keyword.replace(/\s+/g, '-').toLowerCase();
      const url = `https://www.naukri.com/${slug}-jobs-in-${location}`;

      const page = await browser.newPage();
      await page.setUserAgent(axiosConfig.headers['User-Agent']);
      await page.setViewport({ width: 1280, height: 900 });

      try {
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
        await sleep(2000);

        const pageJobs = await page.evaluate(() => {
          const results = [];
          document.querySelectorAll('.srp-jobtuple-wrapper, .jobTupleHeader, article.jobTuple, [class*="cust-job-tuple"]').forEach(el => {
            const titleEl = el.querySelector('.title, a.title, [class*="title"]');
            const companyEl = el.querySelector('.comp-name, .companyInfo a, [class*="comp-name"]');
            const expEl = el.querySelector('.expwdth, [class*="exp"], .experience');
            const salaryEl = el.querySelector('.sal, .salary, [class*="sal"]');
            const locEl = el.querySelector('.locWdth, .location, [class*="loc"]');
            const link = titleEl?.closest('a')?.href || titleEl?.querySelector('a')?.href || '';
            const skillEls = el.querySelectorAll('.tag-li, [class*="tag"], .dot-gt span');
            const skills = Array.from(skillEls).map(s => s.textContent.trim()).filter(s => s && s.length < 30);

            const title = titleEl?.textContent?.trim() || '';
            const company = companyEl?.textContent?.trim() || '';

            if (title && company) {
              results.push({
                title,
                company,
                experience: expEl?.textContent?.trim() || '',
                salary: salaryEl?.textContent?.trim() || '',
                location: locEl?.textContent?.trim() || 'India',
                skills,
                link,
              });
            }
          });
          return results;
        });

        pageJobs.forEach(j => {
          jobs.push({
            ...j,
            applyLink: j.link?.startsWith('http') ? j.link : `https://www.naukri.com${j.link || ''}`,
            source: 'Naukri',
            isRemote: (j.location || '').toLowerCase().includes('remote'),
            directApply: false,
            jobId: `naukri_${Buffer.from(j.title + j.company).toString('base64').slice(0, 12)}`,
            description: '',
          });
        });
      } catch (pageErr) {
        console.error(`Naukri page error for "${keyword}":`, pageErr.message);
      } finally {
        await page.close();
      }

      await sleep(2000);
    }

    await browser.close();
  } catch (err) {
    console.error('Naukri scrape error:', err.message);
    // Fallback to axios if puppeteer fails
    return scrapeNaukriAxios(keywords, location);
  }
  return jobs;
}

// Naukri fallback — Naukri blocks all non-browser requests (API returns 406, HTML is client-rendered).
// Use LinkedIn India search as a proxy for Indian market jobs instead.
async function scrapeNaukriAxios(keywords, location) {
  const jobs = [];
  try {
    // Use LinkedIn guest API with India-specific keywords (captures same job market as Naukri)
    for (const keyword of keywords.slice(0, 2)) {
      const searchQuery = `${keyword} ${location || 'india'}`;
      const url = `https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?keywords=${encodeURIComponent(searchQuery)}&location=India&sortBy=DD&start=0`;

      const res = await axios.get(url, {
        ...axiosConfig,
        headers: { ...axiosConfig.headers, 'Accept': 'text/html' },
        timeout: 15000,
      });
      const $ = cheerio.load(res.data);

      $('li').each((i, el) => {
        const title   = $(el).find('.base-search-card__title, h3').text().trim();
        const company = $(el).find('.base-search-card__subtitle, h4').text().trim();
        const loc     = $(el).find('.job-search-card__location, .base-search-card__metadata span').text().trim();
        const link    = $(el).find('a.base-card__full-link, a').first().attr('href');

        if (title && company && title.length > 3) {
          jobs.push({
            title,
            company,
            location: loc || 'India',
            skills: [],
            experience: '',
            applyLink: link ? link.split('?')[0] : `https://www.linkedin.com/jobs/`,
            source: 'Naukri (via LinkedIn India)',
            isRemote: (loc || '').toLowerCase().includes('remote'),
            directApply: false,
            jobId: `naukri_li_${Buffer.from(title + company).toString('base64').slice(0, 12)}`,
            description: '',
          });
        }
      });

      await sleep(2000);
    }
    console.log(`   Naukri fallback (LinkedIn India): ${jobs.length} jobs`);
  } catch (err) {
    console.error('Naukri fallback error:', err.message);
  }
  return jobs;
}

// ── Instahyre (Puppeteer) ──────────────────────────────────────────────────
async function scrapeInstahyre(keywords = ['backend', 'nodejs']) {
  // Skip Puppeteer on serverless (Vercel)
  if (process.env.VERCEL) return [];
  const jobs = [];
  try {
    const puppeteer = require('puppeteer');
    const browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });

    for (const keyword of keywords.slice(0, 2)) {
      const url = `https://www.instahyre.com/search-jobs/?q=${encodeURIComponent(keyword)}&location=India`;
      const page = await browser.newPage();
      await page.setUserAgent(axiosConfig.headers['User-Agent']);

      try {
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
        await sleep(3000);

        const pageJobs = await page.evaluate(() => {
          const results = [];
          document.querySelectorAll('.opportunity-container, .opportunity-item, [class*="opportunity"]').forEach(el => {
            const titleEl = el.querySelector('h2, h3, [class*="title"]');
            const companyEl = el.querySelector('[class*="company"], [class*="employer"]');
            const link = el.querySelector('a')?.href || '';
            const title = titleEl?.textContent?.trim() || '';
            const company = companyEl?.textContent?.trim() || '';
            if (title && company) results.push({ title, company, link });
          });
          return results;
        });

        pageJobs.forEach(j => {
          jobs.push({
            title: j.title,
            company: j.company,
            location: 'India',
            skills: [keyword],
            applyLink: j.link?.startsWith('http') ? j.link : `https://www.instahyre.com${j.link}`,
            source: 'Instahyre',
            directApply: false,
            jobId: `instahyre_${uuidv4().slice(0, 8)}`,
          });
        });
      } catch (pageErr) {
        console.error(`Instahyre page error for "${keyword}":`, pageErr.message);
      } finally {
        await page.close();
      }
      await sleep(2000);
    }

    await browser.close();
  } catch (err) {
    console.error('Instahyre scrape error:', err.message);
  }
  return jobs;
}

// ══════════════════════════════════════════════════════════════════════════════
// RUN ALL SOURCES
// ══════════════════════════════════════════════════════════════════════════════

async function scrapeAllJobs(resumeProfile) {
  const skills   = resumeProfile.skills.slice(0, 4);
  const roles    = resumeProfile.roles.slice(0, 2);
  const keywords = [...roles, ...skills.slice(0, 2)];

  // India-focused keywords (85% India, 15% global)
  const indiaKeywords = keywords.map(k => `${k} india`);
  const indiaRoles = roles.map(r => `${r} india`);

  console.log('🔍 Starting job scraping (85% India focus)...');
  console.log(`   Keywords: ${keywords.join(', ')}`);

  // ── Company career pages (parallel with other sources) ─────────────────
  const { fetchCompanyCareers } = require('./companyScraper');
  const companyJobsPromise = fetchCompanyCareers(resumeProfile).catch(err => {
    console.error('   ⚠️  Company careers fetch failed:', err.message);
    return [];
  });

  // Run job board fetchers and scrapers in parallel
  const results = await Promise.allSettled([
    // ── India-focused (85%) ──────────────────────────────────────────────
    scrapeLinkedIn(indiaKeywords),
    scrapeLinkedIn(indiaRoles),
    scrapeNaukri(keywords.map(k => `${k} developer`)),
    scrapeInstahyre(skills),
    // ── Global/Remote (15%) ──────────────────────────────────────────────
    fetchRemotive(keywords),
    fetchArbeitnow(keywords),
    fetchHimalayas(keywords),
    fetchJobicy(keywords),
    fetchRemoteOK(keywords),
    fetchTheMuse(keywords),
  ]);

  // Wait for company careers
  const companyJobs = await companyJobsPromise;

  let allJobs = [...companyJobs];
  const names = ['LinkedIn (India)', 'LinkedIn (India Roles)', 'Naukri', 'Instahyre', 'Remotive', 'Arbeitnow', 'Himalayas', 'Jobicy', 'RemoteOK', 'TheMuse'];
  const sourceMeta = {};

  results.forEach((result, i) => {
    if (result.status === 'fulfilled') {
      console.log(`   ✅ ${names[i]}: ${result.value.length} jobs found`);
      sourceMeta[names[i]] = { status: 'success', count: result.value.length };
      allJobs = [...allJobs, ...result.value];
    } else {
      console.log(`   ⚠️  ${names[i]}: failed (${result.reason?.message})`);
      sourceMeta[names[i]] = { status: 'failed', error: result.reason?.message || 'Unknown error', count: 0 };
    }
  });

  // Deduplicate by jobId
  const seenIds = new Set();
  const deduped = allJobs.filter(job => {
    if (seenIds.has(job.jobId)) return false;
    seenIds.add(job.jobId);
    return true;
  });

  // Also deduplicate by normalized title+company
  const seenTitleCompany = new Set();
  const unique = deduped.filter(job => {
    const key = (job.title || '').toLowerCase().trim() + '|' + (job.company || '').toLowerCase().trim();
    if (seenTitleCompany.has(key)) return false;
    seenTitleCompany.add(key);
    return true;
  });

  console.log(`   📊 Total unique jobs: ${unique.length}`);
  unique._sourceMeta = sourceMeta;
  return unique;
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function stripHtml(html) {
  return html.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = { scrapeAllJobs, scrapeLinkedIn, scrapeNaukri, scrapeInstahyre, fetchRemotive, fetchArbeitnow, fetchHimalayas, fetchJobicy, fetchRemoteOK, fetchTheMuse, isDirectApply };
