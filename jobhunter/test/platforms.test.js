const test = require('node:test');
const assert = require('node:assert/strict');
const { sessionStatus } = require('../src/automation/platforms');
const { extractCode, trustedSender } = require('../src/automation/email');
test('portal authentication requires an account marker and never overrides a challenge', () => {
  assert.equal(sessionStatus('Naukri', { url: 'https://www.naukri.com/', accountMarker: false }), 'unverified');
  assert.equal(sessionStatus('LinkedIn', { url: 'https://www.linkedin.com/checkpoint/', accountMarker: true }), 'login_required');
  assert.equal(sessionStatus('Naukri', { url: 'https://www.naukri.com/mnjuser/homepage', accountMarker: true, challenge: true }), 'verification_required');
  assert.equal(sessionStatus('Instahyre', { url: 'https://www.instahyre.com/candidate/opportunities/', accountMarker: true }), 'authenticated');
});
test('verification codes accept the expected mail template and reject untrusted lookalike senders', () => {
  assert.equal(extractCode('Copy and paste this code into the security code field on your application:\nAb12Cd34\nAfter you enter the code, resubmit your application.'), 'Ab12Cd34');
  assert.equal(extractCode('Your application reference is 12345678'), null);
  assert.equal(trustedSender('no-reply@greenhouse.io'), true);
  assert.equal(trustedSender('no-reply@greenhouse.io.attacker.example'), false);
});

test('HTML-only verification emails preserve the code between block elements', () => {
  const { extractMailCode } = require('../src/automation/email');
  assert.equal(extractMailCode({ html: '<p>Copy and paste this code into the security code field on your application:</p><p><strong>Ab12Cd34</strong></p><p>After you enter the code, resubmit your application.</p>' }), 'Ab12Cd34');
});
