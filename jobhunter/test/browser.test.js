const { test } = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { fields, optionMatch, confirmation } = require('../src/automation/browser');
test('radio answers use the correct visible choice when both values are on', async () => {
  const chrome = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await chrome.newPage();
    await page.setContent('<fieldset id="location"><legend>Are you comfortable working in Pune/Indore?</legend><div><input type="radio" aria-labelledby="question" value="on">No</div><div><input type="radio" aria-labelledby="question" value="on">Yes</div></fieldset><span id="question">Are you comfortable working in Pune/Indore?</span>');
    const found = await fields(page); assert.deepEqual(found[0].options.map(o => o.label), ['No', 'Yes']);
    assert.equal(await require('../src/automation/browser').fill(page, found[0], { value: 'Yes' }, {}), true);
    assert.equal(await page.locator('input').nth(0).isChecked(), false); assert.equal(await page.locator('input').nth(1).isChecked(), true);
  } finally { await chrome.close(); }
});
test('browser recognizes hidden resume uploads, accessible labels and excludes React helper inputs', async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<form><label for="email">Email*</label><input id="email" required><label id="country-label">Country*</label><input id="country" role="combobox" aria-labelledby="country-label" aria-required="true"><input required tabindex="-1" aria-hidden="true"><label for="resume">Attach</label><input id="resume" type="file" accept=".pdf,.docx" style="display:none"><label for="optional">Website</label><input id="optional"></form>`);
    const found = await fields(page);
    assert.equal(found.length, 4);
    assert.equal(found.find(f => f.label === 'Country*').type, 'combobox');
    assert.equal(found.find(f => f.type === 'file').label, 'Resume/CV');
    assert.equal(found.find(f => f.label === 'Website').required, false);
    assert.equal(await confirmation(page, 'greenhouse'), null);
    await page.setContent('<main>Thank you for applying! Your application has been received.</main>');
    assert.ok(await confirmation(page, 'greenhouse'));
    await page.setContent('<main>Thank you for taking the time to apply! Our team is always on the lookout for top talent here at Druva.</main>');
    assert.ok(await confirmation(page, 'greenhouse'));
  } finally { await browser.close(); }
});
test('optional demographic choices select non-disclosure, never a guessed identity', () => {
  const options = [{ label: 'Male', value: 'male' }, { label: 'Decline to self-identify', value: 'decline' }];
  assert.equal(optionMatch(options, 'Prefer not to disclose').value, 'decline');
  assert.equal(optionMatch([{ label: 'Male', value: 'male' }], 'Prefer not to disclose'), undefined);
});
test('normal browser opening is always headless even if an old setting requested windows', async () => {
  const api = require('../src/automation/browser');
  const actual = chromium.launchPersistentContext;
  let options;
  chromium.launchPersistentContext = async (_, value) => {
    options = value;
    return { on() {}, async newPage() { return { async goto() {} }; }, async close() {} };
  };
  try { await api.open('https://example.com'); assert.equal(options.headless, true); assert.equal(api.isBackground(), true); }
  finally { await api.close(); chromium.launchPersistentContext = actual; }
});
test('Workday stops at login, unknown required answers, and unverified resume instead of submitting', async () => {
  const chrome = await chromium.launch({ channel: 'chrome', headless: true });
  const worker = require('../src/automation/workday');
  try {
    for (const [html, expected] of [
      ['<label>Password<input type="password"></label>', /Sign in/],
      ['<label>Street address<input required></label>', /needs your answers/],
      ['<button>Submit application</button>', /Resume upload has not been verified/]
    ]) {
      const page = await chrome.newPage(); await page.setContent(html);
      let submissions = 0; page.on('request', request => { if (request.method() === 'POST') submissions++; });
      const result = await worker.apply({ id: 'fixture', company: 'Example', applyLink: 'https://example.com' }, {}, {}, { dryRun: false }, { open: async () => page, fields, fill: async () => false, screenshot: async () => null, confirmation });
      assert.equal(result.status, 'needs_input'); assert.match(result.reason, expected); assert.equal(submissions, 0);
    }
  } finally { await chrome.close(); }
});
test('hidden radios behind labels are selected even when the label intercepts clicks', async () => {
  const chrome = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await chrome.newPage();
    await page.setContent('<fieldset><legend>Are you comfortable working in Pune?</legend><label style="position:relative;display:block;width:120px;height:24px"><input type="radio" name="q" value="Yes" style="position:absolute;opacity:0;width:1px;height:1px"><span style="position:absolute;inset:0;background:#fff">Yes</span></label><label style="position:relative;display:block;width:120px;height:24px"><input type="radio" name="q" value="No" style="position:absolute;opacity:0;width:1px;height:1px"><span style="position:absolute;inset:0;background:#fff">No</span></label></fieldset>');
    await require('../src/automation/browser').setChoice(page.locator('input[value="Yes"]'));
    assert.equal(await page.locator('input[value="Yes"]').isChecked(), true);
  } finally { await chrome.close(); }
});
test('Workday native widgets: legend labels, listbox choices, and dry run stops at Submit', async () => {
  const chrome = await chromium.launch({ channel: 'chrome', headless: true });
  const worker = require('../src/automation/workday');
  try {
    const page = await chrome.newPage();
    await page.setContent(`<div data-automation-id="applyFlowPage"><div data-automation-id="progressBarActiveStep">current step 3 of 3 Review</div>
      <fieldset><legend>Do you now, or will you in the future, require sponsorship to work in the country you are applying to?*</legend><div data-automation-id="formField-q1"><button type="button" aria-haspopup="listbox" id="lb">Select One</button></div></fieldset>
      <div data-automation-id="formField-phoneType"><label>Phone Device Type*</label><button type="button" aria-haspopup="listbox" id="pt">Select One</button></div>
      <div data-automation-id="formField-legalName--firstNameLocal"><label>Local Given Name(s)</label><input id="local"></div>
      <p>Resume.docx</p><button data-automation-id="pageFooterNextButton">Submit</button></div>
      <script>for (const id of ['lb', 'pt']) document.getElementById(id).onclick = e => { const list = document.createElement('ul'); list.setAttribute('role', 'listbox'); for (const t of id === 'lb' ? ['Select One', 'Yes', 'No'] : ['Select One', 'Landline', 'Mobile']) { const li = document.createElement('li'); li.setAttribute('role', 'option'); li.textContent = t; li.onclick = () => { e.target.textContent = t; list.remove(); }; list.append(li); } document.body.append(list); };</script>`);
    const result = await worker.apply({ id: 'fixture', company: 'Example', location: 'Pune, India', applyLink: 'https://example.com' }, { firstName: 'A', resumeOriginalName: 'Resume.docx', cities: ['Pune'] }, {}, { dryRun: true, interactive: true }, { open: async () => page, fields, fill: async () => false, screenshot: async () => null, confirmation });
    assert.equal(result.status, 'ready', result.reason);
    assert.equal(await page.locator('#lb').innerText(), 'No'); assert.equal(await page.locator('#pt').innerText(), 'Mobile'); assert.equal(await page.locator('#local').inputValue(), '');
  } finally { await chrome.close(); }
});
