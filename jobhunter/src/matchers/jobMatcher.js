// ── Job Matching Engine ───────────────────────────────────────────────────────
// Scores each job against your resume profile

const fs = require('fs');
const path = require('path');

// ── Load company lists from config.json ─────────────────────────────────────
let PREFERRED_COMPANIES = [];
let AVOID_COMPANIES = [];
try {
  const config = JSON.parse(fs.readFileSync(path.join(__dirname, '../../config.json'), 'utf-8'));
  PREFERRED_COMPANIES = (config.preferred || []).map(c => c.toLowerCase());
  AVOID_COMPANIES = (config.blocked || []).map(c => c.toLowerCase());
} catch {
  PREFERRED_COMPANIES = [];
  AVOID_COMPANIES = [];
}

// ── Score a Single Job ────────────────────────────────────────────────────────
function scoreJob(job, resumeProfile) {
  let score = 0;
  const reasons = [];

  const jobSkills      = (job.skills || []).map(s => s.toLowerCase());
  const jobTitle       = (job.title || '').toLowerCase();
  const jobDesc        = (job.description || '').toLowerCase();
  const company        = (job.company || '').toLowerCase();
  const resumeSkills   = resumeProfile.skills.map(s => s.toLowerCase());
  const resumeExp      = resumeProfile.experience || 2;
  const resumeRoles    = resumeProfile.roles.map(r => r.toLowerCase());

  // ── 1. Skill Matching (max 40 points) ─────────────────────────────────────
  // Check skills array AND description/title with word-boundary matching
  const searchText = [jobTitle, jobDesc, ...jobSkills].join(' ').toLowerCase();
  const matchedSkills = resumeSkills.filter(skill => {
    // Exact match in job skills array (must be exact or substring of multi-word skill, not partial word)
    if (jobSkills.some(js => js === skill || js === skill.replace('.', '') || skill === js.replace('.', ''))) return true;
    // Word-boundary match in description/title (avoid "java" matching "javascript")
    try {
      const escaped = skill.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp('(?:^|[\\s,;|/()\\[\\]])' + escaped + '(?:$|[\\s,;|/()\\[\\]])', 'i');
      return re.test(searchText);
    } catch { return searchText.includes(skill); }
  });
  // Score = matched / max(job requires, 5) — measures how well you cover what the JOB needs
  // If job lists 4 skills and you match 3, that's 3/4 = 75% of 40 = 30pts
  // If job lists 0 skills, fall back to matched count * 8 (capped at 40)
  const jobSkillCount = jobSkills.length > 0 ? jobSkills.length : 5;
  const skillScore = Math.min(40, jobSkills.length > 0
    ? Math.round((matchedSkills.length / jobSkillCount) * 40)
    : Math.min(40, matchedSkills.length * 8)
  );
  score += skillScore;
  if (matchedSkills.length > 0) {
    reasons.push(`Skills matched: ${matchedSkills.join(', ')} (+${skillScore})`);
  }

  // ── 1b. Missing Required Skills Penalty (max -10) ────────────────────────
  // If job description lists required skills the user doesn't have, penalize
  const requiredPattern = /required\s*(?:skills|qualifications)?[:\s]*([\s\S]*?)(?:\n\n|preferred|nice to have|$)/i;
  const requiredMatch = jobDesc.match(requiredPattern);
  if (requiredMatch) {
    const requiredSection = requiredMatch[1].toLowerCase();
    const missingRequired = jobSkills.filter(js =>
      requiredSection.includes(js) && !resumeSkills.some(rs => js.includes(rs) || rs.includes(js))
    );
    if (missingRequired.length > 0) {
      const penalty = Math.min(10, missingRequired.length * 2);
      score -= penalty;
      reasons.push(`Missing required skills: ${missingRequired.join(', ')} (-${penalty})`);
    }
  }

  // ── 2. Role Title Matching (max 20 points) ─────────────────────────────────
  // Match role titles as PHRASES first (full role string match), then fallback
  const titleWords = [
    'engineer', 'developer', 'backend', 'frontend', 'fullstack', 'full stack', 'sde', 'platform', 'devops',
    'product manager', 'program manager', 'designer', 'analyst', 'scientist', 'manager', 'lead', 'head',
    'marketing', 'growth', 'sales', 'operations', 'consultant', 'strategist', 'coordinator',
  ];

  // Try full phrase match first
  const fullPhraseMatch = resumeRoles.some(role => jobTitle.includes(role));
  // Fallback: partial word match — require at least 2 words from the role to match
  const partialWordMatch = !fullPhraseMatch && resumeRoles.some(role => {
    const words = role.split(' ').filter(w => w.length > 3);
    const matched = words.filter(w => jobTitle.includes(w));
    return matched.length >= 2;
  });
  const titleRelevant = titleWords.some(w => jobTitle.includes(w));

  if (fullPhraseMatch) {
    score += 20;
    reasons.push('Role title matched (full phrase) (+20)');
  } else if (partialWordMatch) {
    score += 12;
    reasons.push('Role title partial match (+12)');
  } else if (titleRelevant) {
    score += 8;
    reasons.push('Related role title (+8)');
  }

  // ── 3. Experience Range Match (max 15 points) ──────────────────────────────
  const expMatch = String(job.experience || '').match(/(\d+)\s*[-–to]+\s*(\d+)/);
  if (expMatch) {
    const [, min, max] = expMatch.map(Number);
    if (resumeExp >= min && resumeExp <= max) {
      score += 15;
      reasons.push(`Experience match ${min}-${max} yrs (+15)`);
    } else if (resumeExp >= min - 1 && resumeExp <= max + 1) {
      score += 8;
      reasons.push(`Near experience match (+8)`);
    }
  } else {
    score += 5; // no experience listed = open to all, less certain match
  }

  // ── 4. Preferred Company (max 10 points) ───────────────────────────────────
  if (PREFERRED_COMPANIES.some(pc => company.includes(pc))) {
    score += 10;
    reasons.push('Preferred company (+10)');
  }

  // ── 5. Remote/Flexible (max 5 points) ─────────────────────────────────────
  if (job.isRemote || jobDesc.includes('remote') || jobDesc.includes('hybrid')) {
    score += 5;
    reasons.push('Remote/Hybrid (+5)');
  }

  // ── 6. Avoid blocklist ─────────────────────────────────────────────────────
  if (AVOID_COMPANIES.some(ac => company.includes(ac))) {
    score = Math.max(0, score - 30);
    reasons.push('Avoided company (-30)');
  }

  // Cap at 100
  score = Math.min(100, Math.max(0, score));

  return { score, reasons, matchedSkills };
}

// ── Match All Jobs ────────────────────────────────────────────────────────────
function matchJobs(jobs, resumeProfile) {
  return jobs
    .map(job => {
      const { score, reasons, matchedSkills } = scoreJob(job, resumeProfile);
      return { ...job, matchScore: score, matchReasons: reasons, matchedSkills };
    })
    .sort((a, b) => b.matchScore - a.matchScore);
}

// ── Categorize Jobs ───────────────────────────────────────────────────────────
function categorizeJobs(scoredJobs) {
  return {
    highMatch:   scoredJobs.filter(j => j.matchScore >= 75),
    mediumMatch: scoredJobs.filter(j => j.matchScore >= 50 && j.matchScore < 75),
    lowMatch:    scoredJobs.filter(j => j.matchScore < 50),
  };
}

module.exports = { scoreJob, matchJobs, categorizeJobs };
