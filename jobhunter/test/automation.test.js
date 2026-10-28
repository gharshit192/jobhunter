const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jobhunter-tests-'));
process.env.AUTOMATION_DATA_DIR = tmp;
const store = require('../src/automation/store');
const { evaluate, selectNext, clean, postedFrom, freshness } = require('../src/automation/matching');
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
test('distinct companies; at least 30 each of product, service and startup', () => { assert.equal(new Set(COMPANIES.map(c => c.name.toLowerCase())).size, COMPANIES.length); for (const category of ['product', 'service', 'startup']) assert.ok(COMPANIES.filter(c => c.category === category).length >= 30, category); assert.ok(COMPANIES.every(c => !c.ats === !c.board)); });
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
test('postings older than a week are skipped and fresher ones rank first', () => {
  const day = 86400000, now = Date.now();
  assert.equal(Math.round((now - Date.parse(postedFrom('Posted 3 Days Ago', now))) / day), 3);
  assert.equal(Math.round((now - Date.parse(postedFrom('Just now', now))) / day), 0);
  assert.equal(postedFrom('', now), null);
  const at = d => new Date(now - d * day).toISOString();
  assert.ok(evaluate({ ...job, publishedAt: at(2) }, profile).eligible);
  assert.ok(evaluate({ ...job, publishedAt: at(8) }, profile).blocked.includes('Posted more than a week ago'));
  // With no posting date, a job first seen over a week ago is at least that old.
  assert.ok(evaluate({ ...job, discoveredAt: at(9) }, profile).blocked.includes('Posted more than a week ago'));
  assert.deepEqual([at(0.5), at(2), at(6)].map(publishedAt => freshness({ publishedAt })), [0, 1, 2]);
});
test('LinkedIn alert emails are parsed as text without opening links', () => {
  const { parseAlert, similarTitle } = require('../src/automation/linkedinAlerts');
  const text = 'Your job alert for back end developer in Pune District\nManage alerts: https://www.linkedin.com/x\n\nSenior Java Developer\nCognologix Technologies\nPune Division\nView job: https://www.linkedin.com/comm/jobs/view/4436996438/?trk=1\n\n------------------------\n\nSoftware Engineer\nbp\nPune Division\n\n3 connections\nView job: https://www.linkedin.com/comm/jobs/view/4478235032/\n';
  assert.deepEqual(parseAlert(text).map(j => [j.id, j.title, j.company]), [['4436996438', 'Senior Java Developer', 'Cognologix Technologies'], ['4478235032', 'Software Engineer', 'bp']]);
  assert.ok(similarTitle('Senior Java Developer', 'Sr. Java Developer'));
  assert.ok(!similarTitle('Java Backend Engineer', 'Data Engineer'));
  // LinkedIn-only jobs keep location and seniority checks, but are never queued for the worker.
  assert.ok(evaluate({ ...job, title: 'Senior Software Engineer', description: '', ats: 'linkedin_manual' }, profile).eligible);
  assert.ok(!evaluate({ ...job, title: 'Senior Software Engineer', description: '', ats: 'linkedin_manual', location: 'Berlin' }, profile).eligible);
  assert.equal(selectNext([{ ...job, ats: 'linkedin_manual', status: 'queued', match: { eligible: true, score: 90 } }], [], profile), undefined);
});
test('choice matching handles renamed cities, "City, State" labels and year answers', () => {
  const { optionMatch } = require('../src/automation/browser');
  const opts = labels => labels.map((label, i) => ({ label, value: String(i) }));
  assert.equal(optionMatch(opts(['Gurugram, Haryana', 'Noida, Uttar Pradesh']), 'Gurugram').label, 'Gurugram, Haryana');
  assert.equal(optionMatch(opts(['Pune', 'Gurugram', 'Delhi']), 'Gurgaon, India').label, 'Gurugram');
  assert.equal(optionMatch(opts(['No experience', '<3 years', '3-4 years']), '4 years').label, '3-4 years');
  assert.equal(optionMatch(opts(['1-2', '2-3', '3+']), '3+').label, '3+');
  assert.equal(optionMatch(opts(['Pune, Maharashtra', 'Kolkata, West Bengal']), 'Gurugram'), undefined);
  // A rating given out of 10 is rescaled; a numeric answer never matches a choice by its position.
  const rating = ['1/5_Beginner', '2/5_Intermediate', '3/5_Proficient', '4/5_Advanced', '5/5_Expert'].map((label, index) => ({ label, value: label, index }));
  assert.equal(optionMatch(rating, '8').label, '4/5_Advanced');
  assert.equal(optionMatch(rating, '3').label, '3/5_Proficient');
});
test('at most two applications per company and never the same role twice', () => {
  const { repeatReason } = require('../src/automation/matching');
  const applied = (company, title, id) => ({ id, company, title, status: 'submitted' });
  assert.equal(repeatReason({ id: 'n', company: 'Persistent', title: 'Java Developer' }, [applied('Persistent Systems', 'Senior Java Developer', 'a')]), null);
  assert.match(repeatReason({ id: 'n', company: 'ConsultAsia', title: 'Java Backend Developer' }, [applied('ConsultAsia', 'Java Backend Developer', 'a')]), /repost/);
  assert.match(repeatReason({ id: 'n', company: 'Infosys', title: 'Java Developer' }, [applied('Infosys', 'A', 'a'), applied('Infosys Limited', 'B', 'b')]), /limit is 2/);
});
test('expected salary: a range when typed, the single expected figure in a number box', () => {
  const { resolve } = require('../src/automation/answers');
  const p = { ...profile, minimumCtcLpa: 24, expectedCtcLpa: 26, maximumCtcLpa: 28, numericSalaryUnit: 'lpa' };
  assert.equal(resolve({ label: 'Expected CTC', type: 'text' }, p, {}, '', job).value, 'INR 24-28 LPA');
  assert.equal(resolve({ label: 'Expected CTC (LPA)', type: 'number', numeric: true }, p, {}, '', job).value, '26');
});
test('inbox: receipts, one-active-application notes and confirm requests are classified', () => {
  const { classify } = require('../src/automation/inbox');
  assert.equal(classify('Just a quick note to confirm that we’ve received your application. We will contact shortlisted candidates for an interview.', 'Senior Software Engineer - Teleport'), 'received');
  assert.equal(classify('You have an active application for another position. Our staffing team will review your profile.', 'Your application results'), 'received');
  assert.equal(classify('Please confirm your application by creating an EPAM India account', 'Confirm your application'), 'action');
  assert.equal(classify('We would like to invite you for an interview. Please pick a slot on calendly.com/x', 'Next steps'), 'interview');
});
test('inbox: an interview invitation with decline/reschedule options is an interview, not a rejection', () => {
  const { classify } = require('../src/automation/inbox');
  assert.equal(classify('Invitation to your interview Wednesday 06:30 PM. Please accept the invitation. Accept interview. Unfortunately, I am unable to confirm my availability. Decline & Cancel', 'EPAM Technical Interview: Harshit Gupta'), 'interview');
});
test('inbox: calendar updates and your own replies collapse into one entry per conversation', () => {
  const { dedupe } = require('../src/automation/inbox');
  const item = (date, from, subject) => ({ date, from, subject, company: 'Loadsmart', category: 'interview' });
  const items = dedupe([
    item('2026-10-22T09:31', 'HR <hr@loadsmart.in>', 'Invitation from an unknown sender: Loadsmart | Software Developer Interview | Harshit| 23 O... @ Fri Oct 23, 2026 4pm'),
    item('2026-10-23T08:34', 'HR <hr@loadsmart.in>', 'Updated invitation: Loadsmart | Software Developer Interview | Harshit| 23 O... @ Sat Oct 24, 2026 4pm'),
    item('2026-10-23T14:29', 'Me <me@example.com>', 'Re: Updated invitation: Loadsmart | Software Developer Interview | Harshit| 23 O... @ Sat Oct 24, 2026 4pm'),
    { ...item('2026-10-23T12:32', 'EPAM <x@epam.com>', 'EPAM Technical Interview: Harshit Gupta'), company: 'Epam' },
  ], ['me@example.com']);
  assert.deepEqual(items.map(i => i.date), ['2026-10-23T12:32', '2026-10-23T08:34']);
});

test('a hand-recorded job without a link does not break duplicate checks', () => {
  const { canonical } = require('../src/automation/matching');
  assert.equal(canonical(''), '');
  assert.equal(canonical('https://x.com/a/?utm_source=z'), 'https://x.com/a');
});
