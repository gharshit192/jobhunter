const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jobhunter-tests-'));
process.env.AUTOMATION_DATA_DIR = tmp;
const store = require('../src/automation/store');
const { evaluate, selectNext, clean } = require('../src/automation/matching');
const { resolve } = require('../src/automation/answers');
const { persistJobs, safeUrl, detectATS } = require('../src/automation/discovery');
const reports = require('../src/automation/reports');
const { COMPANIES } = require('../src/automation/companies');
const profile = { name: 'Test Candidate', email: 'candidate@example.com', experienceYears: 6, cities: ['Indore','Jaipur','Gurgaon','Pune','Vadodara'], excludedCompanies: ['Fretron'], minimumCtcLpa: 26, expectedCtcLpa: 27, currentCtcLpa: 18, currentCity: 'Gurgaon' };
const job = { company: 'Example', title: 'Senior Java Backend Engineer', location: 'Pune, India', description: 'Java Spring Boot microservices. 5+ years experience.', applyLink: 'https://job-boards.greenhouse.io/example/jobs/123', category: 'product' };
before(() => { store.write('profile', profile); store.write('state', { jobs: [], runs: [], events: [], answers: {}, excludedCompanies: [], settings: { autoApply: true, dailyTarget: 10, paused: false } }); });
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
test('manual shortlist excludes completed duplicates, foreign conflicts and unsuitable leads', () => {
  const { build } = require('../src/automation/shortlist');
  const s = { jobs: [{ ...job, status: 'submitted' }, { ...job, company: 'Conflict', foreignEligibilityConflict: true, status: 'needs_input' }], answers: {}, excludedCompanies: [] };
  const leads = [{ ...job, status: 'not_applied' }, { ...job, company: 'Good', source: 'Search', status: 'not_applied', evidenceLevel: 'Search-index posting' }, { ...job, company: 'Low', salary: '18–24 LPA' }, { ...job, company: 'Wrong', title: 'Account Specialist' }];
  const report = build(s, profile, leads);
  assert.equal(report.count, 1); assert.equal(report.jobs[0].company, 'Good'); assert.equal(report.jobs[0].applicationStatus, 'not_applied'); assert.equal(report.jobs[0].salaryStatus, 'unverified');
});
test('backend architecture in an engineer title does not mean architect seniority', () => {
  assert.equal(evaluate({ ...job, title: 'Lead Software Engineer - Backend Architecture' }, profile).eligible, true);
  assert.equal(evaluate({ ...job, title: 'Java Backend Architect' }, profile).eligible, false);
});
test('confirmed production and NoSQL answers resolve while unconfirmed scale remains unanswered', () => {
  const p = { ...profile, nosqlExperienceYears: 5, productionOwnership: true, productionCapabilities: ['Data sharding or partitioning', 'Retry / idempotency mechanisms', 'Caching with consistency considerations'] };
  assert.equal(resolve({ label: 'How many years of work experience do you have with NoSQL?', type: 'text' }, p, {}, '', job).value, '5');
  assert.equal(resolve({ label: 'MongoDB experience years', type: 'text' }, p, {}, '', job).value, '5');
  assert.equal(resolve({ label: 'Have you designed and owned a backend system running in production end-to-end (design → coding → production support)?', type: 'combobox' }, p, {}, '', job).value, 'Yes');
  assert.equal(resolve({ label: 'Which of the following have you personally implemented in production?', type: 'checkbox-group' }, p, {}, '', job).value, p.productionCapabilities.join(';'));
  assert.equal(resolve({ label: 'What is the largest production scale you have personally worked on?', type: 'combobox' }, p, {}, '', job), null);
});
test('new connector and confirmed answers resume old blocks without retrying uncertain or verification attempts', () => {
  const { resumeResolvedBlocks } = require('../src/automation/runner');
  const base = { ...job, status: 'needs_input', match: { eligible: true }, questions: [] };
  const legacy = { ...base, ats: 'workday', reason: 'This portal needs a dedicated application connector. Open the official job and complete it manually.' };
  const answered = { ...base, questions: [{ label: 'Notice period (days)', type: 'text', origin: 'https://example.com' }] };
  const unknown = { ...base, questions: [{ label: 'NoSQL experience years', type: 'text' }] };
  const uncertain = { ...legacy, status: 'submission_uncertain' };
  const verification = { ...legacy, requiresVerification: true };
  const s = { jobs: [legacy, answered, unknown, uncertain, verification], answers: {} };
  resumeResolvedBlocks(s, profile);
  assert.equal(legacy.status, 'queued'); assert.equal(answered.status, 'queued');
  assert.equal(unknown.status, 'needs_input'); assert.equal(uncertain.status, 'submission_uncertain'); assert.equal(verification.status, 'needs_input');
  legacy.status = 'needs_input'; resumeResolvedBlocks(s, profile); assert.equal(legacy.status, 'needs_input');
});
test('distinct companies; at least 30 product and exactly 30 service', () => { assert.equal(new Set(COMPANIES.map(c => c.name)).size, COMPANIES.length); assert.ok(COMPANIES.filter(c => c.category === 'product').length >= 30); assert.equal(COMPANIES.filter(c => c.category === 'service').length, 30); assert.ok(COMPANIES.every(c => !c.ats === !c.board)); });
test('unknown salary is eligible; published maximum below minimum is excluded', () => { assert.equal(evaluate(job, profile).eligible, true); assert.equal(evaluate(job, profile).salaryStatus, 'unverified'); assert.equal(evaluate({ ...job, salary: '18–25 LPA' }, profile).eligible, false); assert.equal(evaluate({ ...job, salary: '26–30 LPA' }, profile).eligible, true); });
test('city, remote-country and full-time rules', () => { assert.equal(evaluate({ ...job, location: 'Bangalore, India' }, profile).eligible, false); assert.equal(evaluate({ ...job, location: 'Remote, India' }, profile).eligible, true); assert.equal(evaluate({ ...job, location: 'Remote, United States' }, profile).eligible, false); assert.equal(evaluate({ ...job, location: 'Remote', isRemote: true }, profile).eligible, false); assert.equal(evaluate({ ...job, employmentType: 'Contract' }, profile).eligible, false); assert.equal(evaluate({ ...job, company: 'Fretron' }, profile).eligible, false); });
test('does not count JavaScript as Java; excludes mandatory eleven years', () => { const result = evaluate({ ...job, title: 'Software Engineer', description: 'JavaScript development' }, profile); assert.ok(!result.reasons.includes('java')); assert.equal(evaluate({ ...job, description: 'Java Spring Boot. 11+ years building backend systems' }, profile).eligible, false); });
test('never auto-applies to out-of-domain or full-stack roles even if a description mentions Java', () => {
  for (const title of ['Account Specialist-Seoul', 'Account Specialist – Gurgaon Based', 'Marketing Software Engineer', 'Senior Data Engineer', 'Senior Java Fullstack Engineer', 'Senior Staff Software Engineer in Test']) assert.equal(evaluate({ ...job, title }, profile).eligible, false, title);
});
test('daily application report excludes rejected discovery matches', () => {
  const s = { settings: { dailyTarget: 10 }, jobs: [{ ...job, discoveredAt: new Date().toISOString(), status: 'excluded', title: 'Account Specialist-Seoul' }, { ...job, discoveredAt: new Date().toISOString(), status: 'queued' }] };
  const report = reports.build(s); assert.equal(report.jobs.length, 1); assert.equal(report.excludedPostings, 1); assert.equal(report.jobs[0].title, job.title);
});
test('encoded Greenhouse descriptions are decoded without HTML residue', () => assert.equal(clean('&lt;p&gt;Java &amp;amp; Kotlin&lt;/p&gt;'), 'Java & Kotlin'));
test('rediscovery preserves submission evidence and first discovery date', () => { persistJobs([job], profile); store.mutate(s => { s.jobs[0].status = 'submitted'; s.jobs[0].submittedAt = new Date().toISOString(); s.jobs[0].confirmation = { text: 'Application received' }; }); const before = store.state().jobs[0]; persistJobs([{ ...job, description: 'Java Spring Boot updated', discoveredAt: '2099-01-01T00:00:00Z' }], profile); const after = store.state().jobs[0]; assert.equal(after.status, 'submitted'); assert.deepEqual(after.confirmation, before.confirmation); assert.equal(after.discoveredAt, before.discoveredAt); assert.equal(store.state().jobs.length, 1); });
test('balances product and service queue without retrying uncertain submissions', () => { const product = { ...job, id: 'p', status: 'queued', match: { score: 95 } }; const service = { ...job, company: 'Service', id: 's', category: 'service', status: 'queued', match: { score: 60 } }; assert.equal(selectNext([product, service], [product], profile).id, 's'); assert.equal(selectNext([{ ...product, status: 'submission_uncertain' }], [], profile), undefined); });
test('salary answers require explicit units and do not invent AWS experience', () => { assert.equal(resolve({ label: 'Expected CTC (LPA)' }, profile, {}, 'https://example.com', job).value, '27'); assert.equal(resolve({ label: 'Expected annual salary in INR' }, profile, {}, 'https://example.com', job).value, '2700000'); assert.equal(resolve({ label: 'Expected salary' }, profile, {}, 'https://example.com', job), null); assert.equal(resolve({ label: 'Years of AWS experience' }, profile, {}, 'https://example.com', job), null); });
test('consent cannot be inferred; saved answers are scoped to company, origin and question', () => { const field = { label: 'Do you agree to retention?*', type: 'checkbox' }; const saved = { 'Example|https://a.example.com|do you agree to retention?': 'Yes' }; assert.equal(resolve(field, profile, {}, 'https://a.example.com', job), null); assert.equal(resolve(field, profile, saved, 'https://a.example.com', job).value, 'Yes'); assert.equal(resolve(field, profile, saved, 'https://b.example.com', job), null); assert.equal(resolve(field, profile, saved, 'https://a.example.com', { ...job, company: 'Other' }), null); });
test('total CTC does not invent fixed, variable or monthly salary amounts', () => { for (const label of ['Current fixed salary', 'Expected monthly salary', 'Current variable CTC']) assert.equal(resolve({ label, type: 'text' }, profile, {}, 'https://example.com', job), null); });
test('report counts only confirmed submissions and exports recruiter follow-ups', () => { const day = store.indiaDay(); const time = new Date().toISOString(); const s = { settings: { dailyTarget: 10 }, jobs: [{ ...job, id: '1', discoveredAt: time, status: 'queued' }, { ...job, id: '2', discoveredAt: time, status: 'submission_uncertain' }, { ...job, id: '3', discoveredAt: time, submittedAt: time, status: 'submitted', confirmation: { text: 'Received' }, outcome: 'recruiter_call', contact: 'Recruiter', notes: 'Interview Friday' }] }; const report = reports.save(s, day); assert.equal(report.confirmedSubmissions, 1); assert.equal(report.shortfall, 9); const csv = fs.readFileSync(path.join(tmp, 'reports', `${day}.csv`), 'utf8'); assert.match(csv, /recruiter_call/); assert.match(csv, /Interview Friday/); assert.ok(fs.existsSync(path.join(tmp, 'reports', `${day}.html`))); });
test('CSV neutralizes formulas and escapes commas and quotes', () => { assert.equal(reports.cell('=HYPERLINK("x")'), '"\'=HYPERLINK(""x"")"'); assert.equal(reports.cell('a,b'), '"a,b"'); });
test('only public HTTPS imports and recognized ATS hosts', () => { for (const url of ['http://example.com','https://127.0.0.1','https://localhost','https://user:pass@example.com']) assert.throws(() => safeUrl(url)); assert.equal(detectATS(job.applyLink).ats, 'greenhouse'); assert.equal(detectATS('https://evil-greenhouse.io/example/jobs/123'), null); });
test('recovering interrupted submit requires reconciliation rather than retry', () => { store.mutate(s => { s.jobs.push({ ...job, id: 'interrupted', status: 'submitting' }); }); require('../src/automation/runner').recover(); assert.equal(store.state().jobs.find(j => j.id === 'interrupted').status, 'submission_uncertain'); });
test('worker lock prevents concurrent runs', () => { const release = store.acquireLock(); assert.throws(() => store.acquireLock(), /already running/); release(); const release2 = store.acquireLock(); release2(); });

