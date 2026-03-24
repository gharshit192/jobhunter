const fs = require('fs');
const path = require('path');
const { Resume } = require('../models');

// ── Skill Keywords Bank ───────────────────────────────────────────────────────
const SKILL_KEYWORDS = [
  // Languages
  'javascript', 'typescript', 'python', 'java', 'kotlin', 'go', 'rust', 'c++', 'c#', 'php', 'ruby', 'swift',
  // Backend
  'node.js', 'nodejs', 'express', 'nestjs', 'spring boot', 'django', 'fastapi', 'flask', 'ktor', 'graphql', 'rest api', 'grpc',
  // Frontend
  'react', 'angular', 'vue', 'next.js', 'nextjs', 'redux', 'html', 'css', 'tailwind',
  // Databases
  'mongodb', 'mysql', 'postgresql', 'redis', 'elasticsearch', 'cassandra', 'dynamodb', 'firebase',
  // DevOps/Cloud
  'docker', 'kubernetes', 'aws', 'gcp', 'azure', 'terraform', 'jenkins', 'ci/cd', 'github actions',
  // Messaging
  'kafka', 'rabbitmq', 'sqs', 'pubsub',
  // Concepts
  'microservices', 'system design', 'distributed systems', 'api gateway', 'load balancer',
  'websocket', 'oauth', 'jwt', 'rest', 'agile', 'scrum',
  // Mobile
  'android', 'ios', 'react native', 'flutter',
  // Product / Management
  'product management', 'roadmap', 'user research', 'a/b testing', 'okr', 'kpi',
  'stakeholder management', 'prioritization', 'go-to-market', 'product strategy',
  'user stories', 'jira', 'confluence', 'figma', 'miro', 'analytics',
  'sql', 'tableau', 'power bi', 'mixpanel', 'amplitude', 'segment',
  // Design
  'ui/ux', 'ux design', 'ui design', 'wireframing', 'prototyping', 'sketch', 'adobe xd',
  // Marketing
  'seo', 'sem', 'content marketing', 'growth hacking', 'google analytics', 'hubspot',
  'social media', 'email marketing', 'copywriting', 'brand strategy',
  // Data / Analytics
  'data analysis', 'machine learning', 'deep learning', 'nlp', 'tensorflow', 'pytorch',
  'pandas', 'numpy', 'scikit-learn', 'spark', 'hadoop', 'etl', 'data pipeline',
  // Business
  'business development', 'sales', 'crm', 'salesforce', 'negotiation',
  'strategic planning', 'market research', 'competitive analysis', 'financial modeling',
  'excel', 'powerpoint', 'presentation',
];

const ROLE_KEYWORDS = [
  // Engineering
  'backend engineer', 'backend developer', 'software engineer', 'software developer',
  'full stack', 'fullstack', 'node.js developer', 'platform engineer',
  'devops engineer', 'sre', 'data engineer', 'android developer',
  'lead engineer', 'senior engineer', 'principal engineer', 'frontend developer',
  'frontend engineer', 'mobile developer', 'ios developer',
  // Product
  'product manager', 'senior product manager', 'associate product manager',
  'product owner', 'program manager', 'technical program manager',
  'group product manager', 'director of product', 'head of product', 'vp product',
  // Design
  'ux designer', 'ui designer', 'product designer', 'ux researcher',
  'design lead', 'creative director',
  // Data
  'data scientist', 'data analyst', 'business analyst', 'ml engineer',
  'machine learning engineer', 'ai engineer', 'analytics manager',
  // Marketing
  'marketing manager', 'growth manager', 'content manager', 'brand manager',
  'digital marketing', 'seo specialist', 'performance marketing',
  // Business
  'business development', 'account manager', 'sales manager', 'customer success',
  'operations manager', 'project manager', 'strategy manager', 'consultant',
];

// ── Parse PDF Resume ──────────────────────────────────────────────────────────
async function parseResumePDF(filePath) {
  try {
    const pdfParse = require('pdf-parse');
    const dataBuffer = fs.readFileSync(filePath);
    const data = await pdfParse(dataBuffer);
    return data.text;
  } catch (err) {
    console.error('PDF parse error:', err.message);
    return '';
  }
}

// ── Extract Skills ────────────────────────────────────────────────────────────
function extractSkills(text) {
  const lower = text.toLowerCase();
  return SKILL_KEYWORDS.filter(skill => {
    // Escape special regex characters, then use word boundary matching
    const escaped = skill.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp('\\b' + escaped + '\\b', 'i');
    return regex.test(lower);
  });
}

// ── Extract Experience Years from Work Dates ─────────────────────────────────
const MONTH_MAP = {
  jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2,
  apr: 3, april: 3, may: 4, jun: 5, june: 5, jul: 6, july: 6,
  aug: 7, august: 7, sep: 8, september: 8, oct: 9, october: 9,
  nov: 10, november: 10, dec: 11, december: 11,
};

