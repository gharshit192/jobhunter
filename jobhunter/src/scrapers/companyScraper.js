// ── Company Career Page Scraper ──────────────────────────────────────────────
// Fetches jobs directly from company career pages via ATS APIs
// Only includes VERIFIED working boards (tested March 2026)

const axios = require('axios');

// ══════════════════════════════════════════════════════════════════════════════
// VERIFIED COMPANY REGISTRY — Only boards that return live, valid job URLs
// ══════════════════════════════════════════════════════════════════════════════

const COMPANIES = [
  // ── Indian Startups (Greenhouse — verified working) ────────────────────────
  { name: 'Razorpay',     platform: 'greenhouse', slug: 'razorpaysoftwareprivatelimited' },
  { name: 'PhonePe',      platform: 'greenhouse', slug: 'phonepe' },
  { name: 'Groww',        platform: 'greenhouse', slug: 'groww' },
  { name: 'Druva',        platform: 'greenhouse', slug: 'druva' },
  { name: 'Postman',      platform: 'greenhouse', slug: 'postman' },

  // ── Indian Startups (Lever — verified working) ─────────────────────────────
  { name: 'CRED',         platform: 'lever',      slug: 'cred' },
  { name: 'Spotify',      platform: 'lever',      slug: 'spotify' },

  // ── MNCs (Greenhouse — verified working) ───────────────────────────────────
  { name: 'Stripe',       platform: 'greenhouse', slug: 'stripe' },
  { name: 'Databricks',   platform: 'greenhouse', slug: 'databricks' },
  { name: 'MongoDB',      platform: 'greenhouse', slug: 'mongodb' },
  { name: 'Cloudflare',   platform: 'greenhouse', slug: 'cloudflare' },
  { name: 'Twilio',       platform: 'greenhouse', slug: 'twilio' },
  { name: 'Elastic',      platform: 'greenhouse', slug: 'elastic' },
  { name: 'GitLab',       platform: 'greenhouse', slug: 'gitlab' },
  { name: 'Figma',        platform: 'greenhouse', slug: 'figma' },
  { name: 'Coinbase',     platform: 'greenhouse', slug: 'coinbase' },
  { name: 'Rubrik',       platform: 'greenhouse', slug: 'rubrik' },
  { name: 'Instacart',    platform: 'greenhouse', slug: 'instacart' },
  { name: 'Vercel',       platform: 'greenhouse', slug: 'vercel' },
  { name: 'PlanetScale',  platform: 'greenhouse', slug: 'planetscale' },
  { name: 'Grafana Labs', platform: 'greenhouse', slug: 'grafanalabs' },
  { name: 'LaunchDarkly', platform: 'greenhouse', slug: 'launchdarkly' },
  { name: 'CircleCI',     platform: 'greenhouse', slug: 'circleci' },
  { name: 'Datadog',      platform: 'greenhouse', slug: 'datadog' },
  { name: 'Okta',         platform: 'greenhouse', slug: 'okta' },
  { name: 'Zscaler',      platform: 'greenhouse', slug: 'zscaler' },
];

// Max age for jobs (skip anything older than this)
const MAX_JOB_AGE_DAYS = 60;

// ══════════════════════════════════════════════════════════════════════════════
// ATS FETCHERS
// ══════════════════════════════════════════════════════════════════════════════

async function fetchGreenhouseJobs(slug, companyName) {
  const url = `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs?content=true`;
  const res = await axios.get(url, { timeout: 8000 });
  const now = Date.now();
  const maxAge = MAX_JOB_AGE_DAYS * 24 * 60 * 60 * 1000;

  return (res.data.jobs || [])
    .filter(job => {
      // Skip jobs older than MAX_JOB_AGE_DAYS
      if (job.updated_at) {
        const age = now - new Date(job.updated_at).getTime();
        if (age > maxAge) return false;
      }
      return true;
    })
    .map(job => ({
      title: job.title,
      company: companyName,
      location: (job.location?.name || 'Not specified'),
      skills: [],
      experience: '',
      salary: '',
      applyLink: job.absolute_url || `https://boards.greenhouse.io/${slug}/jobs/${job.id}`,
      source: 'Careers',
      isRemote: (job.location?.name || '').toLowerCase().includes('remote'),
      directApply: true,
      jobId: `gh_${slug}_${job.id}`,
      description: stripHtml(job.content || '').slice(0, 2000),
      foundAt: job.updated_at ? new Date(job.updated_at) : new Date(),
    }));
}

