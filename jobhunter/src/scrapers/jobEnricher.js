const axios = require('axios');
const cheerio = require('cheerio');

const axiosConfig = {
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  },
  timeout: 15000,
};

const SKILL_KEYWORDS = [
  'javascript', 'typescript', 'python', 'java', 'kotlin', 'go', 'rust', 'c++', 'c#', 'php', 'ruby', 'swift',
  'node.js', 'nodejs', 'express', 'nestjs', 'spring boot', 'django', 'fastapi', 'flask', 'ktor', 'graphql', 'rest api', 'grpc',
  'react', 'angular', 'vue', 'next.js', 'nextjs', 'redux', 'html', 'css', 'tailwind',
  'mongodb', 'mysql', 'postgresql', 'redis', 'elasticsearch', 'cassandra', 'dynamodb', 'firebase',
  'docker', 'kubernetes', 'aws', 'gcp', 'azure', 'terraform', 'jenkins', 'ci/cd', 'github actions',
  'kafka', 'rabbitmq', 'sqs', 'pubsub',
  'microservices', 'system design', 'distributed systems', 'api gateway',
  'websocket', 'oauth', 'jwt', 'rest', 'agile', 'scrum',
  'android', 'ios', 'react native', 'flutter',
];

async function enrichJob(job) {
  if (!job.applyLink) return job;

  try {
    const res = await axios.get(job.applyLink, axiosConfig);
    const $ = cheerio.load(res.data);

    // Extract description from various selectors
    let description = '';
    const descSelectors = [
      '.description__text', '.show-more-less-html__markup',
      '.job-description', '[class*="description"]',
      '.jobDescriptionContent', '.job-details',
      'article', '.posting-page',
    ];

    for (const sel of descSelectors) {
      const text = $(sel).first().text().trim();
      if (text && text.length > 50) {
        description = text.slice(0, 2000);
        break;
      }
    }

    // Extract skills from description
    if (description) {
      const lower = description.toLowerCase();
      const skills = SKILL_KEYWORDS.filter(skill => lower.includes(skill));

      // Extract experience
      let experience = job.experience || '';
      if (!experience) {
        const expMatch = description.match(/(\d+)\+?\s*[-–to]*\s*(\d+)?\s*years?\s*(of\s*)?(experience|exp)/i);
        if (expMatch) {
          experience = expMatch[2] ? `${expMatch[1]}-${expMatch[2]} years` : `${expMatch[1]}+ years`;
        }
      }

      return {
        ...job,
        description: description.slice(0, 1000),
        skills: [...new Set([...(job.skills || []), ...skills])],
        experience: experience || job.experience,
      };
    }
  } catch (err) {
    // Silently fail - keep original job data
  }

  return job;
}

async function enrichJobs(jobs, concurrency = 3) {
  console.log(`   🔎 Enriching ${jobs.length} jobs (${concurrency} concurrent)...`);
  const enriched = [];
  let enrichedCount = 0;

  // Process in batches
  for (let i = 0; i < jobs.length; i += concurrency) {
    const batch = jobs.slice(i, i + concurrency);
    const results = await Promise.allSettled(batch.map(j => enrichJob(j)));

    for (const result of results) {
      if (result.status === 'fulfilled') {
        enriched.push(result.value);
        if (result.value.description) enrichedCount++;
      } else {
        enriched.push(batch[results.indexOf(result)]);
      }
    }

    // Small delay between batches
    if (i + concurrency < jobs.length) {
      await new Promise(r => setTimeout(r, 500));
    }
  }

  console.log(`   ✅ Enriched ${enrichedCount}/${jobs.length} jobs with descriptions`);
  return enriched;
}

module.exports = { enrichJob, enrichJobs };