test('automatic backend targeting excludes mixed frontend and specialist AI titles', () => {
  const { evaluate } = require('../src/automation/matching');
  const profile = { experienceYears: 6, cities: ['Pune'], excludedCompanies: [], minCtcLpa: 26 };
  for (const title of ['AI Engineer', 'Java Developer with Angular', 'Developer – EDP Analytics Portal', 'Senior Sterling Developer']) {
    assert.equal(evaluate({ company: 'Example', title, location: 'Pune', description: 'Java Spring Boot Kafka backend developer, 5 years experience', employmentType: 'Full time' }, profile).eligible, false, title);
  }
});
test('standing answers apply only once the candidate sets them, and Workday login walls retry only with credentials', () => {
  const { resolve } = require('../src/automation/answers');
  const pan = { label: 'Do you have a PAN number?', type: 'radio' };
  assert.equal(resolve(pan, profile, {}, '', job), null);
  const standing = { ...profile, employment: [{ company: 'Fretron Pvt Ltd' }], standingAnswers: { onlyListedEmployers: true, relativesAtEmployer: false, hasPan: true, nonCompete: false, sanctionedCountryNational: false, aiScreeningConsent: true, aiRecommendationConsent: false } };
  assert.equal(resolve(pan, standing, {}, '', job).value, 'Yes');
  assert.equal(resolve({ label: 'Are you now or have you ever been employed or contracted by an FIS company?', type: 'select-one' }, standing, {}, '', { ...job, company: 'FIS' }).value, 'No');
  assert.equal(resolve({ label: 'Have you previously worked for us?', type: 'select-one' }, standing, {}, '', { ...job, company: 'Fretron' }).value, 'Yes');
  assert.equal(resolve({ label: 'Do you have any relatives that currently work for FIS?', type: 'select-one' }, standing, {}, '', job).value, 'No');
  assert.equal(resolve({ label: 'I consent to FIS using these AI tools to recommend future relevant job opportunities to me:', type: 'select-one' }, standing, {}, '', job).value, 'No');
  assert.equal(resolve({ label: 'What is your current CTC?', type: 'text', numeric: true }, profile, {}, '', job), null);
  assert.equal(resolve({ label: 'What is your current CTC?', type: 'text', numeric: true }, { ...profile, numericSalaryUnit: 'lpa' }, {}, '', job).value, String(profile.currentCtcLpa));
  const { resumeResolvedBlocks } = require('../src/automation/runner');
  const wall = { ...job, ats: 'workday', status: 'needs_input', match: { eligible: true }, requiresLogin: true, questions: [] };
  const previous = process.env.WORKDAY_PASSWORD;
  try {
    delete process.env.WORKDAY_PASSWORD; resumeResolvedBlocks({ jobs: [wall], answers: {} }, profile); assert.equal(wall.status, 'needs_input');
    process.env.WORKDAY_PASSWORD = 'fixture'; resumeResolvedBlocks({ jobs: [wall], answers: {} }, profile); assert.equal(wall.status, 'queued');
    Object.assign(wall, { status: 'needs_input', requiresLogin: true }); resumeResolvedBlocks({ jobs: [wall], answers: {} }, profile); assert.equal(wall.status, 'needs_input');
  } finally { if (previous === undefined) delete process.env.WORKDAY_PASSWORD; else process.env.WORKDAY_PASSWORD = previous; }
});
test('LinkedIn India pay converts to LPA so the minimum salary rule applies', () => {
  const { lpaRange } = require('../src/automation/linkedin');
  const { salaryMaxLpa } = require('../src/automation/matching');
  assert.equal(salaryMaxLpa({ salary: lpaRange('₹25L/yr - ₹35L/yr') }), 35);
  assert.equal(salaryMaxLpa({ salary: lpaRange('₹1,800,000/yr') }), 18);
  assert.equal(salaryMaxLpa({ salary: lpaRange('') }), null);
});
