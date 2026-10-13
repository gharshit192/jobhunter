const store = require('./store');
async function login(profile) {
  const browser = require('./browser'); let page;
  const result = { name: 'Hirist', checkedAt: new Date().toISOString(), status: 'unverified', mode: 'manual' };
  try {
    page = await browser.open('https://www.hirist.tech/login'); await page.waitForTimeout(1800);
    if (/verify you are human|access denied|checking your browser/i.test(await page.locator('body').innerText())) { result.status = 'verification_required'; return result; }
    const login = page.getByRole('button', { name: /^login$/i });
    if (await login.count()) await login.first().click();
    const email = page.getByPlaceholder('Email or Mobile Number', { exact: true });
    await email.first().waitFor({ state: 'visible', timeout: 7000 }).catch(() => {});
    if (!await email.count()) { result.note = 'No recognised email OTP form; live account check required'; return result; }
    await email.fill(profile.email);
    const getOTP = page.getByRole('button', { name: /^get otp$/i });
    if (!await getOTP.count() || !await getOTP.first().isEnabled()) { result.note = 'OTP request control needs manual attention'; return result; }
    const since = Date.now() - 3000; await getOTP.first().click();
    await page.waitForFunction(() => [...document.querySelectorAll('input')].some(el => /otp|verification code/i.test(el.placeholder || el.name || el.getAttribute('aria-label') || '') || el.autocomplete === 'one-time-code'), null, { timeout: 10000 }).catch(() => {});
    const layout = await page.evaluate(() => {
      const visible = el => !!(el.offsetWidth || el.offsetHeight);
      const inputs = [...document.querySelectorAll('input')].filter(visible).filter(el => /otp|verification code/i.test([el.placeholder,el.name,el.getAttribute('aria-label')].join(' ')) || el.autocomplete === 'one-time-code' || (el.maxLength === 1 && /numeric|number/.test(el.inputMode || el.type)));
      inputs.forEach((el,i) => { el.setAttribute('data-jh-otp', String(i)); el.autocomplete = 'one-time-code'; });
      return { count: inputs.length, fields: inputs.map(el => ({ type: el.type, maxlength: el.maxLength, placeholder: el.placeholder })), buttons: [...document.querySelectorAll('button')].filter(visible).map(el => el.innerText.trim()).filter(Boolean) };
    });
    store.write('hirist-otp-layout', layout);
    if (!layout.count) { result.status = 'otp_required'; result.note = 'OTP email requested; form layout needs verification before entry'; return result; }
    let code;
    for (let attempt = 0; attempt < 6; attempt++) {
      code = await require('./email').findHiristOTP(since, profile.email); if (code) break;
      await page.waitForTimeout(3000);
    }
    if (!code) { result.status = 'otp_required'; result.note = 'No matching fresh login OTP found'; return result; }
    if (layout.count === 1) await page.locator('[data-jh-otp="0"]').fill(code);
    else if (layout.count === code.length) for (let i = 0; i < code.length; i++) await page.locator(`[data-jh-otp="${i}"]`).fill(code[i]);
    else { result.status = 'otp_required'; result.note = 'OTP length differs from the visible form'; return result; }
    const verify = page.getByRole('button', { name: /^(?:verify(?: otp)?|verify\s*(?:&|and)\s*login|continue|sign in)$/i });
    if (!await verify.count() || !await verify.first().isEnabled()) { result.status = 'otp_required'; result.note = 'OTP read successfully; no supported final verification control'; return result; }
    await verify.first().click(); await page.waitForTimeout(2500);
    const confirmed = await page.evaluate(() => [...document.querySelectorAll('a,button')].some(el => /^(?:log\s*out|my profile|edit profile|my applications)$/i.test(el.innerText.trim()) || /^\/(?:profile|my-applications)\/?$/.test(el.getAttribute('href') || '')));
    const afterLogin = await page.evaluate(() => ({ url: location.origin + location.pathname, visibleLogin: [...document.querySelectorAll('button')].some(el => !!(el.offsetWidth || el.offsetHeight) && /^login$/i.test(el.innerText.trim())), localSessionKeys: Object.keys(localStorage).filter(k => /auth|token|user|session/i.test(k)), accountLabels: [...document.querySelectorAll('a,button')].filter(el => /profile|log.?out|harshit|continue|verify/i.test(el.innerText)).map(el => el.innerText.trim().slice(0,80)).slice(0,15), otpInputs: document.querySelectorAll('[data-jh-otp]').length })); store.write('hirist-after-login', afterLogin);
    const cookies = await page.context().cookies('https://www.hirist.tech/');
    const sessionCookie = cookies.some(c => c.name === 'hirist_seeker_enc' && c.value.length > 0);
    const otpVisible = await page.locator('[data-jh-otp]').evaluateAll(inputs => inputs.some(el => !!(el.offsetWidth || el.offsetHeight)));
    const authenticated = confirmed || (sessionCookie && !otpVisible);
    result.status = authenticated ? 'authenticated' : 'login_submitted_unverified';
    result.note = authenticated ? 'Email OTP entered automatically; completed verification and seeker session confirm login' : 'Email OTP entered; live session still needs verification';
    return result;
  } catch (error) { result.status = 'check_failed'; result.note = error.message.split('\n')[0]; return result; }
  finally {
    const statuses = store.read('platform-status', []); store.write('platform-status', [...statuses.filter(p => p.name !== 'Hirist'), result]);
    store.event(`Hirist: ${result.status}${result.note ? ' — ' + result.note : ''}`);
    if (page) await page.close().catch(() => {});
  }
}
module.exports = { login };