function extractExperienceFromDates(text) {
  // Match patterns like "Jan 2020 - Present", "2019 - 2022", "Mar 2021 - Dec 2023"
  const dateRangePattern = /(?:(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+)?(\d{4})\s*[-–—to]+\s*(?:(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+)?(\d{4}|present|current|now|ongoing)/gi;

  let totalMonths = 0;
  let matchFound = false;
  let match;

  while ((match = dateRangePattern.exec(text)) !== null) {
    matchFound = true;
    const startMonth = match[1] ? MONTH_MAP[match[1].toLowerCase()] || 0 : 0;
    const startYear = parseInt(match[2]);
    const endMonthStr = match[3];
    const endYearStr = match[4].toLowerCase();

    let endYear, endMonth;
    if (['present', 'current', 'now', 'ongoing'].includes(endYearStr)) {
      const now = new Date();
      endYear = now.getFullYear();
      endMonth = now.getMonth();
    } else {
      endYear = parseInt(endYearStr);
      endMonth = endMonthStr ? MONTH_MAP[endMonthStr.toLowerCase()] || 11 : 11;
    }

    const months = (endYear - startYear) * 12 + (endMonth - startMonth);
    if (months > 0 && months < 600) { // sanity check: less than 50 years
      totalMonths += months;
    }
  }

  if (matchFound && totalMonths > 0) {
    return Math.round(totalMonths / 12);
  }
  return null; // no date-based experience found
}

// ── Extract Experience Years ──────────────────────────────────────────────────
function extractExperience(text) {
  // First try date-based calculation
  const dateBasedExp = extractExperienceFromDates(text);
  if (dateBasedExp !== null) return dateBasedExp;

  // Fallback to phrase-based extraction
  const patterns = [
    /(\d+)\+?\s*years?\s*of\s*experience/i,
    /experience\s*[:of]*\s*(\d+)\+?\s*years?/i,
    /(\d+)\+?\s*yrs?\s*of\s*experience/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return parseInt(match[1]);
  }
  return 2; // default
}

// ── Extract Name & Email ──────────────────────────────────────────────────────
function extractContact(text) {
  const emailMatch = text.match(/[\w.-]+@[\w.-]+\.\w+/);
  const lines = text.split('\n').filter(l => l.trim().length > 0);
  return {
    email: emailMatch ? emailMatch[0] : '',
    name: lines[0]?.trim() || '',
  };
}

// ── Extract Preferred Roles ───────────────────────────────────────────────────
function extractRoles(text) {
  const lower = text.toLowerCase();
  return ROLE_KEYWORDS.filter(role => lower.includes(role.toLowerCase()));
}

// ── Fallback Role Extraction ─────────────────────────────────────────────────
function extractFallbackRoles(text) {
  const lower = text.toLowerCase();
  // Try to detect broad domain from resume content
  const domainHints = [
    { keywords: ['product manager', 'product management', 'roadmap', 'user stories', 'prds'], role: 'product manager' },
    { keywords: ['ux design', 'ui design', 'wireframe', 'figma', 'prototype'], role: 'product designer' },
    { keywords: ['data scientist', 'machine learning', 'deep learning', 'model training'], role: 'data scientist' },
    { keywords: ['data analyst', 'analytics', 'tableau', 'power bi', 'sql'], role: 'data analyst' },
    { keywords: ['marketing', 'seo', 'growth', 'campaigns', 'brand'], role: 'marketing manager' },
    { keywords: ['sales', 'revenue', 'pipeline', 'crm', 'account'], role: 'sales manager' },
    { keywords: ['project manager', 'pmp', 'project management', 'milestones'], role: 'project manager' },
    { keywords: ['devops', 'terraform', 'kubernetes', 'ci/cd', 'infrastructure'], role: 'devops engineer' },
    { keywords: ['frontend', 'react', 'angular', 'vue', 'css'], role: 'frontend developer' },
    { keywords: ['backend', 'node.js', 'django', 'spring', 'api'], role: 'backend engineer' },
    { keywords: ['mobile', 'android', 'ios', 'flutter', 'react native'], role: 'mobile developer' },
  ];

  for (const hint of domainHints) {
    const matchCount = hint.keywords.filter(k => lower.includes(k)).length;
    if (matchCount >= 2) return [hint.role];
  }
  return ['software engineer']; // ultimate fallback
}

// ── Main Parse Function ───────────────────────────────────────────────────────
async function parseResume(filePath, userId) {
  console.log(`📄 Parsing resume: ${filePath}`);

  let rawText = '';

  // Detect file type by reading magic bytes (multer saves without extension)
  const buffer = fs.readFileSync(filePath);
  const isPDF = buffer.length >= 4 && buffer.slice(0, 4).toString() === '%PDF';

  if (filePath.endsWith('.pdf') || isPDF) {
    rawText = await parseResumePDF(filePath);
  } else if (filePath.endsWith('.txt')) {
    rawText = fs.readFileSync(filePath, 'utf-8');
  } else {
    // Try as plain text fallback
    rawText = buffer.toString('utf-8');
  }

  const skills     = extractSkills(rawText);
  const experience = extractExperience(rawText);
  const roles      = extractRoles(rawText);
  const contact    = extractContact(rawText);

  const resumeData = {
    rawText,
    skills,
    experience,
    roles: roles.length > 0 ? roles : extractFallbackRoles(rawText),
    name: contact.name,
    email: contact.email,
    updatedAt: new Date(),
  };

  console.log(`✅ Resume parsed:`);
  console.log(`   Name: ${resumeData.name}`);
  console.log(`   Skills: ${skills.join(', ')}`);
  console.log(`   Experience: ${experience} years`);
  console.log(`   Roles: ${resumeData.roles.join(', ')}`);

  // Save to MongoDB (scoped per user)
  const filter = userId ? { userId } : {};
  if (userId) resumeData.userId = userId;
  await Resume.findOneAndUpdate(filter, resumeData, { upsert: true, new: true });

  return resumeData;
}

module.exports = { parseResume, extractSkills, extractExperience };