async function fetchLeverJobs(slug, companyName) {
  const url = `https://api.lever.co/v0/postings/${slug}?mode=json`;
  const res = await axios.get(url, { timeout: 8000 });
  const data = Array.isArray(res.data) ? res.data : [];
  const now = Date.now();
  const maxAge = MAX_JOB_AGE_DAYS * 24 * 60 * 60 * 1000;

  return data
    .filter(job => {
      // Skip stale jobs
      if (job.createdAt && (now - job.createdAt) > maxAge) return false;
      return true;
    })
    .map(job => ({
      title: job.text || '',
      company: companyName,
      location: (job.categories?.location || 'Not specified'),
      skills: [],
      experience: job.categories?.commitment || '',
      salary: '',
      applyLink: job.hostedUrl || job.applyUrl || `https://jobs.lever.co/${slug}/${job.id}`,
      source: 'Careers',
      isRemote: (job.categories?.location || '').toLowerCase().includes('remote') ||
                (job.workplaceType || '').toLowerCase() === 'remote',
      directApply: true,
      jobId: `lever_${slug}_${job.id}`,
      description: stripHtml(job.descriptionPlain || job.description || '').slice(0, 2000),
      foundAt: job.createdAt ? new Date(job.createdAt) : new Date(),
    }));
}

// ══════════════════════════════════════════════════════════════════════════════
// MAIN FETCHER
// ══════════════════════════════════════════════════════════════════════════════

async function fetchCompanyCareers(resumeProfile) {
  const resumeSkills = (resumeProfile.skills || []).map(s => s.toLowerCase());
  const resumeRoles = (resumeProfile.roles || []).map(r => r.toLowerCase());

  console.log('🏢 Fetching jobs from company career pages...');

  const allJobs = [];
  const companyStats = [];
  const batchSize = 10;

  for (let i = 0; i < COMPANIES.length; i += batchSize) {
    const batch = COMPANIES.slice(i, i + batchSize);

    const results = await Promise.allSettled(
      batch.map(async (company) => {
        try {
          let jobs;
          if (company.platform === 'greenhouse') {
            jobs = await fetchGreenhouseJobs(company.slug, company.name);
          } else if (company.platform === 'lever') {
            jobs = await fetchLeverJobs(company.slug, company.name);
          } else {
            return { company: company.name, jobs: [] };
          }
          return { company: company.name, jobs };
        } catch {
          return { company: company.name, jobs: [] };
        }
      })
    );

    results.forEach(r => {
      if (r.status === 'fulfilled' && r.value.jobs.length > 0) {
        companyStats.push({ name: r.value.company, count: r.value.jobs.length });
        allJobs.push(...r.value.jobs);
      }
    });
  }

  // Filter jobs relevant to user's profile
  const relevant = allJobs.filter(job => {
    const title = (job.title || '').toLowerCase();
    const desc = (job.description || '').toLowerCase();
    const searchable = `${title} ${desc}`;

    const roleMatch = resumeRoles.some(role => {
      const words = role.split(' ').filter(w => w.length > 3);
      return words.some(w => title.includes(w));
    });

    const skillMatch = resumeSkills.some(skill => {
      try {
        const escaped = skill.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const re = new RegExp('(?:^|[\\s,;|/()\\[\\]])' + escaped + '(?:$|[\\s,;|/()\\[\\]])', 'i');
        return re.test(searchable);
      } catch { return searchable.includes(skill); }
    });

    return roleMatch || skillMatch;
  });

  console.log(`   🏢 Scanned ${COMPANIES.length} companies, ${allJobs.length} total, ${relevant.length} relevant`);
  if (companyStats.length > 0) {
    const top = companyStats.sort((a, b) => b.count - a.count).slice(0, 8);
    console.log(`   📊 Top: ${top.map(c => `${c.name}(${c.count})`).join(', ')}`);
  }

  return relevant;
}

function stripHtml(html) {
  return (html || '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}

module.exports = { fetchCompanyCareers, COMPANIES };
