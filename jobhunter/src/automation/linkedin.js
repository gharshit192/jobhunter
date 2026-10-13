const store = require('./store');
const { COMPANIES } = require('./companies');
const { resolve } = require('./answers');
const { evaluate } = require('./matching');
const additional = [
  { name: 'InfoBeans', category: 'service', categorySource: 'https://infobeans.com/cloud/' },
  { name: 'Qualys', category: 'product', categorySource: 'https://www.qualys.com/company/' },
  { name: 'Zeta Global', category: 'product', categorySource: 'https://www.zetaglobal.com/' }
];
function companyFor(name) { return [...COMPANIES, ...additional].find(c => c.name.toLowerCase() === name.trim().toLowerCase()); }
// LinkedIn shows India pay as ₹25L/yr or ₹2,500,000/yr; matching reads LPA.
function lpaRange(pay) {
  const values = [...String(pay || '').matchAll(/₹\s?([\d.,]+)\s?([LK]?)/gi)].map(([, n, unit]) => { const v = Number(n.replace(/,/g, '')); return /l/i.test(unit) ? v : /k/i.test(unit) ? v * 1000 / 100000 : v / 100000; }).filter(Number.isFinite);
  return values.length ? `${values.join('-')} LPA` : '';
}
async function posting(page, card) {
  await page.goto(card.applyLink, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(2000);
  return page.evaluate(card => {
    const title = document.querySelector('h1')?.innerText.trim() || card.title;
    const about = [...document.querySelectorAll('h2,h3')].find(el => /^about the job$/i.test(el.innerText.trim()));
    let description = document.querySelector('.jobs-description__content,.jobs-description-content__text,.jobs-description')?.innerText.trim() || '';
    if (description.length < 200 && about) { let parent = about.parentElement; for (let i = 0; parent && i < 5 && parent.tagName !== 'MAIN'; i++, parent = parent.parentElement) { if (parent.innerText.trim().length > 200) { description = parent.innerText.trim(); break; } } }
    const company = document.querySelector('.job-details-jobs-unified-top-card__company-name')?.innerText.trim() || card.company;
    const employmentType = [...document.querySelectorAll('button')].map(el => el.innerText.trim()).find(text => /^(?:full.time|part.time|contract|temporary|internship)$/i.test(text)) || '';
    const pay = [...document.querySelectorAll('main button, main span, main li')].map(el => el.innerText.trim()).find(text => /^₹\s?[\d.,]+\s?[LK]?(?:\/yr)?(?:\s*[-–]\s*₹\s?[\d.,]+\s?[LK]?(?:\/yr)?)?$/i.test(text)) || '';
    return { ...card, title, company, description, employmentType, pay };
  }, card);
}
// Non-Easy-Apply postings link out to the employer's site; follow the Apply button to read the real job URL.
async function externalLink(page) {
  if (await page.getByRole('button', { name: /easy apply/i }).count()) return '';
  const button = page.locator('main').locator('button, a').filter({ hasText: /^\s*apply\s*$/i }).first();
  if (!await button.count()) return '';
  const popup = page.context().waitForEvent('page', { timeout: 8000 }).catch(() => null);
  await button.click().catch(() => {});
  let tab = await popup;
  if (!tab) {
    // LinkedIn sometimes asks to confirm before leaving the site.
    const proceed = page.getByRole('dialog').locator('button, a').filter({ hasText: /continue|apply/i }).first();
    if (await proceed.count()) { const next = page.context().waitForEvent('page', { timeout: 8000 }).catch(() => null); await proceed.click().catch(() => {}); tab = await next; }
  }
  if (!tab) { const url = page.url(); return /(^|\.)linkedin\.com$/.test(new URL(url).hostname) ? '' : url; }
  await tab.waitForLoadState('domcontentloaded', { timeout: 20000 }).catch(() => {});
  await tab.waitForTimeout(2500);
  const url = tab.url(); await tab.close().catch(() => {});
  return /^https:/.test(url) ? url : '';
}
// Map an employer URL to a job we can apply to with an existing connector.
function externalJob(url, detail) {
  const { detectATS } = require('./discovery');
  let connector; try { connector = detectATS(url); } catch { return null; }
  if (!connector) return null;
  const id = connector.id || new URL(url).pathname.split('/').filter(Boolean).pop();
  if (connector.ats === 'greenhouse' && !/^\d+$/.test(String(id))) return null;
  return { ats: connector.ats, applyLink: url, requisitionId: `${connector.ats}:${connector.board}:${id}`, sourceDetail: `LinkedIn posting ${detail.applyLink}` };
}
async function discover(profile, onProgress = store.event) {
  const browser = require('./browser');
  const { persistJobs } = require('./discovery');
  let external = 0, unsupported = 0;
  const jobs = [], seen = new Set(store.state().jobs.map(j => (/^linkedin:(\d+)$/.exec(j.requisitionId || '') || /linkedin\.com\/jobs\/view\/(\d+)/.exec(j.sourceDetail || '') || [])[1]).filter(Boolean)); let page;
  try {
    page = await browser.open('https://www.linkedin.com/jobs/');
    for (const city of [...profile.cities, 'India']) for (const keywords of ['Java Backend', 'Java Developer', 'Spring Boot', 'Backend Engineer Java']) for (const start of [0, 25]) {
      const url = new URL('https://www.linkedin.com/jobs/search/');
      url.searchParams.set('keywords', keywords); if (start) url.searchParams.set('start', String(start)); url.searchParams.set('location', city === 'Gurgaon' ? 'Gurugram, India' : `${city}${city === 'India' ? '' : ', India'}`); 
      if (city === 'India') url.searchParams.set('f_WT', '2');
      await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 30000 }); await page.waitForTimeout(3000);
      if (/authwall|checkpoint|\/login/.test(page.url())) { onProgress('LinkedIn: login or verification required'); persistJobs(jobs, profile); return jobs; }
      const cards = await page.evaluate(known => [...document.querySelectorAll('[data-occludable-job-id],[data-job-id]')].map(el => {
        const id = el.getAttribute('data-occludable-job-id') || el.getAttribute('data-job-id');
        const lines = el.innerText.trim().split('\n').map(s => s.trim()).filter(Boolean);
        const title = el.querySelector('.job-card-list__title,.job-card-container__link')?.innerText.trim().split('\n')[0] || el.innerText.trim().split('\n')[0];
        const company = el.querySelector('.artdeco-entity-lockup__subtitle,.job-card-container__primary-description')?.innerText.trim() || lines.find(line => known.includes(line.toLowerCase())) || lines[1] || '';
        const location = el.querySelector('.artdeco-entity-lockup__caption,.job-card-container__metadata-item')?.innerText.trim() || lines.slice(lines.indexOf(company) + 1).find(line => /india|pune|gurgaon|gurugram|indore|jaipur|vadodara|remote/i.test(line)) || '';
        return { id, title, company, location, applyLink: `https://www.linkedin.com/jobs/view/${id}/` };
      }).filter(j => /^\d+$/.test(j.id)), [...COMPANIES, ...additional].map(c => c.name.toLowerCase()));
      for (const card of cards) {
        if (seen.has(card.id)) continue; seen.add(card.id);
        // Any employer qualifies; the profile's role, location, seniority and pay rules decide eligibility.
        const company = companyFor(card.company) || (card.company.trim() && { name: card.company.trim(), category: 'unlisted', categorySource: '' });
        if (!company || profile.excludedCompanies.some(c => c.toLowerCase() === card.company.toLowerCase())) continue;
        if (!/java|backend|back.end|kotlin|spring|node|software.*engineer|developer/i.test(card.title)) continue;
        try {
          const detail = await posting(page, card);
          if (detail.company.toLowerCase() !== company.name.toLowerCase() || detail.description.length < 200) continue;
          const job = { ...detail, salary: lpaRange(detail.pay), company: company.name, category: company.category, categorySource: company.categorySource, source: 'LinkedIn', ats: 'linkedin', requisitionId: `linkedin:${card.id}`, discoveredAt: new Date().toISOString() };
          const outside = await externalLink(page);
          if (outside) { const ext = externalJob(outside, detail); if (ext) { jobs.push({ ...job, ...ext }); external++; } else unsupported++; continue; }
          jobs.push(job);
        } catch { onProgress(`LinkedIn: could not verify posting ${card.id}`); }
      }
      onProgress(`LinkedIn ${city} / ${keywords}${start ? ' p2' : ''}: ${cards.length} cards checked; ${jobs.length} verified backend postings so far (${external} via employer sites, ${unsupported} on unsupported sites)`);
      if (cards.length < 20) break;
    }
    persistJobs(jobs, profile); return jobs;
  } finally { if (page) await page.close().catch(() => {}); }
}
async function apply(job, profile, saved, options, api) {
  let page, submitted = false; const usedAnswers = [], responses = [];
  try {
    if (!job.description || job.description.length < 200) return { status: 'needs_input', reason: 'Complete LinkedIn job description has not been verified; no application submitted', questions: [] };
    if (new URL(job.applyLink).hostname !== 'www.linkedin.com') throw Error('LinkedIn job URL is not verified');
    page = await api.open(job.applyLink, { interactive: options.interactive });
    page.on('response', r => { const request = r.request(); if (request.method() === 'POST' && /linkedin\.com$/.test(new URL(r.url()).hostname)) responses.push({ url: new URL(r.url()).origin + new URL(r.url()).pathname, method: 'POST', status: r.status(), at: new Date().toISOString() }); });
    await page.waitForTimeout(1800);
    if (/authwall|checkpoint|\/login/.test(page.url())) return { status: 'needs_input', reason: 'LinkedIn login or verification required', requiresLogin: true, questions: [] };
    if (await page.getByRole('button', { name: /^applied$/i }).count()) return { status: 'needs_input', reason: 'LinkedIn already shows Applied; verify the previous application before any retry', questions: [] };
    const applyButton = page.getByRole('button', { name: /easy apply/i });
    if (!await applyButton.count()) return { status: 'needs_input', reason: 'No Easy Apply form is available; use the employer’s original application link', questions: [] };
    await applyButton.first().click();
    const dialog = page.locator('.jobs-easy-apply-modal,dialog[open],[role="dialog"],[aria-modal="true"]').first(); await dialog.waitFor({ state: 'visible', timeout: 10000 });
    let uploaded = false;
    for (let step = 0; step < 10; step++) {
      await page.waitForFunction(selector => { const root = document.querySelector(selector); if (!root) return false; const visible = el => !!(el.offsetWidth || el.offsetHeight); return [...root.querySelectorAll('input,select,textarea,[role=combobox]')].some(visible) || [...root.querySelectorAll('button')].filter(visible).some(el => /^(?:next|review|continue|submit application)/i.test(el.innerText || el.getAttribute('aria-label') || '')); }, '.jobs-easy-apply-modal,dialog[open],[role="dialog"],[aria-modal="true"]', { timeout: 15000 });
      const questions = [], origin = new URL(page.url()).origin;
      const fields = await api.fields(page, '.jobs-easy-apply-modal,dialog[open],[role="dialog"],[aria-modal="true"]');
      for (const field of fields) {
        if (field.type === 'checkbox' && /^follow\b/i.test(field.label)) { await require('./browser').setChoice(page.locator(`[data-jh-field="${field.id}"]`), false); continue; }
        if (field.type === 'file') {
          if (await api.fill(page, field, null, profile)) { uploaded = true; await page.waitForTimeout(1000); }
          else if (field.required) questions.push({ ...field, origin, reason: 'Resume upload requires manual attention' });
          continue;
        }
        // LinkedIn validates salary screening answers as plain numbers even when the box is type=text.
        if (/ctc|salary|compensation/i.test(field.label)) field.numeric = true;
        const answer = resolve(field, profile, saved, origin, job);
        if (answer && await api.fill(page, field, answer, profile)) usedAnswers.push({ label: field.label, value: answer.value, source: answer.source });
        else if (field.required) questions.push({ ...field, origin, reason: 'Needs your confirmed answer' });
      }
      // LinkedIn usually offers resumes already on the account; accept only when the selected one is the current resume.
      if (!uploaded && profile.resumeOriginalName) uploaded = await dialog.evaluate((root, file) => {
        const stem = file.replace(/\.[a-z]+$/i, '').toLowerCase();
        const chosen = [...root.querySelectorAll('input[type="radio"]:checked, [aria-checked="true"], [aria-selected="true"], [class*="--selected"]')];
        return chosen.some(el => { for (let node = el, i = 0; node && i < 5; node = node.parentElement, i++) if ((node.innerText || '').toLowerCase().includes(stem)) return true; return false; });
      }, profile.resumeOriginalName);
      if (questions.length) return { status: 'needs_input', reason: 'Easy Apply needs your answers', questions, usedAnswers, evidence: await api.screenshot(page, job, 'linkedin-review') };
      const submit = dialog.getByRole('button', { name: /^submit application$/i });
      if (await submit.count()) {
        if (!uploaded) return { status: 'needs_input', reason: 'Current resume upload has not been verified in Easy Apply', questions: [], usedAnswers };
        if (options.dryRun) return { status: 'ready', reason: 'Easy Apply prepared without submitting', usedAnswers, evidence: await api.screenshot(page, job, 'linkedin-ready') };
        const state = store.state(), match = evaluate(job, { ...profile, excludedCompanies: [...profile.excludedCompanies, ...state.excludedCompanies] });
        if (!match.eligible) return { status: 'excluded', reason: match.blocked.join('; ') };
        if (state.settings.paused || !state.settings.autoApply) return { status: 'queued', reason: 'Paused before Easy Apply submission' };
        store.mutate(s => Object.assign(s.jobs.find(j => j.id === job.id), { status: 'submitting', lastAttemptAt: new Date().toISOString(), usedAnswers }));
        submitted = true; await submit.click();
        for (let i = 0; i < 15; i++) {
          await page.waitForTimeout(1000); const confirmation = await api.confirmation(page, 'linkedin');
          if (confirmation) { store.mutate(s => Object.assign(s.jobs.find(j => j.id === job.id), { status: 'submitted', submittedAt: confirmation.at, confirmation, usedAnswers })); return { status: 'submitted', submittedAt: confirmation.at, confirmation, usedAnswers, submissionResponses: responses, evidence: await api.screenshot(page, job, 'linkedin-submitted') }; }
        }
        return { status: 'submission_uncertain', reason: 'Easy Apply submitted without a recognised receipt; review before retrying', usedAnswers, submissionResponses: responses };
      }
      const next = dialog.getByRole('button', { name: /^(?:next|review|continue(?: to next step)?)$/i });
      if (!await next.count() || !await next.first().isEnabled()) return { status: 'needs_input', reason: 'Easy Apply needs manual attention at an unsupported step', questions: [], usedAnswers, evidence: await api.screenshot(page, job, 'linkedin-step') };
      const beforeStep = await dialog.innerText();
      await next.first().click();
      const changed = await page.waitForFunction(({ selector, before }) => { const root = document.querySelector(selector); if (!root || root.innerText === before) return false; return [...root.querySelectorAll('input,select,textarea,button')].some(el => !!(el.offsetWidth || el.offsetHeight)); }, { selector: '.jobs-easy-apply-modal,dialog[open],[role="dialog"],[aria-modal="true"]', before: beforeStep }, { timeout: 15000 }).then(() => true).catch(() => false);
      if (!changed) {
        const layout = await dialog.evaluate(root => ({ fields: [...root.querySelectorAll('input,select,textarea,[role=combobox]')].map(el => ({ label: [...(el.labels || [])].map(l => l.innerText).join(' ') || el.getAttribute('aria-label') || el.placeholder || '', type: el.type || el.getAttribute('role'), required: el.required, invalid: el.getAttribute('aria-invalid') === 'true' || (el.checkValidity && !el.checkValidity()) })), buttons: [...root.querySelectorAll('button')].map(el => ({ text: el.innerText.trim(), label: el.getAttribute('aria-label'), disabled: el.disabled })) }));
        store.write('linkedin-stalled-step', { jobId: job.id, ...layout });
        return { status: 'needs_input', reason: 'Easy Apply did not advance after Next; required-field validation needs review', questions: [], usedAnswers, evidence: await api.screenshot(page, job, 'linkedin-stalled') };
      }
      await page.waitForTimeout(800);
      const errors = await dialog.locator('[role="alert"],.artdeco-inline-feedback--error').allTextContents();
      if (errors.some(text => text.trim())) return { status: 'needs_input', reason: 'Easy Apply rejected a required field', questions: [], usedAnswers, evidence: await api.screenshot(page, job, 'linkedin-validation') };
    }
    return { status: 'needs_input', reason: 'Easy Apply exceeds the supported step limit', questions: [], usedAnswers, evidence: await api.screenshot(page, job, 'linkedin-step-limit') };
  } catch (error) {
    if (page && !submitted) {
      const layout = await page.evaluate(() => ({ url: location.origin + location.pathname, dialogCount: document.querySelectorAll('[role="dialog"]').length, inputs: [...document.querySelectorAll('input')].map(el => ({ type: el.type, placeholder: el.placeholder, label: el.getAttribute('aria-label'), required: el.required })).slice(0,25), buttons: [...document.querySelectorAll('button')].filter(el => !!(el.offsetWidth || el.offsetHeight)).map(el => (el.innerText || el.getAttribute('aria-label') || '').trim()).slice(0,25) })).catch(() => ({}));
      store.write('linkedin-form-layout', { jobId: job.id, ...layout });
    }
    return { status: submitted ? 'submission_uncertain' : 'needs_input', reason: error.message.split('\n')[0], questions: [], usedAnswers, submissionResponses: responses, evidence: page ? await api.screenshot(page, job, 'linkedin-error') : null }; }
  finally { if (page && !options.interactive) await page.close().catch(() => {}); }
}
module.exports = { discover, apply, companyFor, lpaRange, externalJob };
