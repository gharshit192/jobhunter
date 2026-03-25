// ── Company Career Page Scraper ──────────────────────────────────────────────
// Fetches jobs directly from 100+ company career pages via their ATS APIs
// Greenhouse, Lever, SmartRecruiters — all return clean JSON, no auth needed

const axios = require('axios');
const { v4: uuidv4 } = require('uuid');

// ══════════════════════════════════════════════════════════════════════════════
// COMPANY REGISTRY — ATS platform + slug for each company
// ══════════════════════════════════════════════════════════════════════════════

const COMPANIES = [
  // ── Indian Startups ────────────────────────────────────────────────────────
  { name: 'Razorpay',     platform: 'greenhouse', slug: 'razorpaysoftwareprivatelimited' },
  { name: 'PhonePe',      platform: 'greenhouse', slug: 'phonepe' },
  { name: 'Groww',        platform: 'greenhouse', slug: 'groww' },
  { name: 'Meesho',       platform: 'lever',      slug: 'meesho' },
  { name: 'CRED',         platform: 'lever',      slug: 'cred' },
  { name: 'Paytm',        platform: 'lever',      slug: 'paytm' },
  { name: 'Druva',        platform: 'greenhouse', slug: 'druva' },
  { name: 'Postman',      platform: 'greenhouse', slug: 'postman' },
  { name: 'Lenskart',     platform: 'lever',      slug: 'lenskart' },
  { name: 'upGrad',       platform: 'lever',      slug: 'upgrad' },
  { name: 'Jupiter',      platform: 'lever',      slug: 'jupiter-money' },
  { name: 'Slice',        platform: 'lever',      slug: 'sliceit' },
  { name: 'MoEngage',     platform: 'greenhouse', slug: 'maboroshi' },
  { name: 'Whatfix',      platform: 'lever',      slug: 'whatfix' },
  { name: 'Hasura',       platform: 'lever',      slug: 'hasura' },
  { name: 'ShareChat',    platform: 'lever',      slug: 'sharechat' },
  { name: 'Rapido',       platform: 'lever',      slug: 'rapido' },
  { name: 'Chargebee',    platform: 'greenhouse', slug: 'chargebee' },
  { name: 'CleverTap',    platform: 'lever',      slug: 'clevertap' },
  { name: 'Cars24',       platform: 'lever',      slug: 'cars24' },
  { name: 'PolicyBazaar', platform: 'lever',      slug: 'policybazaar' },
  { name: 'Delhivery',    platform: 'lever',      slug: 'delhivery' },
  { name: 'Ola',          platform: 'lever',      slug: 'olacabs' },
  { name: 'Myntra',       platform: 'lever',      slug: 'myntra' },
  { name: 'Swiggy',       platform: 'lever',      slug: 'swiggy' },
  { name: 'Zomato',       platform: 'lever',      slug: 'zomato' },
  { name: 'Dream11',      platform: 'lever',      slug: 'dream11' },
  { name: 'Zepto',        platform: 'lever',      slug: 'zepto' },
  { name: 'Zerodha',      platform: 'lever',      slug: 'zerodha' },

  // ── MNCs with India offices ────────────────────────────────────────────────
  { name: 'Stripe',       platform: 'greenhouse', slug: 'stripe' },
  { name: 'Databricks',   platform: 'greenhouse', slug: 'databricks' },
  { name: 'MongoDB',      platform: 'greenhouse', slug: 'mongodb' },
  { name: 'Cloudflare',   platform: 'greenhouse', slug: 'cloudflare' },
  { name: 'Twilio',       platform: 'greenhouse', slug: 'twilio' },
  { name: 'Elastic',      platform: 'greenhouse', slug: 'elastic' },
  { name: 'GitLab',       platform: 'greenhouse', slug: 'gitlab' },
  { name: 'Figma',        platform: 'greenhouse', slug: 'figma' },
  { name: 'Coinbase',     platform: 'greenhouse', slug: 'coinbase' },
  { name: 'Spotify',      platform: 'lever',      slug: 'spotify' },
  { name: 'Rubrik',       platform: 'greenhouse', slug: 'rubrik' },
  { name: 'Instacart',    platform: 'greenhouse', slug: 'instacart' },
  { name: 'Rippling',     platform: 'greenhouse', slug: 'rippling' },
  { name: 'Notion',       platform: 'greenhouse', slug: 'notion' },
  { name: 'Canva',        platform: 'greenhouse', slug: 'canva' },
  { name: 'Amdocs',       platform: 'eightfold',  slug: 'amdocs' },
  { name: 'Adobe',        platform: 'greenhouse', slug: 'adobe' },
  { name: 'Salesforce',   platform: 'lever',      slug: 'salesforce' },
  { name: 'Atlassian',    platform: 'lever',      slug: 'atlassian' },
  { name: 'Uber',         platform: 'greenhouse', slug: 'uber10' },
  { name: 'Freshworks',   platform: 'greenhouse', slug: 'freshworks' },
  { name: 'ServiceNow',   platform: 'lever',      slug: 'servicenow' },
  { name: 'VMware',       platform: 'lever',      slug: 'vmware' },
  { name: 'Intuit',       platform: 'greenhouse', slug: 'intuit' },
  { name: 'ThoughtSpot',  platform: 'greenhouse', slug: 'thoughtspot' },
  { name: 'Sprinklr',     platform: 'greenhouse', slug: 'sprinklr' },
  { name: 'Nutanix',      platform: 'greenhouse', slug: 'nutanix' },
  { name: 'Cohesity',     platform: 'greenhouse', slug: 'cohesity' },
  { name: 'BrowserStack', platform: 'lever',      slug: 'browserstack' },
  { name: 'Zoho',         platform: 'lever',      slug: 'zohocorp' },
  { name: 'Flipkart',     platform: 'lever',      slug: 'flipkart' },

  // ── Big Tech ───────────────────────────────────────────────────────────────
  { name: 'Google',       platform: 'greenhouse', slug: 'google' },
  { name: 'Microsoft',    platform: 'greenhouse', slug: 'microsoft' },
  { name: 'Amazon',       platform: 'greenhouse', slug: 'amazon' },
  { name: 'Apple',        platform: 'greenhouse', slug: 'apple' },
  { name: 'Meta',         platform: 'greenhouse', slug: 'meta' },

  // ── Finance / Consulting ───────────────────────────────────────────────────
  { name: 'Goldman Sachs',  platform: 'lever',    slug: 'goldmansachs' },
  { name: 'Morgan Stanley', platform: 'lever',    slug: 'morganstanley' },
  { name: 'Walmart Labs',   platform: 'lever',    slug: 'walmartlabs' },

  // ── SaaS / Dev Tools ──────────────────────────────────────────────────────
  { name: 'Vercel',       platform: 'greenhouse', slug: 'vercel' },
  { name: 'Supabase',     platform: 'greenhouse', slug: 'supabase' },
  { name: 'PlanetScale',  platform: 'greenhouse', slug: 'planetscale' },
  { name: 'Grafana Labs', platform: 'greenhouse', slug: 'grafanalabs' },
  { name: 'HashiCorp',    platform: 'greenhouse', slug: 'hashicorp' },
  { name: 'Snyk',         platform: 'greenhouse', slug: 'snyk' },
  { name: 'LaunchDarkly', platform: 'greenhouse', slug: 'launchdarkly' },
  { name: 'Sentry',       platform: 'greenhouse', slug: 'sentry' },
  { name: 'CircleCI',     platform: 'greenhouse', slug: 'circleci' },
  { name: 'Datadog',      platform: 'greenhouse', slug: 'datadog' },
  { name: 'Confluent',    platform: 'greenhouse', slug: 'confluent' },
  { name: 'Okta',         platform: 'greenhouse', slug: 'okta' },
  { name: 'Palo Alto Networks', platform: 'greenhouse', slug: 'paboroithonwork' },
  { name: 'CrowdStrike',  platform: 'greenhouse', slug: 'crowdstrike' },
  { name: 'Zscaler',      platform: 'greenhouse', slug: 'zscaler' },
];

