function normalize(text) { return String(text).toLowerCase().replace(/[*✱]/g, '').replace(/\s+/g, ' ').trim(); }
function resolve(field, profile, saved, origin, job) {
  const label = normalize(field.label), type = field.type;
  const override = saved[`${job.company}|${origin}|${label}`];
  if (override !== undefined) return { value: override, source: 'Your saved answer' };
  const standing = standingAnswer(label, profile.standingAnswers, profile, job);
  if (standing) return standing;
  // Consent, declarations, referrals and unknown eligibility answers need an explicit per-question answer.
  if (/consent|agree|certify|declar|acknowledge|privacy|terms|retain|marketing|\breferr|previously|ever worked|relative|conflict|non.compete|background/.test(label)) return null;
  if (/gender|ethnicity|race|veteran|disability|sexual orientation|demographic/.test(label)) return { value: 'Prefer not to disclose', source: 'Your demographic preference', optional: true };
  if (/how.*hear.*(?:opportun|position|job)|how.*find.*(?:opportun|position|job)/.test(label) && job.source) return { value: job.source, source: 'Verified job discovery source' };
  if (/first name|given name/.test(label)) return answer(profile.firstName);
  if (/last name|family name|surname/.test(label)) return answer(profile.lastName);
  if (/^(full )?name$|^your name$/.test(label)) return answer(profile.name);
  if (type === 'email' || /^e.?mail(?: address)?$/.test(label)) return answer(profile.email);
  if (/country.*code|phone.*country/.test(label)) return answer('India (+91)');
  if (/phone|mobile/.test(label) && !/code|country/.test(label)) return answer(profile.phone);
  if (/linkedin/.test(label)) return answer(profile.linkedin);
  if (/github/.test(label)) return answer(profile.github);
  if (/current (company|employer)|^company$|^organization$/.test(label)) return answer(profile.currentCompany);
  if (/current (title|designation)|^current role$/.test(label)) return answer(profile.currentTitle);
  if (/fixed|variable|bonus|stock|equity|monthly|per month|take.home/.test(label) && /salary|ctc|compensation|pay/.test(label)) return null;
  if (/current.*(?:ctc|salary|compensation)/.test(label)) return answer(salary(field, profile.currentCtcLpa, profile));
  if (/(expected|desired).*?(ctc|salary|compensation)/.test(label)) return answer(salary(field, profile.expectedCtcLpa, profile));
  if (/notice period|how soon.*join|when.*join/.test(label)) return answer(/days/.test(label) ? '30' : '1 month');
  if (/reason.*(change|leav|switch)/.test(label)) return answer(profile.reasonForChange);
  const foreignScope = /czech|united states|\busa\b|u\.s\.|united kingdom|\buk\b|canada|germany|singapore|australia|\beu\b|thailand|japan/.test(label);
  const indiaRole = /india/i.test(job.location) || profile.cities?.some(c => String(job.location || '').toLowerCase().includes(c.toLowerCase())) || /gurugram/i.test(job.location);
  if (foreignScope && /authorized|eligible|able.*work|sponsorship|visa/.test(label)) return null;
  if (/legally.*(authorized|eligible)|authorized to work|right to work/.test(label) && (indiaRole || /india/.test(label))) return answer('Yes');
  if (/visa sponsorship|require.*sponsorship/.test(label) && indiaRole) return answer('No');
  if (/^country$|country of residence/.test(label)) return answer('India');
  if (/in which country.*currently based/.test(label)) return answer('India');
  if (/^current (city|location)$|^city$|^location \(city\)$/.test(label)) return answer(field.type === 'combobox' && profile.currentState ? `Gurugram, ${profile.currentState}, India` : profile.currentCity);
  if (/^school$|^institution$|^college$|^university$/.test(label)) return answer(profile.education?.institution);
  if (/^degree$/.test(label)) return answer('Bachelor of Technology');
  if (/^discipline$|field of study/.test(label)) return answer('Information Technology');
  if (/cover letter/.test(label) && type !== 'file') return answer(coverLetter(profile, job));
  if (/designed and owned.*backend.*production.*end.to.end/.test(label)) return answer(profile.productionOwnership === true ? 'Yes' : undefined);
  if (type === 'checkbox-group' && /personally implemented in production/.test(label)) return profile.productionCapabilities?.length ? answer(profile.productionCapabilities.join(';')) : null;
  if (type === 'checkbox-group' && /backend languages.*production.*3.*years/.test(label)) return answer('Java');
  if (/would you be open.*(?:relocat|working from)|willing.*(?:relocat|work)|comfortable working/.test(label) && profile.cities.some(c => label.includes(c.toLowerCase()))) return answer('Yes');
  if (/(?:18|eighteen) years of age|age of (?:18|eighteen)|over (?:18|eighteen)|at least (?:18|eighteen)/.test(label)) return answer('Yes');
  if (/comfortable|open to|willing/.test(label) && /remote|hybrid|work from office|on.?site|in.?office/.test(label) && indiaRole) return answer('Yes');
  if (/(?:available|earliest|possible) (?:start|joining) date|when can you (?:start|join)/.test(label) && ['text', 'textarea'].includes(type)) return answer(`${profile.noticeDays || 30} days from offer (notice period)`);
  if (/preferred (?:work )?location|location preference/.test(label) && ['text', 'textarea'].includes(type)) return answer(/country,\s*city/.test(label) ? `India, ${profile.currentCity}` : `${profile.currentCity}, India (also ${profile.cities.filter(c => c !== profile.currentCity).join(', ')}, or remote)`);
  if (/(?:current|present) (?:job )?location|where do you (?:currently )?(?:reside|live)|confirm your current location/.test(label)) return answer(field.type === 'combobox' && profile.currentState ? `Gurugram, ${profile.currentState}, India` : `${profile.currentCity}, India`);
  if (/where did you (?:learn|hear|find)|how did you (?:learn|hear|find)/.test(label) && job.source) return answer(job.source);
  if (/^(?:how many )?years of (?:work )?experience(?: do you have)?\??$|^total experience/.test(label)) return answer(String(profile.experienceYears || 6));
  if (/years|experience/.test(label)) {
    if (/nosql|no.sql|mongodb|mongo db/.test(label)) return answer(profile.nosqlExperienceYears);
    if (/aws|amazon web/.test(label)) return null;
    if (/kafka/.test(label)) return answer('5.5');
    if (/leadership|manag.*team|lead.*team/.test(label)) return answer('3');
    if (/system design|java\b|kotlin|spring|node\.?js|gcp|google cloud/.test(label)) return answer('5');
    if (/total.*experience|professional.*experience|overall.*experience|relevant full.time experience/.test(label)) return answer('6');
  }
  return null;
}
// Declarations most employers repeat. Each applies only after the candidate sets it in profile.standingAnswers.
function standingAnswer(label, standing, profile, job) {
  if (!standing) return null;
  const yesNo = value => typeof value === 'boolean' ? { value: value ? 'Yes' : 'No', source: 'Your standing answer' } : null;
  if (/(?:ever|previously|formerly).*(?:employed|worked|contracted)|(?:employed|worked|contracted).*(?:before|previously)/.test(label) && standing.onlyListedEmployers === true) {
    const employer = normalize(job.company);
    return yesNo((profile.employment || []).some(e => normalize(e.company).includes(employer) || employer.includes(normalize(e.company).replace(/ pvt ltd| private limited/, ''))));
  }
  // Conflict-of-interest screens: government oversight, contract authority, outside employment.
  if (/government (?:office|agency|official)|public official|(?:negotiate|influence|sign).*contracts?/.test(label)) return yesNo(standing.conflictOfInterest);
  if (/outside (?:employment|activit|business)|secondary employment|moonlight/.test(label)) return yesNo(standing.outsideEmployment);
  if (/background (?:check|verification|screening)/.test(label)) return yesNo(standing.backgroundCheck);
  if (/(?:current|prior|former|previous) employee|contractor of/.test(label) && standing.onlyListedEmployers === true) {
    const employer = normalize(job.company);
    return yesNo((profile.employment || []).some(e => normalize(e.company).includes(employer) || employer.includes(normalize(e.company).replace(/ pvt ltd| private limited/, ''))));
  }
  if (/relative|family member|related to/.test(label) && /work|employ/.test(label)) return yesNo(standing.relativesAtEmployer);
  if (/\bpan\b/.test(label)) return yesNo(standing.hasPan);
  if (/non.compete|no.solicitation|restrictive covenant/.test(label)) return yesNo(standing.nonCompete);
  if (/cuba|iran|north korea|syria|crimea|sanction/.test(label)) return yesNo(standing.sanctionedCountryNational);
  if (/artificial intelligence|\bai\b/.test(label) && /consent|would like to use|agree|permission/.test(label)) return yesNo(/recommend|future/.test(label) ? standing.aiRecommendationConsent : standing.aiScreeningConsent);
  return null;
}
function answer(value) { return value === undefined ? null : { value: String(value), source: 'Confirmed candidate profile' }; }
function salary(field, lpa, profile = {}) {
  const label = normalize(field.label);
  if (/lpa|lakhs?|lacs?/.test(label)) return String(lpa);
  if (/annual|yearly|per annum|\binr\b|rupees/.test(label)) return String(lpa * 100000);
  // A bare numeric box gives no unit; use the unit the candidate confirmed for such questions.
  if (field.numeric || field.type === 'number') return profile.numericSalaryUnit === 'lpa' ? String(lpa) : profile.numericSalaryUnit === 'inr' ? String(lpa * 100000) : undefined;
  if (['text', 'textarea'].includes(field.type)) return `INR ${lpa} LPA`;
  // Never guess units for a numeric salary question.
  return undefined;
}
function coverLetter(profile, job) {
  return `Dear Hiring Team,\n\nI am applying for the ${job.title} position at ${job.company}. I have 6+ years of professional experience and currently work as a Senior Backend Developer at Fretron. My work includes backend systems for logistics, commerce and warehouse platforms, marketplace and carrier integrations, inventory consistency, and production reliability.\n\nMy experience with Java, Kotlin, Spring Boot, Node.js, MongoDB, Redis, Elasticsearch and GCP/GKE would help me contribute to backend engineering and integration work. I have worked on OMS/WMS/TMS workflows and optimistic locking for concurrent inventory and order updates.\n\nI would welcome the opportunity to discuss the role. My notice period is one month and negotiable.\n\nRegards,\n${profile.name}`;
}
module.exports = { resolve, normalize, coverLetter };
