const path = require('node:path');
const fs = require('node:fs');
const { chromium } = require('playwright');
const store = require('./store');
const { resolve, normalize } = require('./answers');
const { detectATS, safeUrl } = require('./discovery');
let context;
let contextHeadless;
async function browser({ interactive = false } = {}) {
  // Normal application runs are always headless. Only an explicit dashboard action opens a window.
  const headless = !interactive;
  if (context && contextHeadless !== headless) await context.close();
  if (!context) {
    context = await chromium.launchPersistentContext(path.join(store.ROOT, 'browser'), {
      channel: process.env.AUTOMATION_BROWSER_CHANNEL || 'chrome', headless,
      viewport: { width: 1280, height: 900 }, acceptDownloads: false,
    });
    context.on('close', () => { context = null; });
    contextHeadless = headless;
  }
  return context;
}
async function open(url, options = {}) {
  safeUrl(url);
  const page = await (await browser(options)).newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  return page;
}
async function fields(page, rootSelector = '') {
  return page.evaluate(rootSelector => {
    const root = rootSelector ? document.querySelector(rootSelector) : document;
    if (!root) return [];
    function visible(el) { return !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length) && getComputedStyle(el).visibility !== 'hidden'; }
    const result = [];
    const radioGroups = new Set(), checkboxGroups = new Set();
    const radioKey = el => el.name || el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') || el.closest('fieldset,[role=radiogroup]')?.id || el.id;
    for (const el of root.querySelectorAll('input, textarea, select, [role="combobox"]')) {
      if ((!visible(el) && el.type !== 'file') || el.disabled || el.type === 'hidden' || ['submit', 'button', 'reset'].includes(el.type)) continue;
      if (el.type !== 'file' && (el.getAttribute('aria-hidden') === 'true' || el.getAttribute('tabindex') === '-1')) continue;
      if (el.matches('[role="combobox"]') && el.tagName !== 'INPUT' && el.querySelector('input[role="combobox"]')) continue;
      if (el.type === 'radio' && radioGroups.has(radioKey(el))) continue;
      if (el.type === 'radio') radioGroups.add(radioKey(el));
      const checkboxGroup = el.type === 'checkbox' && /\[\]$/.test(el.name || '');
      if (checkboxGroup && checkboxGroups.has(el.name)) continue;
      if (checkboxGroup) checkboxGroups.add(el.name);
      const wrapper = el.closest('.field, .application-question, .application-field, .form-group, fieldset, [class*="Question"], [class*="question"], .select, .select__container');
      const label = (checkboxGroup && el.getAttribute('description') ? el.getAttribute('description') : el.type === 'file' && /resume/i.test(el.id || el.name || '') ? 'Resume/CV' : el.type === 'file' && /cover_letter/i.test(el.id || el.name || '') ? 'Cover letter' : el.getAttribute('aria-label') || [...(el.labels || [])].map(l => l.innerText).join(' ') || (el.getAttribute('aria-labelledby') || '').split(' ').map(id => document.getElementById(id)?.innerText || '').join(' ') || wrapper?.querySelector('legend, label')?.innerText || el.getAttribute('placeholder') || el.name || el.id || '').trim();
      const id = String(result.length);
      el.setAttribute('data-jh-field', id);
      const required = el.required || el.getAttribute('aria-required') === 'true' || /\*/.test(label) || (!/optional/i.test(label) && /authorized|eligible|able.*work|sponsorship|citizen|privacy|consent|certify|declar|background/.test(label.toLowerCase()));
      let options = el.tagName === 'SELECT' ? [...el.options].map(o => ({ label: o.textContent.trim(), value: o.value, disabled: o.disabled })) : [];
      const questionLabel = label;
      if (el.type === 'radio') options = [...root.querySelectorAll('input[type="radio"]')].filter(r => radioKey(r) === radioKey(el)).map((r, index) => {
        let label = [...(r.labels || [])].map(l => l.innerText).join(' ').trim();
        if (label === questionLabel) label = '';
        if (!label) { let parent = r.parentElement; for (let i = 0; parent && i < 5; i++, parent = parent.parentElement) { const text = parent.innerText.trim(); if (parent.querySelectorAll('input[type="radio"]').length === 1 && text.length <= 80 && text && text !== questionLabel) { label = text; break; } } }
        if (!label) label = r.getAttribute('aria-label') || '';
        r.setAttribute('data-jh-radio-option', `${id}-${index}`);
        return { value: r.value, label, elementKey: `${id}-${index}` };
      });
      if (checkboxGroup) options = [...document.querySelectorAll('input[type="checkbox"]')].filter(r => r.name === el.name).map(r => ({ value: r.value, label: [...(r.labels || [])].map(l => l.innerText).join(' ').trim() }));
      result.push({ id, label, radioGroup: el.type === 'radio' ? radioKey(el) : undefined, type: checkboxGroup ? 'checkbox-group' : el.getAttribute('role') === 'combobox' ? 'combobox' : el.type || el.tagName.toLowerCase(), required, options, accept: el.accept || '', value: el.value || '', numeric: /numeric/i.test(el.id || '') || el.inputMode === 'numeric' || el.inputMode === 'decimal' });
    }
    return result;
  }, rootSelector);
}
function optionMatch(options, value) {
  const n = normalize(value);
  let found = options.find(o => !o.disabled && (normalize(o.label) === n || normalize(o.value) === n));
  if (!found && n === 'prefer not to disclose') found = options.find(o => /prefer not|decline|do not wish|don.t wish|rather not/i.test(o.label));
  if (!found && n === 'yes') found = options.find(o => /^yes\b/i.test(o.label)) || options.find(o => /^(?:i )?(?:consent|agree|accept)\b/i.test(o.label));
  if (!found && n === 'no') found = options.find(o => /^no\b/i.test(o.label)) || options.find(o => /^(?:i )?(?:do not|don.t) (?:consent|agree|accept)|^(?:i )?decline\b/i.test(o.label));
  if (!found && /^(?:1 month|30(?: days)?)$/.test(n)) found = options.find(o => /\b30\b|\b1 month|one month/i.test(o.label));
  // Numeric answers against range options: "5-7 years", "5 to 8", "6+", "more than 5".
  if (!found && /^\d+(?:\.\d+)?$/.test(n)) {
    const v = Number(n);
    found = options.find(o => { const m = String(o.label).match(/(\d+(?:\.\d+)?)\s*(?:-|–|to)\s*(\d+(?:\.\d+)?)/); return m && v >= Number(m[1]) && v <= Number(m[2]); })
      || options.find(o => { const m = String(o.label).match(/(\d+(?:\.\d+)?)\s*\+|(?:more than|above|over|greater than)\s*(\d+(?:\.\d+)?)/i); return m && v >= Number(m[1] || m[2]); })
      || options.find(o => new RegExp(`^${v}\\b`).test(String(o.label).trim()));
  }
  return found;
}
// LinkedIn and Workday visually hide radio/checkbox inputs behind their labels, so a normal check() waits on an element that never becomes clickable.
async function setChoice(locator, checked = true) {
  try { await locator.setChecked(checked, { timeout: 3000 }); return; } catch {}
  // React may remount the input after the label click; check the original node, not the selector.
  const handle = await locator.elementHandle({ timeout: 3000 });
  const state = await handle.evaluate((el, checked) => { if (el.checked === checked) return true; const label = el.labels?.[0] || el.closest('label'); if (label) label.click(); else el.click(); return el.isConnected ? el.checked === checked : null; }, checked);
  if (state === false) await handle.evaluate((el, checked) => { if (el.checked !== checked) el.click(); }, checked);
  if (state === false && await handle.evaluate((el, checked) => el.isConnected && el.checked !== checked, checked)) throw new Error('Could not set a hidden radio/checkbox choice');
}
async function fill(page, field, answer, profile) {
  const el = page.locator(`[data-jh-field="${field.id}"]`);
  if (field.type === 'file') {
    if (!/resume|cv|curriculum/i.test(field.label)) return false;
    if (field.accept && !/docx|officedocument|application\/msword|\.doc\b|\*/i.test(field.accept)) return false;
    const resumePath = path.join(store.ROOT, profile.resumeFile);
    if (!fs.existsSync(resumePath)) throw new Error('Saved resume file is missing');
    await el.setInputFiles(resumePath); return true;
  }
  if (!answer) return false;
  if (field.type === 'checkbox-group') {
    const labels = answer.value.split(';').map(s => s.trim()).filter(Boolean);
    const picked = labels.map(label => optionMatch(field.options, label));
    if (picked.some(o => !o)) return false;
    const name = await el.getAttribute('name');
    const boxes = page.locator('input[type="checkbox"]');
    for (let i = 0; i < await boxes.count(); i++) {
      const box = boxes.nth(i);
      if (await box.getAttribute('name') === name) { const value = await box.getAttribute('value'); await setChoice(box, picked.some(o => o.value === value)); }
    }
    return true;
  }
  if (field.type === 'checkbox') {
    if (!['yes', 'no', 'true', 'false'].includes(normalize(answer.value))) return false;
    await setChoice(el, ['yes', 'true'].includes(normalize(answer.value))); return true;
  }
  if (field.type === 'radio') {
    const opt = optionMatch(field.options, answer.value);
    if (!opt) return false;
    if (opt.elementKey) { await setChoice(page.locator(`[data-jh-radio-option="${opt.elementKey}"]`)); return true; }
    const name = await el.getAttribute('name');
    const radios = page.locator('input[type="radio"]');
    for (let i = 0; i < await radios.count(); i++) {
      const r = radios.nth(i);
      const group = await r.getAttribute('name') || await r.getAttribute('aria-label') || await r.getAttribute('aria-labelledby') || await r.evaluate(e => e.closest('fieldset,[role=radiogroup]')?.id || e.id);
      if (group === (field.radioGroup || name) && await r.getAttribute('value') === opt.value) { await setChoice(r); return true; }
    }
    return false;
  }
  if (field.type === 'select-one' || field.type === 'select-multiple') {
    const opt = optionMatch(field.options, answer.value);
    if (!opt) return false;
    await el.selectOption(opt.value); return true;
  }
  if (field.type === 'combobox' || await el.getAttribute('role') === 'combobox') {
    await el.click();
    if (await el.evaluate(e => e.tagName === 'INPUT')) await el.fill(answer.value);
    const options = page.getByRole('option');
    await options.first().waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
    const choices = [];
    for (let i = 0; i < await options.count(); i++) choices.push({ label: await options.nth(i).innerText(), value: String(i) });
    let opt = optionMatch(choices, answer.value);
    if (!opt && /location|city/.test(normalize(field.label))) opt = choices.find(o => /gurgaon|gurugram/i.test(o.label) && /haryana/i.test(o.label) && /india/i.test(o.label));
    if (!opt && normalize(field.label) === 'country') opt = choices.find(o => /^india\b/i.test(o.label));
    if (!opt && normalize(field.label) === 'degree') opt = choices.find(o => /bachelor|b\.tech|btech/i.test(o.label));
    if (!opt && /^(?:school|institution|college|university)$/.test(normalize(field.label))) opt = choices.find(o => /^other\b/i.test(o.label));
    if (!opt) { await page.keyboard.press('Escape'); return false; }
    await options.nth(Number(opt.value)).click(); return true;
  }
  if ((field.type === 'number' || field.numeric) && !/^\d+(\.\d+)?$/.test(answer.value)) return false;
  await el.fill(answer.value);
  return true;
}
async function screenshot(page, job, suffix) {
  const dir = path.join(store.ROOT, 'evidence'); fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const name = `${job.id}-${Date.now()}-${suffix}.png`;
  try { await page.screenshot({ path: path.join(dir, name), fullPage: true, timeout: 5000, animations: 'disabled', mask: [page.locator('input[id^="security-input"], input[autocomplete="one-time-code"], input[type="password"]')] }); return name; }
  catch (error) { store.event(`Screenshot unavailable for ${job.company}: ${error.message.split('\n')[0]}`); return null; }
}
async function confirmation(page, ats) {
  const text = ats === 'linkedin' ? (await page.locator('dialog[open],.jobs-easy-apply-modal,[role="dialog"],[role="alert"],.artdeco-toast-item,[role="status"]').allTextContents()).join('\n') : await page.locator('body').innerText();
  const phrases = {
    greenhouse: /thank you for taking the time to apply|thank you for applying|application (?:has been |was )?(?:successfully )?(?:submitted|received)|thanks for applying/i,
    lever: /thank you for applying|application (?:has been |was )?(?:successfully )?(?:submitted|received)|we have received your application/i,
    linkedin: /your application (?:was|has been) sent|application sent/i,
    workday: /your application (?:has |was )?(?:been )?(?:successfully )?(?:been )?(?:submitted|received)|thank you for (?:applying|your application)/i,
    smartrecruiters: /thank you for (?:your application|applying)|application (?:has been |was )?(?:successfully )?(?:submitted|received)|you have successfully applied/i,
  };
  const match = text.match(phrases[ats] || /a^/);
  return match ? { text: match[0], url: page.url(), at: new Date().toISOString() } : null;
}
async function apply(job, profile, saved, { dryRun = false, interactive = false, verificationCode } = {}) {
  let connector = detectATS(job.applyLink);
  let formLink = job.applyLink;
  if (job.ats === 'greenhouse' && /^greenhouse:[a-z0-9_-]+:\d+$/i.test(job.requisitionId || '')) {
    const [, board, id] = job.requisitionId.split(':');
    connector = { ats: 'greenhouse', board, id };
    // The posting was fetched from this employer's board; use its hosted form when the official page embeds it.
    if (!detectATS(job.applyLink)) formLink = `https://boards.greenhouse.io/embed/job_app?for=${encodeURIComponent(board)}&token=${id}`;
  }
  if (job.ats === 'linkedin' && new URL(job.applyLink).hostname === 'www.linkedin.com') return require('./linkedin').apply(job, profile, saved, { dryRun, interactive }, { open, fields, fill, screenshot, confirmation });
  if (connector?.ats === 'workday') return require('./workday').apply(job, profile, saved, { dryRun, interactive }, { open, fields, fill, screenshot, confirmation });
  if (!connector || !['greenhouse', 'lever', 'smartrecruiters'].includes(connector.ats)) return { status: 'needs_input', reason: 'This portal needs a dedicated application connector. Open the official job and complete it manually.', questions: [] };
  let page = await open(formLink, { interactive });
  let clickedSubmit = false;
  const submissionResponses = [];
  page.on('response', response => {
    try {
      const request = response.request(), u = new URL(response.url());
      if (['POST', 'PUT'].includes(request.method()) && !/analytics|tracking|sentry|telemetry|recaptcha|google-analytics/.test(u.hostname + u.pathname)) submissionResponses.push({ url: u.origin + u.pathname, method: request.method(), status: response.status(), at: new Date().toISOString() });
    } catch {}
  });
  try {
    await page.waitForTimeout(2500);
    if (connector.ats === 'smartrecruiters') {
      const start = page.getByRole('link', { name: /^(?:I'm interested|I’m interested|Apply now)$/i }).or(page.getByRole('button', { name: /^(?:I'm interested|I’m interested|Apply now)$/i }));
      if (await start.count()) {
        const popup = page.waitForEvent('popup', { timeout: 5000 }).catch(() => null);
        await start.first().click();
        const child = await popup;
        if (child) page = child;
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(1500);
      }
      await page.waitForSelector('input[type="email"], input[aria-label="Email"], input[name="firstName"], input[id="first_name"]', { timeout: 10000 }).catch(() => {});
    }
    if (connector.ats === 'greenhouse') {
      const initial = page.getByRole('button', { name: /^apply(?: for this job| now)?$/i });
      if (await initial.count() && await initial.first().isVisible()) { await initial.first().click(); await page.waitForTimeout(800); }
    }
    const body = await page.locator('body').innerText();
    if (await page.locator('script[src*="captcha-delivery.com"], iframe[src*="captcha-delivery.com"], iframe[src*="challenges.cloudflare.com"]').count() || /verify you are human|checking your browser|access denied/i.test(body)) {
      return { status: 'needs_input', reason: 'Application portal requires manual browser verification; not applied.', requiresVerification: true, questions: [], evidence: await screenshot(page, job, 'verification') };
    }
    if (/job (?:is |has been )?(?:no longer available|closed)|position has been filled|posting is no longer/i.test(body)) return { status: 'excluded', reason: 'Job is no longer open' };
    const challenges = page.locator('iframe[src*="hcaptcha"], iframe[src*="recaptcha"], iframe[src*="challenges.cloudflare"]');
    const origin = new URL(page.url()).origin;
    const questions = [], usedAnswers = [];
    let resumeUploaded = false;
    // Re-read after changes so conditional fields are not missed.
    for (let round = 0; round < 2; round++) {
      questions.length = 0;
      const current = await fields(page);
      if (!current.length) {
        fs.writeFileSync(path.join(store.ROOT, 'latest-form.html'), await page.content(), { mode: 0o600 });
        return { status: 'needs_input', reason: 'No supported application form detected', questions: [], evidence: await screenshot(page, job, 'no-form') };
      }
      for (const field of current) {
        if (field.type === 'file') {
          if (/resume|cv/i.test(field.label) && resumeUploaded) continue;
          if (await fill(page, field, null, profile)) {
            resumeUploaded = true;
            await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
            await page.waitForTimeout(2000);
            continue;
          }
          if (field.required) questions.push({ ...field, origin, reason: 'Upload requires a different file or resume format' });
          continue;
        }
        const answer = resolve(field, profile, saved, origin, job);
        if (answer && await fill(page, field, answer, profile)) { usedAnswers.push({ label: field.label, value: answer.value, source: answer.source }); continue; }
        // An unknown field is mandatory unless clearly marked optional or a known optional demographic field.
        const optional = !field.required || /optional/i.test(field.label);
        if (!optional && !/^(search|filter)/i.test(field.label)) questions.push({ ...field, origin, reason: answer ? 'Answer does not match the available choices or required units' : 'Needs your answer' });
      }
      await page.waitForTimeout(300);
    }
    if (!resumeUploaded) questions.push({ label: 'Resume upload', origin, type: 'file', reason: 'Resume upload could not be verified' });
    if (questions.length) {
      fs.writeFileSync(path.join(store.ROOT, 'latest-form.html'), await page.content(), { mode: 0o600 });
      return { status: 'needs_input', reason: 'Application needs your answers', questions: questions.filter((q, i, all) => all.findIndex(x => x.label === q.label && x.type === q.type) === i), usedAnswers, evidence: await screenshot(page, job, 'review') };
    }
    if (dryRun) return { status: 'ready', reason: 'Form filled; dry run did not submit', usedAnswers, evidence: await screenshot(page, job, 'dry-run') };
    const currentState = store.state();
    const freshMatch = require('./matching').evaluate(job, { ...profile, excludedCompanies: [...profile.excludedCompanies, ...currentState.excludedCompanies] });
    if (!freshMatch.eligible) return { status: 'excluded', reason: freshMatch.blocked.join('; '), match: freshMatch };
    if (currentState.settings.paused || !currentState.settings.autoApply) return { status: 'queued', reason: 'Paused before submission' };
    // Native form validation must pass before any submission.
    const valid = await page.evaluate(() => [...document.forms].every(f => f.noValidate || [...f.elements].every(el => {
      if (typeof el.checkValidity !== 'function' || el.checkValidity()) return true;
      // Greenhouse marks every option required; the question requires one selected option, not all languages.
      if (el.type === 'checkbox' && /\[\]$/.test(el.name || '')) return [...f.elements].some(other => other.type === 'checkbox' && other.name === el.name && other.checked);
      return false;
    })));
    if (!valid) return { status: 'needs_input', reason: 'Form validation requires your attention', questions: [], evidence: await screenshot(page, job, 'validation') };
    const before = await confirmation(page, connector.ats);
    if (before) return { status: 'submission_uncertain', reason: 'Page already shows a confirmation; verify previous submission before retrying' };
    const submit = page.getByRole('button', { name: /^(submit application|submit|send application|apply for this job)$/i });
    if (!await submit.count() || !await submit.first().isVisible() || !await submit.first().isEnabled()) return { status: 'needs_input', reason: 'No supported final Submit button found', questions: [], evidence: await screenshot(page, job, 'submit-button') };
    store.mutate(s => { const current = s.jobs.find(j => j.id === job.id); current.status = 'submitting'; current.usedAnswers = usedAnswers; current.lastAttemptAt = new Date().toISOString(); });
    clickedSubmit = true;
    await submit.first().click({ timeout: 15000 });
    let confirmed, usedCode = false, usedCodeValue;
    const submittedAfter = Date.now();
    for (let i = 0; i < 15; i++) {
      await page.waitForTimeout(1000);
      confirmed = await confirmation(page, connector.ats); if (confirmed) break;
      const codeInputs = page.locator('input[id^="security-input-"]');
      if (!usedCode && await codeInputs.count() === 8) {
        const code = verificationCode || await require('./email').waitForCode(job.company, submittedAfter, profile.email);
        if (!code) {
          return { status: 'needs_input', reason: 'Email security code required. Connect Gmail in the local dashboard or enter the one-time code for this application.', requiresEmailCode: true, questions: [], submissionResponses, evidence: await screenshot(page, job, 'email-verification') };
        }
        if (!/^[A-Za-z0-9]{8}$/.test(code)) throw new Error('The email security code must be 8 characters');
        for (let k = 0; k < 8; k++) await codeInputs.nth(k).fill(code[k]);
        usedCode = true; usedCodeValue = code;
        await submit.first().click();
        // The receipt check continues; do not persist the code as an answer.
      }
    }
    if (confirmed) {
      // Save the actual receipt before optional screenshot work; evidence errors must not lose a confirmed submission.
      store.mutate(s => Object.assign(s.jobs.find(j => j.id === job.id), { status: 'submitted', confirmation: confirmed, submittedAt: confirmed.at, usedAnswers }));
      return { status: 'submitted', confirmation: confirmed, submittedAt: confirmed.at, usedAnswers, submissionResponses, evidence: await screenshot(page, job, 'submitted') };
    }
    const challengeVisible = await challenges.count() > 0;
    const text = await page.locator('body').innerText({ timeout: 5000 }).catch(() => 'Page text unavailable');
    const errors = await page.locator('[role="alert"], [class*="error"], [aria-live="assertive"]').allTextContents().catch(() => []);
    const captchaRejected = /(?:captcha|recaptcha).*(?:fail|invalid|verify|required)|(?:fail|invalid).*captcha/i.test([...errors, text].join(' '));
    const redact = value => usedCodeValue ? String(value).replaceAll(usedCodeValue, '[redacted]') : verificationCode ? String(value).replaceAll(verificationCode, '[redacted]') : String(value);
    const invalid = errors.filter(e => e.trim()).map(redact);
    const rejected = submissionResponses.find(r => r.method === 'POST' && /greenhouse\.io|lever\.co|smartrecruiters\.com/.test(new URL(r.url).hostname) && r.status >= 400);
    const status = captchaRejected || invalid.length || rejected ? 'needs_input' : 'submission_uncertain';
    const reason = rejected ? `Application site rejected submission (HTTP ${rejected.status}). Manual verification is needed; not applied.` : captchaRejected ? 'CAPTCHA verification required; application is not confirmed submitted' : invalid.length ? `Form rejected: ${invalid.join('; ').slice(0, 500)}` : challengeVisible ? 'Submission attempted; verification or confirmation needs review' : 'Submission attempted without a success confirmation; verify before retrying';
    fs.writeFileSync(path.join(store.ROOT, 'evidence', `${job.id}-submission.json`), JSON.stringify({ at: new Date().toISOString(), url: page.url(), submissionResponses, errors: invalid, pageText: redact(text) }, null, 2), { mode: 0o600 });
    if (!usedCode) fs.writeFileSync(path.join(store.ROOT, 'evidence', `${job.id}-submission.html`), await page.content(), { mode: 0o600 });
    return { status, reason, requiresVerification: captchaRejected || rejected?.status === 428, usedAnswers, submissionResponses, validationErrors: invalid, evidence: await screenshot(page, job, 'uncertain') };
  } catch (error) {
    return { status: clickedSubmit ? 'submission_uncertain' : 'needs_input', reason: error.message, submissionResponses, questions: [] };
  } finally {
    // Keep memory/CPU use bounded and leave the user's regular browser untouched.
    if (!interactive) await page.close().catch(() => {});
  }
}
async function close() { const previous = context; context = null; if (previous) await previous.close(); }
module.exports = { apply, open, fields, fill, setChoice, optionMatch, confirmation, close, isBackground: () => !!context && contextHeadless === true };