// ══════════════════════════════════════════════════════════════════════════════
// ATS FETCHERS
// ══════════════════════════════════════════════════════════════════════════════

async function fetchGreenhouseJobs(slug, companyName) {
  const url = `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs?content=true`;
  const res = await axios.get(url, { timeout: 8000 });
  return (res.data.jobs || []).map(job => ({
    title: job.title,
    company: companyName,
    location: (job.location?.name || 'Not specified'),
    skills: (job.metadata || []).filter(m => m.name === 'Skills').map(m => m.value).flat() || [],
    experience: '',
    salary: '',
    applyLink: job.absolute_url || `https://boards.greenhouse.io/${slug}/jobs/${job.id}`,
    source: 'Careers',
    isRemote: (job.location?.name || '').toLowerCase().includes('remote'),
    directApply: true,
    jobId: `gh_${slug}_${job.id}`,
    description: stripHtml(job.content || '').slice(0, 2000),
  }));
}

async function fetchLeverJobs(slug, companyName) {
  const url = `https://api.lever.co/v0/postings/${slug}?mode=json`;
  const res = await axios.get(url, { timeout: 8000 });
  const data = Array.isArray(res.data) ? res.data : [];
  return data.map(job => ({
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
  }));
}

async function fetchEightfoldJobs(slug, companyName) {
  const url = `https://${slug}.eightfold.ai/api/apply/v2/jobs?num=50&domain=${slug}.eightfold.ai`;
  const res = await axios.get(url, { timeout: 10000, headers: { 'Accept': 'application/json' } });
  const positions = res.data?.positions || [];
  return positions.map(job => ({
    title: job.name || '',
    company: companyName,
    location: (job.location || 'Not specified'),
    skills: (job.skills || []).slice(0, 8),
    experience: job.experience || '',
    salary: '',
    applyLink: `https://${slug}.eightfold.ai/careers?pid=${job.id}`,
    source: 'Careers',
    isRemote: (job.location || '').toLowerCase().includes('remote'),
    directApply: true,
    jobId: `ef_${slug}_${job.id || uuidv4().slice(0, 8)}`,
    description: stripHtml(job.job_description || '').slice(0, 2000),
  }));
}

