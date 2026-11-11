const store = require('./store');
const { resolve } = require('./answers');
const { postedFrom } = require('./matching');
// Naukri refuses headless browsers, so discovery and applications run in the off-screen window, only inside the quiet hours.
const OFFSCREEN = { offscreen: true };
const SLUG = { Gurgaon: 'gurugram', Gurugram: 'gurugram' };
function lpa(text) {
  const m = String(text || '').match(/(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)\s*Lacs/i);
  return m ? `${m[1]}-${m[2]} LPA` : '';
}
async function discover(profile, onProgress = store.event, { limit = 200 } = {}) {
  const browser = require('./browser');
  const { persistJobs } = require('./discovery');
  const { companyFor } = require('./linkedin');
  const { detectATS } = require('./discovery');
  const known = new Set(store.state().jobs.filter(j => /^naukri:/.test(j.requisitionId || '')).map(j => j.requisitionId.slice(7)));
  const jobs = []; let page;
  try {
    page = await (await require('./browser').open('https://www.naukri.com/mnjuser/homepage', OFFSCREEN));
    if (/nlogin|login/i.test(page.url())) { onProgress('Naukri: login required'); return jobs; }
    // Freshest first (posted in the last day, then 3 days, then 7) so applications land early, when recruiters still read them.
    // Three keywords over 1-3 day postings kept returning the same few jobs, so the search covers wider terms and a 7-day page.
    const KEYWORDS = ['java backend developer', 'java spring boot developer', 'senior java developer', 'java microservices developer', 'java developer', 'backend engineer java'];
    for (const city of profile.cities) for (const keywords of KEYWORDS) for (const pageNo of [1, 2, 3]) {
      if (jobs.length >= limit) break;
      const slug = `${keywords.replace(/\s+/g, '-')}-jobs-in-${SLUG[city] || city.toLowerCase()}${pageNo > 1 ? `-${pageNo}` : ''}`;
      const url = `https://www.naukri.com/${slug}?k=${encodeURIComponent(keywords)}&l=${encodeURIComponent(SLUG[city] || city.toLowerCase())}&experience=${profile.experienceYears || 6}&jobAge=${[1, 3, 7][pageNo - 1]}`;
      try { await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 }); } catch { onProgress(`Naukri ${city} / ${keywords}: page timed out; skipped`); continue; }
      await page.waitForTimeout(4000);
      if (/access denied/i.test(await page.title())) { onProgress('Naukri: blocked the browser; stopping discovery'); persistJobs(jobs, profile); return jobs; }
      const cards = await page.evaluate(() => [...document.querySelectorAll('.srp-jobtuple-wrapper[data-job-id]')].map(el => ({
        id: el.getAttribute('data-job-id'), title: el.querySelector('a.title')?.innerText.trim(), href: el.querySelector('a.title')?.href,
        company: el.querySelector('.comp-name')?.innerText.trim(), exp: el.querySelector('.expwdth')?.innerText.trim(),
        salary: el.querySelector('.sal')?.innerText.trim(), location: el.querySelector('.locWdth')?.innerText.trim(),
        posted: el.querySelector('.job-post-day')?.innerText.trim() || '',
      })).filter(c => c.id && c.href));
      let added = 0;
      for (const card of cards) {
        if (jobs.length >= limit || known.has(card.id)) continue; known.add(card.id);
        if (!/java|backend|back.end|spring|kotlin/i.test(card.title || '')) continue;
        // The job page loads its details as JSON; for "Apply on company site" jobs that JSON carries the employer's link,
        // so it is read here instead of clicking the button (Naukri records that click as an application).
        let external = '';
        const onResponse = async res => {
          try {
            if (external || !/naukri\.com\/jobapi\//.test(res.url()) || !/json/.test(res.headers()['content-type'] || '')) return;
            external = externalLink(await res.json()) || '';
          } catch {}
        };
        page.on('response', onResponse);
        try {
          await page.goto(card.href, { waitUntil: 'domcontentloaded', timeout: 45000 }); await page.waitForTimeout(2500);
          const detail = await page.evaluate(() => ({
            description: document.querySelector('[class*="job-desc-container"]')?.innerText.trim() || '',
            companySite: !!document.querySelector('#company-site-button'),
            applied: [...document.querySelectorAll('button')].some(b => /^applied$/i.test(b.innerText.trim())),
          }));
          if (detail.applied || detail.description.length < 200) continue;
          const company = companyFor(card.company || '') || { name: card.company, category: 'unlisted', categorySource: '' };
          const base = { title: card.title, company: company.name, category: company.category, categorySource: company.categorySource, location: card.location || city,
            salary: lpa(card.salary), experience: card.exp, description: detail.description, requisitionId: `naukri:${card.id}`, naukriLink: card.href.split('?')[0], publishedAt: postedFrom(card.posted) || undefined, discoveredAt: new Date().toISOString() };
          if (detail.companySite) {
            // A supported employer ATS is applied to directly; any other employer site waits for the candidate.
            const connector = external && detectATS(external);
            if (connector) jobs.push({ ...base, applyLink: external, ats: connector.ats, source: 'Naukri (company site)', naukriCompanySite: true });
            else jobs.push({ ...base, applyLink: external || base.naukriLink, ats: 'company_site', source: 'Naukri (company site)', naukriCompanySite: true, externalApplyLink: external || undefined });
          } else jobs.push({ ...base, applyLink: base.naukriLink, source: 'Naukri', ats: 'naukri', naukriCompanySite: false });
          added++;
        } catch { onProgress(`Naukri: could not read posting ${card.id}`); }
        finally { page.off('response', onResponse); }
      }
      onProgress(`Naukri ${city} / ${keywords}${pageNo > 1 ? ` p${pageNo}` : ''}: ${cards.length} cards, ${added} new backend postings (${jobs.length} total)`);
      if (cards.length < 15) break;
    }
    persistJobs(jobs, profile); holdCompanySiteJobs(); return jobs;
  } finally { if (page) await page.close().catch(() => {}); }
}
// Employer sites without a supported connector cannot be filled in automatically; list them for the candidate instead.
function holdCompanySiteJobs() {
  store.mutate(s => {
    for (const j of s.jobs) if (j.ats === 'company_site' && j.status === 'queued') {
      j.status = 'needs_input'; j.questions = [];
      j.reason = j.externalApplyLink ? 'Apply on company site: open the employer link, apply, then mark it applied' : 'Apply on company site: open on Naukri and use "Apply on company site", then mark it applied';
    }
  });
}
// Find the employer's application URL in Naukri's job-details JSON, whatever the field is called.
function externalLink(data, depth = 0) {
  if (!data || typeof data !== 'object' || depth > 5) return null;
  for (const [key, value] of Object.entries(data)) {
    if (typeof value === 'string' && /redirect|companyapply|applyurl|externalurl|company_?site/i.test(key) && /^https?:\/\//.test(value) && !/naukri\.com/i.test(value)) return value;
  }
  for (const value of Object.values(data)) { const found = externalLink(value, depth + 1); if (found) return found; }
  return null;
}
async function apply(job, profile, saved, options, api) {
  let page; const usedAnswers = [];
  try {
    if (!require('./browser').quietHours() && !options.interactive) return { status: 'queued', reason: 'Naukri applications run only during the quiet hours' };
    page = await api.open(job.applyLink, { ...OFFSCREEN, interactive: options.interactive });
    await page.waitForTimeout(4000);
    if (/nlogin|login/i.test(page.url())) return { status: 'needs_input', reason: 'Naukri login required; sign in from the dashboard', requiresLogin: true, questions: [] };
    if (/access denied/i.test(await page.title())) return { status: 'needs_input', reason: 'Naukri blocked the browser; try again later', questions: [] };
    const body = async () => (await page.locator('body').innerText()).replace(/\s+/g, ' ');
    if (/no longer (?:available|accepting)|job (?:has )?expired/i.test(await body())) return { status: 'excluded', reason: 'Naukri posting is closed' };
    if (await page.locator('button, span, div, a').filter({ hasText: /^\s*applied\s*$/i }).count()) return { status: 'needs_input', reason: 'Naukri already shows Applied; verify the earlier application', questions: [] };
    const companySite = page.locator('#company-site-button:visible');
    const apply = page.locator('#apply-button:visible');
    if (!await apply.count()) {
      if (!await companySite.count()) return { status: 'needs_input', reason: 'Naukri page has no Apply button', questions: [], evidence: await api.screenshot(page, job, 'naukri-noapply') };
      // Naukri records a click on "Apply on company site" as an application, so never click it just to read the link.
      return { status: 'needs_input', reason: 'Apply on company site: open on Naukri and use "Apply on company site", then mark it applied', questions: [] };
    }
    if (options.dryRun) return { status: 'ready', reason: 'Naukri apply button found; not submitted in dry run' };
    const state = store.state(); if (state.settings.paused || !state.settings.autoApply) return { status: 'queued', reason: 'Paused before Naukri submission' };
    await apply.first().click();
    // Either Naukri applies at once (saveApply), or its chatbot asks recruiter questions first.
    for (let turn = 0; turn < 12; turn++) {
      await page.waitForTimeout(2500);
      const text = await body();
      if (/myapply\/saveApply/.test(page.url()) || /applied to\s+"/i.test(text) || /successfully applied/i.test(text)) {
        const confirmation = { at: new Date().toISOString(), source: 'Naukri', text: (text.match(/applied to\s+"[^"]{0,120}"?|successfully applied[^.]{0,80}/i) || ['Naukri application saved'])[0] };
        store.mutate(s => Object.assign(s.jobs.find(j => j.id === job.id), { status: 'submitted', submittedAt: confirmation.at, confirmation, usedAnswers }));
        return { status: 'submitted', submittedAt: confirmation.at, confirmation, usedAnswers, evidence: await api.screenshot(page, job, 'naukri-submitted') };
      }
      const bot = page.locator('[class*="chatbot_Drawer"], [class*="chatbot_drawer"], .chatbot_DrawerContentWrapper').first();
      if (!await bot.count()) continue;
      const messages = await bot.locator('[class*="botMsg"], [class*="bot-msg"], li[class*="bot"]').allInnerTexts().catch(() => []);
      const question = (messages.pop() || '').trim();
      if (!question) continue;
      // The chatbot's closing line is not a question; Naukri saves the application a moment later.
      if (/^thank you for (?:your )?(?:responses|answers)/i.test(question)) {
        if (await page.locator('button, span, div, a').filter({ hasText: /^\s*applied\s*$/i }).count()) {
          const confirmation = { at: new Date().toISOString(), source: 'Naukri', text: 'Chatbot completed; Naukri shows Applied' };
          store.mutate(s => Object.assign(s.jobs.find(j => j.id === job.id), { status: 'submitted', submittedAt: confirmation.at, confirmation, usedAnswers }));
          return { status: 'submitted', submittedAt: confirmation.at, confirmation, usedAnswers, evidence: await api.screenshot(page, job, 'naukri-submitted') };
        }
        // A resumed chatbot can stop on its closing line with the final Save still pending.
        const save = bot.locator('[class*="sendMsg"], button:has-text("Save"), button:has-text("Submit"), [class*="send"]').last();
        if (await save.count() && await save.isVisible().catch(() => false)) await save.click().catch(() => {});
        continue;
      }
      // Chips can be empty wrappers; only visible chips with text are real choices. No choices means a typed answer.
      const CHIPS = '[class*="ssrc__radio"] label, [class*="chip"], [class*="singleselect"] label, [class*="multicheckbox"] label';
      const raw = await bot.locator(CHIPS).evaluateAll(es => es.map((e, i) => ({ i, t: (e.innerText || e.textContent || '').trim(), shown: !!(e.offsetWidth || e.offsetHeight) }))).catch(() => []);
      // The chip's position is kept apart from its value, so a numeric answer ("3") can never match the 4th chip by position.
      const options = raw.filter(o => o.t && o.shown && o.t.length < 120).map(o => ({ label: o.t, value: o.t, index: o.i }));
      const field = { label: question, type: options.length ? 'radio' : 'text', required: true, options };
      // A screening question about Angular means the role needs front-end work, which you skip.
      if (/\bangular\b/i.test(question)) return { status: 'excluded', reason: 'Role needs Angular (front-end); skipped by your preference', usedAnswers };
      const answer = resolve(field, profile, saved, 'naukri', job);
      if (!answer?.value) return { status: 'needs_input', reason: 'Naukri chatbot needs your answer', questions: [{ ...field, origin: 'naukri', reason: 'No confirmed answer' }], usedAnswers, evidence: await api.screenshot(page, job, 'naukri-chatbot') };
      const input = bot.locator('[contenteditable="true"], textarea, input[type="text"]').last();
      const { optionMatch } = require('./browser');
      let opt = options.length ? optionMatch(options, answer.value) : null;
      // A city/relocation question whose choices omit the saved city: pick one of the candidate's preferred cities instead.
      if (!opt && options.length && /city|location|relocat/i.test(question)) opt = (profile.cities || []).map(c => optionMatch(options, c)).find(Boolean) || null;
      if (opt) await bot.locator(CHIPS).nth(opt.index).click();
      else if (await input.count() && await input.isVisible().catch(() => false)) { await input.click(); await input.fill(String(answer.value)).catch(async () => { await input.pressSequentially(String(answer.value)); }); }
      else return { status: 'needs_input', reason: 'Naukri chatbot answer does not match the choices', questions: [{ ...field, origin: 'naukri', reason: 'Answer does not match the available choices' }], usedAnswers, evidence: await api.screenshot(page, job, 'naukri-chatbot') };
      usedAnswers.push({ label: question, value: answer.value, source: answer.source });
      const send = bot.locator('[class*="sendMsg"], button:has-text("Save"), button:has-text("Submit"), [class*="send"]').last();
      if (await send.count()) await send.click(); else await page.keyboard.press('Enter');
    }
    // After the chatbot closes, the job page shows "Applied" only once it is reloaded.
    await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {}); await page.waitForTimeout(4000);
    if (await page.locator('button, span, div, a').filter({ hasText: /^\s*applied\s*$/i }).count()) {
      const confirmation = { at: new Date().toISOString(), source: 'Naukri', text: 'Job page shows Applied after the chatbot closed' };
      store.mutate(s => Object.assign(s.jobs.find(j => j.id === job.id), { status: 'submitted', submittedAt: confirmation.at, confirmation, usedAnswers }));
      return { status: 'submitted', submittedAt: confirmation.at, confirmation, usedAnswers, evidence: await api.screenshot(page, job, 'naukri-submitted') };
    }
    return { status: 'submission_uncertain', reason: 'Naukri apply clicked but no confirmation was recognised; check Naukri "Applies" before retrying', usedAnswers, evidence: await api.screenshot(page, job, 'naukri-uncertain') };
  } finally { if (page && !options.interactive) await page.close().catch(() => {}); }
}
// Naukri applications send the resume stored on the Naukri profile, so a new resume file is uploaded there once.
// The chosen file's name also appears in the upload box before Naukri saves it, so success is counted only when,
// after a reload, the saved resume line shows the new file name with today's upload date.
async function syncResume(profile, onProgress = store.event) {
  if (!profile.resumeFile || store.state().settings.naukriResume === profile.resumeFile) return;
  const path = require('path'), fs = require('fs');
  const file = path.join(store.ROOT, profile.resumeFile);
  if (!fs.existsSync(file)) return onProgress(`Naukri resume: ${profile.resumeFile} not found; not uploaded`);
  let page;
  try {
    page = await require('./browser').open('https://www.naukri.com/mnjuser/profile', OFFSCREEN);
    await page.waitForTimeout(5000);
    if (/nlogin|login/i.test(page.url())) return onProgress('Naukri resume: login required; not uploaded');
    const input = page.locator('input[type="file"]').first();
    if (!await input.count()) return onProgress('Naukri resume: upload field not found on the profile page; not uploaded');
    await input.setInputFiles(file);
    const stem = profile.resumeFile.replace(/\.[^.]+$/, '');
    const today = new Date().toLocaleDateString('en-US', { timeZone: 'Asia/Kolkata', month: 'short', day: '2-digit', year: 'numeric' });
    const saved = () => page.evaluate(([s, d]) => { const t = document.body.innerText; const i = t.indexOf(`${s}.`); return i >= 0 && t.slice(i, i + 200).includes(`Uploaded on ${d}`); }, [stem, today]).catch(() => false);
    await page.waitForTimeout(15000);
    await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {}); await page.waitForTimeout(6000);
    const shown = await saved();
    await require('./browser').screenshot(page, { id: 'naukri-profile', company: 'Naukri profile' }, shown ? 'resume-uploaded' : 'resume-upload-unconfirmed');
    if (!shown) return onProgress('Naukri resume: upload not confirmed (new file name not shown); will retry next run');
    store.mutate(s => { s.settings.naukriResume = profile.resumeFile; });
    onProgress(`Naukri resume updated to ${profile.resumeFile}`);
  } catch (error) { onProgress(`Naukri resume upload failed: ${error.message.split('\n')[0].slice(0, 160)}`); }
  finally { await page?.close().catch(() => {}); }
}
module.exports = { discover, apply, lpa, syncResume };
