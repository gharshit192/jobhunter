const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const store = require('../src/automation/store');
const root = `http://127.0.0.1:${process.env.AUTOMATION_PORT || 4129}`;
(async () => {
  const health = await fetch(`${root}/api/health`).then(r => r.json()); assert.equal(health.ok, true); assert.equal(health.browserMode, 'headless');
  const unauthorized = await fetch(`${root}/api/run`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'apply' }) }); assert.equal(unauthorized.status, 403);
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.goto(root); await page.waitForFunction(() => document.getElementById('profileInfo').textContent.length > 0);
    await page.getByRole('button', { name: 'Relevant jobs', exact: true }).click();
    await page.locator('#shortlistJobs article').first().waitFor();
    const portalShortlist = await fetch(`${root}/api/shortlist`).then(r => r.json());
    assert.equal(await page.locator('#shortlistJobs article').count(), portalShortlist.count);
    for (const name of ['OZI Technologies','EPAM','MakeMyTrip','Nextloop Technologies']) assert.ok((await page.locator('#shortlistJobs').innerText()).includes(name));
    await page.getByRole('textbox', { name: 'Search relevant jobs' }).fill('OZI');
    assert.equal(await page.locator('#shortlistJobs article').count(), 1);
    await page.getByRole('textbox', { name: 'Search relevant jobs' }).fill('');
    await page.getByRole('button', { name: '60 companies', exact: true }).click();
    assert.equal(await page.locator('#companyRows tr').count(), 60);
    await page.getByRole('button', { name: 'Saved daily reports', exact: true }).click();
    await page.getByRole('link', { name: 'Download CSV' }).first().waitFor();
    const shortlistLink = page.getByRole('link', { name: 'Relevant jobs and manual completion flags' });
    assert.equal(await shortlistLink.getAttribute('href'), `/reports/shortlist-${store.indiaDay()}.html`);
    const shortlistResponse = await fetch(`${root}/reports/shortlist-${store.indiaDay()}.json`);
    assert.equal(shortlistResponse.status, 200);
    const shortlist = await shortlistResponse.json();
    assert.equal(shortlist.count, shortlist.jobs.length);
    assert.ok(shortlist.jobs.every(j => j.applicationStatus !== 'submitted'));
    const report = await fetch(`${root}/reports/${store.indiaDay()}.json`).then(r => r.json());
    assert.ok(report.jobs.every(j => j.status !== 'excluded'));
    assert.ok(!report.jobs.some(j => /account specialist|marketing|sales/i.test(j.title)));
    await page.getByRole('button', { name: 'Applications', exact: true }).click();
    await page.screenshot({ path: path.join(store.ROOT, 'dashboard-preview.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: path.join(store.ROOT, 'dashboard-mobile.png'), fullPage: true });
    assert.deepEqual(errors, []);
    console.log('Dashboard, company list, daily reports, mobile rendering and mutation protection verified');
    if (process.argv.includes('--hirist-profile')) {
      const release = store.acquireLock(); let profilePage;
      try {
        profilePage = await require('../src/automation/browser').open('https://www.hirist.tech/profile'); await profilePage.waitForTimeout(4000);
        const expected = require('../src/automation/runner').profile();
        const result = await profilePage.evaluate(expected => {
          const text = document.body.innerText;
          const ownEmail = text.toLowerCase().includes(expected.email.toLowerCase()) || [...document.querySelectorAll('input')].some(el => String(el.value).toLowerCase() === expected.email.toLowerCase());
          return { url: location.origin + location.pathname, ownEmail, ownName: text.includes(expected.name), title: document.title, inputs: [...document.querySelectorAll('input')].filter(el => !!(el.offsetWidth || el.offsetHeight)).map(el => ({ type: el.type, placeholder: el.placeholder })), accountLabels: [...document.querySelectorAll('a,button')].filter(el => /profile|log.?out|login|applications|harshit/i.test(el.innerText)).map(el => el.innerText.trim().slice(0,70)).slice(0,20) };
        }, { name: expected.name, email: expected.email });
        store.write('hirist-profile-check', { ...result, checkedAt: new Date().toISOString() }); console.log(JSON.stringify(result));
        if (result.ownEmail && result.ownName) store.write('platform-status', [...store.read('platform-status', []).filter(p => p.name !== 'Hirist'), { name: 'Hirist', status: 'authenticated', checkedAt: new Date().toISOString(), mode: 'manual', note: 'Read-only profile page confirmed the candidate email and name' }]);
      } finally { if (profilePage) await profilePage.close(); await require('../src/automation/browser').close(); release(); }
    }
    if (process.argv.includes('--hirist-login')) {
      assert.equal(health.running, false); const release = store.acquireLock();
      try { console.log(JSON.stringify(await require('../src/automation/hirist').login(require('../src/automation/runner').profile()))); }
      finally { await require('../src/automation/browser').close(); release(); }
    }
    if (process.argv.includes('--linkedin-run')) {
      assert.equal(health.running, false);
      const worker = require('../src/automation/runner'); const release = store.acquireLock();
      try {
        const jobs = await require('../src/automation/linkedin').discover(worker.profile());
        console.log(JSON.stringify({ discovered: jobs.length, roles: store.state().jobs.filter(j => j.ats === 'linkedin').map(j => ({ company: j.company, title: j.title, status: j.status, blocked: j.match.blocked })) }));
      } finally { await require('../src/automation/browser').close(); release(); }
      store.mutate(s => { for (const j of s.jobs) if (j.ats === 'linkedin' && j.status === 'needs_input' && (j.questions || []).length && j.questions.every(q => require('../src/automation/answers').resolve(q, worker.profile(), s.answers, q.origin, j))) j.status = 'queued'; });
      store.mutate(s => { for (const j of s.jobs) if (j.ats === 'linkedin' && j.status === 'needs_input' && /^locator.waitFor|^Complete LinkedIn job description|^Easy Apply needs manual attention at an unsupported step|^Easy Apply exceeds the supported step limit/.test(j.reason || '') && j.description.length >= 200 && j.match.eligible) j.status = 'queued'; });
      const next = store.state().jobs.find(j => j.ats === 'linkedin' && j.status === 'queued' && j.match.eligible);
      let attempts = 0, job = next;
      while (job && attempts++ < 15 && worker.todays(store.state()).length < store.state().settings.dailyTarget) {
        try { console.log(JSON.stringify(await worker.run({ discovery: false, apply: true, jobId: job.id }))); } finally { await require('../src/automation/browser').close(); }
        job = store.state().jobs.find(j => j.ats === 'linkedin' && j.status === 'queued' && j.match.eligible);
      }
    }
    if (process.argv.includes('--linkedin-jobs')) {
      const release = store.acquireLock(); let jobsPage;
      try {
        jobsPage = await require('../src/automation/browser').open('https://www.linkedin.com/jobs/search/?keywords=Java%20Backend&location=Pune%2C%20Maharashtra%2C%20India&f_AL=true');
        await jobsPage.waitForTimeout(4000);
        const jobs = await jobsPage.evaluate(() => {
          return { title: document.title, url: location.href.split('?')[0], jobLinks: [...document.querySelectorAll('a[href*="/jobs/view/"],a[href*="currentJobId="]')].slice(0,25).map(el => ({ title: el.innerText.trim().slice(0,150), url: el.href })), cards: [...document.querySelectorAll('[data-job-id],[data-occludable-job-id],.job-card-container')].slice(0,15).map(el => ({ id: el.getAttribute('data-job-id') || el.getAttribute('data-occludable-job-id'), text: el.innerText.trim().slice(0,500) })) };
        });
        store.write('linkedin-job-discovery', { ...jobs, checkedAt: new Date().toISOString() }); console.log(JSON.stringify(jobs));
      } finally { if (jobsPage) await jobsPage.close(); await require('../src/automation/browser').close(); release(); }
    }
    if (process.argv.includes('--inspect-hirist-email')) {
      await require('../src/automation/email').findHiristOTP(Date.now() - 30 * 60 * 1000, require('../src/automation/runner').profile().email);
      console.log(JSON.stringify(store.read('hirist-email-status', {})));
    }
    if (process.argv.includes('--workday-dry-run')) {
      assert.equal(health.running, false);
      const worker = require('../src/automation/runner');
      const job = store.state().jobs.find(j => j.company === 'Mastercard' && j.ats === 'workday' && j.match?.eligible && j.status === 'needs_input');
      assert.ok(job, 'No eligible Workday role');
      const release = store.acquireLock();
      try {
        const result = await require('../src/automation/browser').apply(job, worker.profile(), store.state().answers, { dryRun: true });
        store.mutate(s => Object.assign(s.jobs.find(j => j.id === job.id), result)); require('../src/automation/reports').save();
        console.log(JSON.stringify({ company: job.company, title: job.title, status: result.status, reason: result.reason, requiresLogin: result.requiresLogin }));
      } finally { await require('../src/automation/browser').close(); release(); }
    }
    if (process.argv.includes('--hirist-flow')) {
      const login = await browser.newPage();
      try {
        await login.goto('https://www.hirist.tech/login', { waitUntil: 'domcontentloaded', timeout: 30000 });
        await login.waitForTimeout(1800);
        const choices = login.getByRole('button', { name: /^(?:login|sign in)$/i }).or(login.getByRole('link', { name: /^(?:login|sign in)$/i }));
        for (let i = 0; i < await choices.count(); i++) if (await choices.nth(i).isVisible()) { await choices.nth(i).click(); break; }
        await login.waitForTimeout(1000);
        const flow = await login.evaluate(() => {
          const visible = el => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
          return { url: location.href.split('?')[0], inputs: [...document.querySelectorAll('input')].filter(visible).map(el => ({ type: el.type, placeholder: el.placeholder, autocomplete: el.autocomplete })), buttons: [...document.querySelectorAll('button')].filter(visible).map(el => el.innerText.trim()).filter(Boolean) };
        });
        store.write('hirist-login-flow', { ...flow, checkedAt: new Date().toISOString() }); console.log(JSON.stringify(flow));
      } finally { await login.close(); }
    }
    if (process.argv.includes('--setup-portals')) {
      assert.equal(health.running, false, 'Wait for the current worker run');
      const result = await page.evaluate(async () => {
        async function post(url, method, body) {
          const response = await fetch(url, { method, headers: { 'Content-Type': 'application/json', 'X-JobHunter-Token': TOKEN }, body: JSON.stringify(body) });
          if (!response.ok) throw Error((await response.json()).error || 'Local action failed');
        }
        await post('/api/settings', 'PATCH', { dailyTarget: 15 });
        for (const name of ['Naukri', 'Instahyre', 'Hirist']) await post('/api/platforms/' + name + '/open', 'POST', {});
        return 'Daily target set to 15; Naukri, Instahyre and Hirist opened in the same dedicated worker browser';
      });
      console.log(result);
    }
    if (process.argv.includes('--inspect-email')) {
      const email = require('../src/automation/email');
      await email.findCode('Druva', Date.now() - 6 * 60 * 60 * 1000, require('../src/automation/runner').profile().email);
      console.log(JSON.stringify(store.read('email-diagnostic', {})));
    }
    if (process.argv.includes('--inspect-platforms')) {
      assert.equal(health.running, false, 'Wait for the current worker run');
      const release = store.acquireLock();
      try { const results = await require('../src/automation/platforms').inspect(); console.log(JSON.stringify(results.map(({ name, status, discoveredLinks }) => ({ name, status, jobLinks: discoveredLinks?.length || 0 })))); }
      finally { await require('../src/automation/browser').close(); release(); }
    }
    if (process.argv.includes('--retry-email')) {
      assert.equal(health.running, false, 'Wait for the current worker run');
      assert.equal(require('../src/automation/email').status().connected, true, 'Authenticate Gmail first');
      const worker = require('../src/automation/runner');
      const candidates = store.state().jobs.filter(j => j.status === 'needs_input' && j.company === 'Druva' && (j.requiresEmailCode || /HTTP 428/.test(j.reason || '')) && !(j.questions || []).length);
      const job = candidates.find(j => {
        const file = path.join(store.ROOT, 'evidence', j.id + '-submission.html');
        return fs.existsSync(file) && /security-input-0/.test(fs.readFileSync(file, 'utf8'));
      });
      assert.ok(job, 'No verified email-code rejection eligible for retry');
      store.mutate(s => Object.assign(s.jobs.find(j => j.id === job.id), { status: 'queued', requiresEmailCode: true, reason: 'Retrying a confirmed email-code rejection with authenticated local Gmail' }));
      try { console.log(JSON.stringify(await worker.run({ discovery: false, apply: true, jobId: job.id }))); }
      finally { await require('../src/automation/browser').close(); }
    }
    if (process.argv.includes('--apply')) {
      const index = process.argv.indexOf('--job');
      const jobId = index >= 0 ? process.argv[index + 1] : undefined;
      const result = await page.evaluate(async jobId => {
        const response = await fetch('/api/run', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-JobHunter-Token': TOKEN }, body: JSON.stringify({ mode: 'apply', jobId }) });
        return { status: response.status, body: await response.json() };
      }, jobId);
      assert.equal(result.status, 200); console.log('Today’s authorized submission run started');
    }
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