// ══════════════════════════════════════════════════════════════════════════════
// MAIN FETCHER — Runs all companies in parallel batches
// ══════════════════════════════════════════════════════════════════════════════

async function fetchCompanyCareers(resumeProfile) {
  const resumeSkills = (resumeProfile.skills || []).map(s => s.toLowerCase());
  const resumeRoles = (resumeProfile.roles || []).map(r => r.toLowerCase());

  console.log('🏢 Fetching jobs from company career pages...');

  // Fetch all companies in parallel (batches of 15 to avoid overwhelming)
  const allJobs = [];
  const companyStats = [];
  const batchSize = 15;

  for (let i = 0; i < COMPANIES.length; i += batchSize) {
    const batch = COMPANIES.slice(i, i + batchSize);

    const results = await Promise.allSettled(
      batch.map(async (company) => {
        try {
          let jobs;
          switch (company.platform) {
            case 'greenhouse':
              jobs = await fetchGreenhouseJobs(company.slug, company.name);
              break;
            case 'lever':
              jobs = await fetchLeverJobs(company.slug, company.name);
              break;
            case 'eightfold':
              jobs = await fetchEightfoldJobs(company.slug, company.name);
              break;
            default:
              return [];
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

  // Filter jobs relevant to user's profile (title or skills match)
  const relevant = allJobs.filter(job => {
    const title = (job.title || '').toLowerCase();
    const desc = (job.description || '').toLowerCase();
    const jobSkillsText = (job.skills || []).join(' ').toLowerCase();
    const searchable = `${title} ${desc} ${jobSkillsText}`;

    // Check if any resume role matches job title
    const roleMatch = resumeRoles.some(role => {
      const words = role.split(' ').filter(w => w.length > 3);
      return words.some(w => title.includes(w));
    });

    // Check if any resume skill appears in job
    const skillMatch = resumeSkills.some(skill => {
      try {
        const escaped = skill.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const re = new RegExp('(?:^|[\\s,;|/()\\[\\]])' + escaped + '(?:$|[\\s,;|/()\\[\\]])', 'i');
        return re.test(searchable);
      } catch { return searchable.includes(skill); }
    });

    return roleMatch || skillMatch;
  });

  console.log(`   🏢 Scanned ${COMPANIES.length} companies, ${allJobs.length} total jobs, ${relevant.length} relevant to your profile`);
  if (companyStats.length > 0) {
    const top = companyStats.sort((a, b) => b.count - a.count).slice(0, 10);
    console.log(`   📊 Top sources: ${top.map(c => `${c.name}(${c.count})`).join(', ')}`);
  }

  return relevant;
}

function stripHtml(html) {
  return (html || '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}

module.exports = { fetchCompanyCareers, COMPANIES };
