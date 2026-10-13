const store = require('./store');
const { resolve, normalize } = require('./answers');
const { evaluate } = require('./matching');
const WD = id => `[data-automation-id="${id}"]`;
async function visibleButton(page, names) {
  const buttons = page.getByRole('button', { name: names }).or(page.getByRole('link', { name: names }));
  for (let i = 0; i < await buttons.count(); i++) if (await buttons.nth(i).isVisible() && await buttons.nth(i).isEnabled()) return buttons.nth(i);
  return null;
}
async function visible(page, selector) { const el = page.locator(selector); for (let i = 0; i < await el.count(); i++) if (await el.nth(i).isVisible()) return el.nth(i); return null; }
// Workday lays a transparent click_filter div over its own submit buttons; the overlay is the real click target.
async function press(page, id, label) {
  const filter = await visible(page, `${WD('click_filter')}[aria-label="${label}"]`);
  if (filter) return filter.click();
  const button = await visible(page, WD(id));
  if (!button) throw Error(`Workday control ${id} is not visible`);
  return button.click({ force: true });
}
// Workday is a single-page app: the header renders long before the posting, modal or step content.
async function settle(page, timeout = 30000) {
  await page.waitForFunction(() => {
    const seen = s => [...document.querySelectorAll(s)].some(el => el.offsetWidth || el.offsetHeight);
    if (seen('[data-automation-id*="skeleton"]:not([data-automation-id="sidebar-skeleton"])')) return false;
    return seen('[data-automation-id="adventureButton"],[data-automation-id="applyManually"],[data-automation-id="signInContent"],[data-automation-id="pageFooterNextButton"],[data-automation-id="errorMessage"],[data-automation-id="formField-email"],input[type="password"]') ||
      /job (?:is no longer|not available)|verify you are human|access denied|application (?:has been |was )?submitted|thank you for applying|already applied/i.test(document.body.innerText);
  }, null, { timeout }).catch(() => {});
  await page.waitForTimeout(600);
}
async function activeStep(page) { return (await page.locator(WD('progressBarActiveStep')).first().innerText({ timeout: 2000 }).catch(() => '')).replace(/\s+/g, ' ').trim(); }
// Sign in, or create the candidate account when the profile authorizes it. Credentials stay in .env, never in state.
async function signIn(page, profile, job, api) {
  const email = process.env.WORKDAY_EMAIL || profile.email, primary = process.env.WORKDAY_PASSWORD, long = process.env.WORKDAY_PASSWORD_LONG;
  let password = primary;
  const host = new URL(page.url()).hostname;
  if (!primary) return { status: 'needs_input', reason: `${job.company} Workday needs a candidate account. Set WORKDAY_PASSWORD in .env (used for sign-in and, if authorized, account creation), or sign in once from the dashboard and requeue.`, requiresLogin: true, loginHost: host, questions: [], evidence: await api.screenshot(page, job, 'workday-login') };
  const errorText = async () => (await page.locator(`${WD('errorMessage')},[role="alert"]`).allTextContents().catch(() => [])).join(' ').trim();
  // Workday ignores programmatic values; it only submits when it sees real keystrokes.
  const type = async (id, value) => { const input = page.locator(WD(id)).first(); await input.click(); await input.fill(''); await input.pressSequentially(value, { delay: 20 }); await input.blur(); };
  const fillCredentials = async verify => {
    await type('email', email); await type('password', password);
    if (verify) await type('verifyPassword', password);
  };
  const signedIn = async () => { await settle(page, 20000); return !await visible(page, WD('signInContent')) && !await visible(page, 'input[type="password"]'); };
  // Cookie banners can cover the form; declining strictly-optional cookies is always safe.
  const cookies = page.getByRole('button', { name: /^decline$/i }).first();
  if (await cookies.isVisible().catch(() => false)) await cookies.click().catch(() => {});
  // Some tenants (Equifax) offer Google/LinkedIn/email first.
  const viaEmail = page.getByRole('button', { name: /^sign in with email$/i }).first();
  if (await viaEmail.isVisible({ timeout: 5000 }).catch(() => false)) await viaEmail.click().catch(() => {});
  // Some tenants (Barclays) take 20s+ to render the sign-in widget after Apply Manually.
  await page.waitForSelector([WD('email'), WD('signInLink'), WD('signInSubmitButton')].join(','), { timeout: 40000 }).catch(() => {});
  const signInLink = await visible(page, WD('signInLink'));
  if (signInLink) { await signInLink.click(); await page.locator(WD('signInSubmitButton')).first().waitFor({ state: 'attached', timeout: 10000 }).catch(() => {}); }
  if (await page.locator(WD('signInSubmitButton')).count()) {
    await fillCredentials(false); await press(page, 'signInSubmitButton', 'Sign In');
    if (await signedIn()) return null;
    // Accounts on tenants that require 12+ characters were created with the long password.
    if (long && long !== primary && await visible(page, WD('signInSubmitButton'))) {
      password = long; await fillCredentials(false); await press(page, 'signInSubmitButton', 'Sign In');
      if (await signedIn()) return null;
    }
  }
  const signInError = await errorText();
  if (!profile.authorized?.createCandidateAccounts) return { status: 'needs_input', reason: `Workday sign-in failed for ${job.company}: ${signInError || 'no session'}. Account creation is not authorized in the profile.`, requiresLogin: true, loginHost: host, questions: [] };
  const createLink = await visible(page, WD('createAccountLink'));
  if (createLink) { await createLink.click(); await page.waitForTimeout(800); }
  if (!await visible(page, WD('verifyPassword'))) return { status: 'needs_input', reason: `Workday sign-in failed for ${job.company}: ${signInError || 'unrecognised sign-in page'}`, requiresLogin: true, loginHost: host, questions: [], evidence: await api.screenshot(page, job, 'workday-signin-failed') };
  const minimum = Number((/minimum of (\d+) characters/i.exec(await page.locator('body').innerText()) || [])[1] || 0);
  password = primary.length >= minimum ? primary : long;
  if (!password || password.length < minimum) return { status: 'needs_input', reason: `${job.company} Workday requires a password of at least ${minimum} characters. Add WORKDAY_PASSWORD_LONG (${minimum}+ characters) to .env.`, requiresLogin: true, loginHost: host, questions: [] };
  await fillCredentials(true);
  const terms = page.locator(`${WD('createAccountCheckbox')} input, input${WD('createAccountCheckbox')}`).first();
  if (await terms.count() && !await terms.isChecked()) await terms.click({ force: true });
  await press(page, 'createAccountSubmitButton', 'Create Account');
  if (await signedIn()) { store.event(`Workday: created candidate account on ${host}`); return null; }
  const body = await page.locator('body').innerText();
  const verifyEmail = /verify (?:your )?(?:email|account)|verification email|check your email/i.test(body) || /\/login(?:\?|$)/.test(page.url());
  return { status: 'needs_input', reason: verifyEmail ? `Workday account for ${job.company} created; click the verification link sent to ${email}, then requeue.` : `Workday account creation for ${job.company} did not complete: ${await errorText() || 'no session after submit'}`, requiresLogin: true, loginHost: host, questions: [], evidence: await api.screenshot(page, job, 'workday-account') };
}
// Workday's own widgets: listbox buttons, prompt (search) inputs, radio fieldsets, checkboxes, text and file inputs.
async function wdFields(page) {
  return page.evaluate(() => {
    window.__jhPrevLabel = '';
    const shown = el => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    return [...document.querySelectorAll('[data-automation-id^="formField-"]')].filter(shown).map((f, index) => {
      f.setAttribute('data-jh-wd', String(index));
      const legend = f.closest('fieldset')?.querySelector('legend');
      const rawLabel = (f.querySelector('label,legend')?.innerText || (legend && !legend.closest('[data-automation-id^="formField-"]:not([data-jh-wd="' + index + '"])') ? legend.innerText : '') || f.getAttribute('aria-label') || f.dataset.automationId.replace(/^formField-/, '')).trim();
      const listbox = f.querySelector('button[aria-haspopup="listbox"]');
      const prompt = f.querySelector('[data-automation-id="multiselectInputContainer"], input[data-uxi-widget-type="selectinput"]');
      const boxes = [...f.querySelectorAll('input[type="checkbox"]')];
      // A Yes/No grid of checkboxes is a single choice question.
      const radios = boxes.length > 1 ? boxes : [...f.querySelectorAll('input[type="radio"]')];
      const checkbox = boxes.length === 1 && boxes[0];
      const date = f.querySelector('[data-automation-id^="dateSection"]');
      const input = f.querySelector('textarea, input:not([type="hidden"]):not([type="radio"]):not([type="checkbox"])');
      const required = /\*\s*$/.test(rawLabel) || [...f.querySelectorAll('[aria-required="true"]')].length > 0;
      let label = rawLabel.replace(/\*\s*$/, '').trim();
      // "Please select one of the following options" only makes sense with the question text just above it.
      if (/^(?:please )?select (?:one|an option)|^(?:please )?choose one/i.test(label) && window.__jhPrevLabel) label = `${window.__jhPrevLabel} ${label}`;
      window.__jhPrevLabel = label;
      const base = { id: String(index), automationId: f.dataset.automationId, label, required };
      if (f.querySelector('input[type="file"]')) return { ...base, type: 'file', filled: false };
      if (date) return { ...base, type: 'date', filled: [...f.querySelectorAll('input')].every(i => i.value) };
      if (listbox) return { ...base, type: 'listbox', filled: !/^select one$/i.test(listbox.innerText.trim()), value: listbox.innerText.trim() };
      if (prompt) return { ...base, type: 'prompt', filled: !!f.querySelector('[data-automation-id="selectedItem"]') };
      if (radios.length) return { ...base, type: 'radio', filled: radios.some(r => r.checked), options: radios.map((r, i) => { r.setAttribute('data-jh-wd-radio', `${index}-${i}`); return { value: `${index}-${i}`, label: (r.labels?.[0]?.innerText || r.getAttribute('aria-label') || r.value).trim() }; }) };
      if (checkbox) return { ...base, type: 'checkbox', filled: checkbox.checked };
      if (input) return { ...base, type: input.tagName === 'TEXTAREA' ? 'textarea' : input.type || 'text', filled: !!input.value.trim() };
      return { ...base, type: 'unknown', filled: false };
    });
  });
}
async function chooseListOption(page, value, fallback) {
  const options = page.locator('[role="listbox"] [role="option"], [data-automation-id="promptOption"]');
  await options.first().waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
  const choices = [];
  for (let i = 0; i < await options.count(); i++) if (await options.nth(i).isVisible()) choices.push({ label: (await options.nth(i).innerText()).trim(), value: String(i) });
  const { optionMatch } = require('./browser');
  const opt = optionMatch(choices.filter(c => !/^select one$/i.test(c.label)), value) || (fallback && choices.find(c => fallback.test(c.label)));
  if (!opt) { await page.keyboard.press('Escape'); return false; }
  await options.nth(Number(opt.value)).click(); await page.waitForTimeout(400); return true;
}
function wdAnswer(field, profile, saved, origin, job) {
  const label = normalize(field.label);
  // Optional duplicates of identity fields (local-script name, extension, second phone) must stay blank.
  if (!field.required && /local|preferred|extension|middle|secondary|additional/.test(label)) return null;
  if (/how did you hear|source/.test(label)) return { value: job.source === 'LinkedIn' ? 'LinkedIn' : `${job.company} Career Site`, source: 'Verified job discovery source', fallback: job.source === 'LinkedIn' ? /linkedin/i : /career(?:s)? site|company website|corporate website|careers? (?:page|website)/i, category: job.source === 'LinkedIn' ? /social media|job (?:sites|boards)|online/i : /career websites?|company website|online/i };
  if (/phone device type|phone type/.test(label)) return { value: 'Mobile', source: 'Confirmed candidate profile' };
  if (/given name|first name/.test(label) && !/local|preferred/.test(label)) return { value: profile.firstName, source: 'Confirmed candidate profile' };
  if (/family name|last name/.test(label) && !/local|preferred/.test(label)) return { value: profile.lastName, source: 'Confirmed candidate profile' };
  if (/^phone number$/.test(label)) return { value: profile.phone, source: 'Confirmed candidate profile' };
  if (/country phone code/.test(label)) return { value: 'India (+91)', source: 'Confirmed candidate profile' };
  if (/^city(?: - local)?$/.test(label)) return { value: profile.currentCity, source: 'Confirmed candidate profile' };
  if (/^address line 1(?: - local)?$/.test(label) && profile.addressLine1) return { value: profile.addressLine1, source: 'Confirmed candidate profile' };
  if (/^(?:postal|pin|zip) ?code$/.test(label) && profile.postalCode) return { value: profile.postalCode, source: 'Confirmed candidate profile' };
  return resolve({ ...field, type: field.type === 'listbox' || field.type === 'prompt' ? 'select-one' : field.type }, profile, saved, origin, job);
}
async function wdFill(page, field, answer) {
  const root = page.locator(`[data-jh-wd="${field.id}"]`);
  if (field.type === 'listbox') { await root.locator('button[aria-haspopup="listbox"]').click(); return chooseListOption(page, answer.value, answer.fallback); }
  if (field.type === 'prompt') {
    const input = root.locator('input').first(); await input.click(); await input.fill(answer.value); await page.keyboard.press('Enter');
    if (await chooseListOption(page, answer.value, answer.fallback)) return true;
    if (!answer.category) return false;
    // Hierarchical prompts (e.g. "Career Websites" > "Careers Site") don't match a typed search; walk the tree instead.
    await input.click(); await input.fill(''); await page.waitForTimeout(800);
    if (!await chooseListOption(page, '', answer.category)) return false;
    await page.waitForTimeout(1000);
    return chooseListOption(page, answer.value, answer.fallback);
  }
  if (field.type === 'radio') { const { optionMatch } = require('./browser'); const opt = optionMatch(field.options, answer.value); if (!opt) return false; await require('./browser').setChoice(page.locator(`[data-jh-wd-radio="${opt.value}"]`)); return true; }
  if (field.type === 'checkbox') { if (!['yes', 'no', 'true', 'false'].includes(normalize(answer.value))) return false; await require('./browser').setChoice(root.locator('input[type="checkbox"]'), ['yes', 'true'].includes(normalize(answer.value))); return true; }
  if (['text', 'textarea', 'email', 'tel', 'number'].includes(field.type)) { if (field.type === 'number' && !/^\d+(\.\d+)?$/.test(answer.value)) return false; await root.locator('textarea, input').first().fill(answer.value); return true; }
  return false;
}
async function uploadResume(page, profile, api) {
  const input = page.locator('input[type="file"]').first();
  if (!await input.count()) return false;
  await input.evaluate(el => el.setAttribute('data-jh-field', 'wd-resume'));
  if (!await api.fill(page, { id: 'wd-resume', type: 'file', label: 'Resume/CV', accept: await input.getAttribute('accept') || '' }, null, profile)) return false;
  return page.waitForFunction(() => [...document.querySelectorAll('[data-automation-id="file-upload-successful"],[data-automation-id="fileUploadSuccessful"],[data-automation-id="delete-file"]')].length > 0, null, { timeout: 20000 }).then(() => true).catch(() => false);
}
async function apply(job, profile, saved, options, api) {
  let page, clickedSubmit = false;
  const usedAnswers = [];
  try {
    page = await api.open(job.applyLink, { interactive: options.interactive });
    await settle(page);
    const closed = /job (?:is no longer|not available)|no longer accepting/i.test(await page.locator('body').innerText());
    if (closed) return { status: 'excluded', reason: 'Workday posting is no longer open' };
    const applyButton = await visible(page, WD('adventureButton')) || await visibleButton(page, /^(?:apply(?: now)?|continue application)$/i);
    if (applyButton) {
      const popup = page.waitForEvent('popup', { timeout: 3500 }).catch(() => null);
      await applyButton.click(); const child = await popup;
      if (child) { await page.close(); page = child; }
      await page.locator(`${WD('applyManually')},${WD('signInContent')},${WD('pageFooterNextButton')}`).first().waitFor({ state: 'visible', timeout: 20000 }).catch(() => {});
    }
    if (/already applied/i.test(await page.locator('body').innerText())) return { status: 'needs_input', reason: 'Workday shows this job as already applied; verify the earlier application before any retry', questions: [] };
    const manual = await visible(page, WD('applyManually')) || await visibleButton(page, /^apply manually$/i);
    if (manual) { await manual.click(); await settle(page); }
    if (await visible(page, WD('signInContent'))) {
      const blocked = await signIn(page, profile, job, api);
      if (blocked) return blocked;
    }
    const native = async () => (await page.locator('[data-automation-id^="formField-"]').count()) > 0 || !!await visible(page, WD('pageFooterNextButton'));
    let resumeVerified = false;
    for (let step = 0; step < 12; step++) {
      await settle(page, 20000);
      const body = await page.locator('body').innerText();
      if (!body.trim() && !await page.locator('input,button,[role="button"]').count()) return { status: 'needs_input', reason: 'Workday page did not render; no application was submitted', questions: [], evidence: await api.screenshot(page, job, 'workday-loading') };
      if (/verify you are human|access denied|checking your browser/i.test(body) || await page.locator('iframe[src*="captcha"],script[src*="captcha-delivery"]').count()) return { status: 'needs_input', reason: 'Workday requires manual browser verification', requiresVerification: true, questions: [] };
      const passwords = page.locator('input[type="password"]');
      for (let i = 0; i < await passwords.count(); i++) if (await passwords.nth(i).isVisible()) return { status: 'needs_input', reason: 'Sign in to this company’s Workday account in the worker browser, then requeue the application', requiresLogin: true, questions: [], evidence: await api.screenshot(page, job, 'workday-login') };
      // The footer renders several seconds before the step's fields; only Review legitimately has none.
      await page.waitForFunction(() => document.querySelector('[data-automation-id^="formField-"],input[type="file"]') || /^submit/i.test(document.querySelector('[data-automation-id="pageFooterNextButton"]')?.innerText.trim() || '') || !document.querySelector('[data-automation-id="pageFooterNextButton"]'), null, { timeout: 25000 }).catch(() => {});
      // Questionnaire steps stream in after the first fields; scan once the field count holds steady.
      for (let i = 0, last = -1, stable = 0; i < 30 && stable < 3; i++) { await page.waitForTimeout(500); const n = await page.locator('[data-automation-id^="formField-"]').count(); stable = n === last ? stable + 1 : 0; last = n; }
      const origin = new URL(page.url()).origin, questions = [], step0 = await activeStep(page);
      if (await native()) {
        await page.locator('input[type="file"]').first().waitFor({ state: 'attached', timeout: /experience/i.test(await activeStep(page)) ? 10000 : 1 }).catch(() => {});
        if (await page.locator('input[type="file"]').count() && !resumeVerified) {
          resumeVerified = await uploadResume(page, profile, api);
          if (!resumeVerified) return { status: 'needs_input', reason: 'Workday did not confirm the resume upload', questions: [{ label: 'Resume upload', type: 'file', origin, reason: 'Upload needs manual completion' }], usedAnswers, evidence: await api.screenshot(page, job, 'workday-resume') };
          await settle(page, 15000);
        }
        // Answer twice: Workday reveals follow-up questions after a choice is made.
        for (let round = 0; round < 2; round++) {
          questions.length = 0;
          for (const field of await wdFields(page)) {
            if (field.filled || field.type === 'unknown' || field.type === 'file') continue;
            const answer = wdAnswer(field, profile, saved, origin, job);
            if (answer && answer.value && await wdFill(page, field, answer)) { usedAnswers.push({ label: field.label, value: answer.value, source: answer.source }); continue; }
            if (field.required) questions.push({ label: field.label, type: field.type, options: field.options, origin, reason: answer ? 'Answer does not match the available choices' : 'Needs your confirmed answer' });
          }
        }
      } else {
        for (const field of await api.fields(page)) {
          if (field.type === 'file') {
            if (/resume|cv/i.test(field.label) && await api.fill(page, field, null, profile)) { resumeVerified = true; await page.waitForTimeout(1500); }
            else if (field.required) questions.push({ ...field, origin, reason: 'Upload needs manual completion' });
            continue;
          }
          const answer = resolve(field, profile, saved, origin, job);
          if (answer && await api.fill(page, field, answer, profile)) usedAnswers.push({ label: field.label, value: answer.value, source: answer.source });
          else if (field.required) questions.push({ ...field, origin, reason: 'Needs your confirmed answer' });
        }
      }
      if (questions.length) return { status: 'needs_input', reason: `Workday application needs your answers (${step0 || 'form'})`, questions, usedAnswers, evidence: await api.screenshot(page, job, 'workday-review') };
      const footer = await visible(page, WD('pageFooterNextButton'));
      const footerText = footer ? (await footer.innerText()).trim() : '';
      const submit = /^submit/i.test(footerText) ? footer : await visibleButton(page, /^submit(?: application)?$/i);
      if (submit) {
        if (!resumeVerified && !(profile.resumeOriginalName && body.includes(profile.resumeOriginalName))) return { status: 'needs_input', reason: 'Resume upload has not been verified in this Workday application', questions: [], usedAnswers };
        if (options.dryRun) return { status: 'ready', reason: 'Workday form prepared without final submission', usedAnswers, evidence: await api.screenshot(page, job, 'workday-ready') };
        const state = store.state(); const match = evaluate(job, { ...profile, excludedCompanies: [...profile.excludedCompanies, ...state.excludedCompanies] });
        if (!match.eligible) return { status: 'excluded', reason: match.blocked.join('; ') };
        if (state.settings.paused || !state.settings.autoApply) return { status: 'queued', reason: 'Paused before Workday submission' };
        store.mutate(s => Object.assign(s.jobs.find(j => j.id === job.id), { status: 'submitting', lastAttemptAt: new Date().toISOString(), usedAnswers }));
        clickedSubmit = true; await submit.click();
        for (let i = 0; i < 20; i++) {
          await page.waitForTimeout(1000); const confirmation = await api.confirmation(page, 'workday');
          if (confirmation) {
            store.mutate(s => Object.assign(s.jobs.find(j => j.id === job.id), { status: 'submitted', submittedAt: confirmation.at, confirmation, usedAnswers }));
            return { status: 'submitted', submittedAt: confirmation.at, confirmation, usedAnswers, evidence: await api.screenshot(page, job, 'workday-submitted') };
          }
        }
        return { status: 'submission_uncertain', reason: 'Workday submission attempted without a recognised receipt; review before retrying', usedAnswers, evidence: await api.screenshot(page, job, 'workday-uncertain') };
      }
      const next = footer || await visibleButton(page, /^(?:save and continue|next|continue)$/i);
      if (!next) return { status: 'needs_input', reason: `Workday step needs manual attention; no continuation control (${step0 || page.url()})`, questions: [], usedAnswers, evidence: await api.screenshot(page, job, 'workday-step') };
      await next.click();
      await page.waitForFunction(before => {
        const active = document.querySelector('[data-automation-id="progressBarActiveStep"]')?.innerText.replace(/\s+/g, ' ').trim() || '';
        return (before && active && active !== before) || [...document.querySelectorAll('[data-automation-id="errorMessage"],[data-automation-id="errorBanner"]')].some(el => el.offsetWidth || el.offsetHeight);
      }, step0, { timeout: 20000 }).catch(() => {});
      const alerts = await page.locator(`${WD('errorMessage')},${WD('errorBanner')},[role="alert"]`).allTextContents();
      if (alerts.some(t => /required|invalid|error|please enter|please select/i.test(t))) return { status: 'needs_input', reason: `Workday rejected a field: ${alerts.join('; ').slice(0, 300)}`, questions: [], usedAnswers, evidence: await api.screenshot(page, job, 'workday-validation') };
      if (step0 && await activeStep(page) === step0) store.write('workday-stalled-step', { jobId: job.id, step: step0, fields: await wdFields(page), controls: await page.evaluate(() => [...document.querySelectorAll('[data-automation-id="applyFlowPage"] button[aria-haspopup], [data-automation-id="applyFlowPage"] textarea, [data-automation-id="applyFlowPage"] input:not([type=hidden])')].slice(0, 30).map(el => { const chain = []; for (let p = el.parentElement, i = 0; p && i < 6; p = p.parentElement, i++) chain.push([p.tagName, p.dataset.automationId, p.getAttribute('role'), p.id].filter(Boolean).join(':')); return { tag: el.tagName, type: el.type, id: el.id, name: el.name, autoId: el.dataset.automationId, labelledby: el.getAttribute('aria-labelledby'), describedby: el.getAttribute('aria-describedby'), required: el.getAttribute('aria-required'), labelText: el.labels?.[0]?.innerText.slice(0, 80), chain }; })) });
      if (step0 && await activeStep(page) === step0) return { status: 'needs_input', reason: `Workday did not advance past ${step0}`, questions: [], usedAnswers, evidence: await api.screenshot(page, job, 'workday-stalled') };
    }
    return { status: 'needs_input', reason: 'Workday form exceeds supported step limit; review required', questions: [], usedAnswers };
  } catch (error) { return { status: clickedSubmit ? 'submission_uncertain' : 'needs_input', reason: error.message.split('\n')[0], questions: [], usedAnswers, evidence: page ? await api.screenshot(page, job, 'workday-error').catch(() => null) : null }; }
  finally { if (page && !options.interactive) await page.close().catch(() => {}); }
}
module.exports = { apply, visibleButton, wdAnswer };
