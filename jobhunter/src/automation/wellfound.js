const store = require('./store');
const { resolve } = require('./answers');
const { postedFrom } = require('./matching');
// Wellfound works headless. Applications are a short note plus any custom questions, sent from a modal.
function interestNote(profile, job) {
  return `I'm a ${profile.currentTitle} at ${profile.currentCompany} with ${profile.experienceYears}+ years building backend systems in Java, Kotlin and Spring Boot: OMS/WMS platforms, marketplace and carrier integrations, Kafka, MongoDB, Redis and GKE. The ${job.title} role at ${job.company} matches that backend and integration work, and I'd like to bring that ownership to your team. Notice period: ${profile.noticeDays} days.`;
}
// "₹20L – ₹28L" → "20-28 LPA"; USD and blank salaries stay blank (matching treats them as undisclosed).
function lpa(text) {
  const m = String(text || '').match(/₹\s?([\d.]+)L\s*[–-]\s*₹\s?([\d.]+)L/);
  return m ? `${m[1]}-${m[2]} LPA` : '';
}
async function discover(profile, onProgress = store.event, { limit = 60 } = {}) {
  const { persistJobs } = require('./discovery');
  const { companyFor } = require('./linkedin');
  const known = new Set(store.state().jobs.filter(j => /^wellfound:/.test(j.requisitionId || '')).map(j => j.requisitionId.slice(10)));
  const jobs = []; let page;
  try {
    page = await require('./browser').open('https://wellfound.com/jobs');
    await page.waitForTimeout(6000);
    if (/login/.test(page.url())) { onProgress('Wellfound: login required'); return jobs; }
    // The personal search (Backend Engineer, Gurgaon) loads more cards as the page scrolls.
    for (let i = 0; i < 6; i++) { await page.mouse.wheel(0, 4000); await page.waitForTimeout(1500); }
    const links = await page.evaluate(() => [...new Set([...document.querySelectorAll('a[href*="/jobs/"]')].map(a => a.href.split('?')[0]).filter(h => /\/jobs\/\d+-/.test(h)))]);
    for (const href of links) {
      if (jobs.length >= limit) break;
      const id = href.match(/\/jobs\/(\d+)/)[1];
      if (known.has(id)) continue; known.add(id);
      if (known.size % 10 === 0) onProgress(`Wellfound: reading postings (${jobs.length} backend so far)`);
      try {
        await page.goto(href, { waitUntil: 'domcontentloaded', timeout: 45000 }); await page.waitForTimeout(3000);
        const d = await page.evaluate(() => {
          const text = document.body.innerText;
          const h = [...document.querySelectorAll('h1, h2')].map(e => e.innerText.trim());
          const titleLine = h.find(t => / at /.test(t)) || h[0] || '';
          return { titleLine, text: text.slice(0, 12000), applied: [...document.querySelectorAll('button')].some(b => /^applied$/i.test(b.innerText.trim())), external: [...document.querySelectorAll('a, button')].some(b => /apply on (?:company|their) (?:site|website)/i.test(b.innerText)) };
        });
        const [, title, company] = d.titleLine.match(/^(.*) at (.*)$/) || [null, d.titleLine, ''];
        if (!title || !company || d.applied || d.external) continue;
        if (!/backend|back.end|java|spring|kotlin|software engineer|sde/i.test(title)) continue;
        const salary = lpa((d.text.match(/₹\s?[\d.]+L\s*[–-]\s*₹\s?[\d.]+L/) || [''])[0]);
        const location = (d.text.match(/Location\s*\n([^\n]+)/) || [, ''])[1] + (/(?:Remote|Hires remotely) [^\n]*India/i.test(d.text) ? ' · Remote (India)' : '');
        const c = companyFor(company) || { name: company, category: 'unlisted', categorySource: '' };
        jobs.push({ title, company: c.name, category: c.category, categorySource: c.categorySource, location, salary, description: d.text, applyLink: href,
          source: 'Wellfound', ats: 'wellfound', requisitionId: `wellfound:${id}`, publishedAt: postedFrom((d.text.match(/(?:posted|reposted)[^\n]{0,20}?(\d+\+?\s*(?:day|week|month)s?\s*ago|today|yesterday|just now)/i) || [])[1]) || undefined, discoveredAt: new Date().toISOString() });
      } catch { onProgress(`Wellfound: could not read posting ${id}`); }
    }
    onProgress(`Wellfound: ${links.length} listings checked; ${jobs.length} new backend postings`);
    persistJobs(jobs, profile); return jobs;
  } finally { if (page) await page.close().catch(() => {}); }
}
async function apply(job, profile, saved, options, api) {
  let page; const usedAnswers = [];
  try {
    page = await api.open(job.applyLink, { interactive: options.interactive });
    await page.waitForTimeout(4000);
    if (/login/.test(page.url())) return { status: 'needs_input', reason: 'Wellfound login required', requiresLogin: true, questions: [] };
    if (await page.getByRole('button', { name: /^\W*applied$/i }).count()) return { status: 'needs_input', reason: 'Wellfound already shows Applied; verify the earlier application', questions: [] };
    const applyButton = page.getByRole('button', { name: /^apply(?: now)?$/i }).first();
    if (!await applyButton.count()) return { status: 'needs_input', reason: 'Wellfound job has no Apply button (closed or external)', questions: [], evidence: await api.screenshot(page, job, 'wellfound-noapply') };
    await applyButton.click(); await page.waitForTimeout(3000);
    const modal = page.locator('[role=dialog]').last();
    if (!await modal.count()) return { status: 'needs_input', reason: 'Wellfound apply form did not open', questions: [], evidence: await api.screenshot(page, job, 'wellfound-nomodal') };
    const text = (await modal.innerText()).replace(/\s+/g, ' ');
    if (/visa sponsorship not available/i.test(text) && !/india/i.test(text)) return { status: 'excluded', reason: 'Wellfound role is outside India without sponsorship' };
    // Every textarea is a question; its label is the nearest preceding text block.
    const boxes = modal.locator('textarea');
    const questions = [];
    for (let i = 0; i < await boxes.count(); i++) {
      const box = boxes.nth(i);
      const label = (await box.evaluate(el => { let n = el; for (let k = 0; k < 4 && n; k++) { n = n.parentElement; const t = n?.innerText?.replace(el.value || '', '').trim(); if (t && t.length < 400) return t; } return ''; })).split('\n').filter(Boolean).pop() || '';
      const required = await box.evaluate(el => el.required || el.getAttribute('aria-required') === 'true');
      let answer = /what interests you|why (?:do you want|are you interested)|interest(?:ed)? in (?:working|this)/i.test(label) ? { value: interestNote(profile, job), source: 'Interest note from confirmed profile' } : resolve({ label, type: 'textarea', required }, profile, saved, 'wellfound', job);
      if (!answer?.value) { if (required) questions.push({ label, type: 'textarea', required, origin: 'wellfound', reason: 'No confirmed answer' }); continue; }
      await box.fill(String(answer.value)); usedAnswers.push({ label, value: answer.value, source: answer.source });
    }
    if (questions.length) return { status: 'needs_input', reason: 'Wellfound application needs your answers', questions, usedAnswers, evidence: await api.screenshot(page, job, 'wellfound-questions') };
    if (options.dryRun) return { status: 'ready', reason: 'Wellfound application prepared without sending', usedAnswers, evidence: await api.screenshot(page, job, 'wellfound-ready') };
    const state = store.state(); if (state.settings.paused || !state.settings.autoApply) return { status: 'queued', reason: 'Paused before Wellfound submission' };
    await modal.getByRole('button', { name: /send application/i }).click();
    for (let i = 0; i < 10; i++) {
      await page.waitForTimeout(1500);
      const body = (await page.locator('body').innerText()).replace(/\s+/g, ' ');
      const err = await modal.locator('[class*="error"], [role=alert]').allInnerTexts().catch(() => []);
      if (err.some(e => e.trim())) return { status: 'needs_input', reason: `Wellfound rejected the form: ${err.join(' ').slice(0, 160)}`, questions: [], usedAnswers, evidence: await api.screenshot(page, job, 'wellfound-error') };
      if (/your application has been sent|application (?:sent|submitted)|you applied/i.test(body) || await page.getByRole('button', { name: /^\W*applied$/i }).count()) {
        const confirmation = { at: new Date().toISOString(), source: 'Wellfound', text: (body.match(/your application has been sent|application (?:sent|submitted)[^.]{0,80}|you applied[^.]{0,60}/i) || ['Wellfound shows Applied'])[0] };
        store.mutate(s => Object.assign(s.jobs.find(j => j.id === job.id), { status: 'submitted', submittedAt: confirmation.at, confirmation, usedAnswers }));
        return { status: 'submitted', submittedAt: confirmation.at, confirmation, usedAnswers, evidence: await api.screenshot(page, job, 'wellfound-submitted') };
      }
    }
    return { status: 'submission_uncertain', reason: 'Wellfound application sent without a recognised receipt; check Applied before retrying', usedAnswers, evidence: await api.screenshot(page, job, 'wellfound-uncertain') };
  } finally { if (page && !options.interactive) await page.close().catch(() => {}); }
}
module.exports = { discover, apply, lpa, interestNote };
