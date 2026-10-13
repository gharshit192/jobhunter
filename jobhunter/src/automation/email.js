const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const cheerio = require('cheerio');
const store = require('./store');
function status() { const c = store.read('email-connection', null); return { connected: !!c, email: c?.email || '', verifiedAt: c?.verifiedAt || null }; }
function clientFor(credentials) {
  return new ImapFlow({ host: 'imap.gmail.com', port: 993, secure: true, auth: { user: credentials.email, pass: credentials.appPassword }, logger: false, connectionTimeout: 15000, greetingTimeout: 10000, socketTimeout: 20000 });
}
async function connect(email, password, expectedEmail) {
  if (String(email || '').toLowerCase().trim() !== expectedEmail.toLowerCase()) throw new Error('Connect the application email from your confirmed profile');
  const appPassword = String(password || '').replace(/\s/g, '');
  if (!/^[a-zA-Z0-9]{16}$/.test(appPassword)) throw new Error('Enter a 16-character Gmail app password in the local dashboard');
  const credentials = { email: expectedEmail, appPassword, verifiedAt: new Date().toISOString() };
  const client = clientFor(credentials);
  try { await client.connect(); await client.mailboxOpen('INBOX', { readOnly: true }); }
  catch { throw new Error('Gmail authentication failed. Check the account and app password. No connection was saved.'); }
  finally { await client.logout().catch(() => {}); }
  store.write('email-connection', credentials);
  store.event('Local Gmail verification connection authenticated');
  return status();
}
function extractCode(text) {
  const patterns = [ /copy and paste[\s\S]{0,250}?application:\s*([A-Za-z0-9]{8})\b/i, /(?:security|verification) code\s*(?:is|:)\s*([A-Za-z0-9]{8})\b/i ];
  const normalized = String(text || '').replace(/[\u200b-\u200d\ufeff]/g, '').replace(/[*_`]/g, '');
  for (const pattern of patterns) { const match = normalized.match(pattern); if (match) return match[1]; }
  return null;
}
function extractMailCode(mail) {
  const plain = extractCode(mail.text);
  if (plain || !mail.html) return plain;
  const $ = cheerio.load(String(mail.html));
  $('script,style').remove(); $('br').replaceWith('\n'); $('p,div,td,li').append('\n');
  return extractCode($.root().text());
}
function trustedSender(address) { const domain = String(address || '').split('@').pop().toLowerCase(); return /(?:^|\.)greenhouse\.io$|(?:^|\.)greenhouse-mail\.io$/.test(domain); }
async function findCode(company, since, expectedEmail) {
  const credentials = store.read('email-connection', null);
  if (!credentials || credentials.email !== expectedEmail) return null;
  const client = clientFor(credentials);
  const diagnostic = { company, checkedAt: new Date().toISOString(), matchingMessages: 0, rejectedSender: 0, rejectedDate: 0, rejectedRecipient: 0, missingCode: 0, codeFound: false };
  try {
    await client.connect(); await client.mailboxOpen('INBOX', { readOnly: true });
    // Search only verification mail for this company; do not browse unrelated messages or mark mail read.
    const uids = await client.search({ since: new Date(since - 60000), subject: `Security code for your application to ${company}` }, { uid: true });
    diagnostic.matchingMessages = (uids || []).length;
    for (const uid of (uids || []).slice(-5).reverse()) {
      const message = await client.fetchOne(uid, { envelope: true, source: true, size: true }, { uid: true });
      if (!message || message.size > 150000) continue;
      if (!message.envelope.from?.some(f => trustedSender(f.address))) { diagnostic.rejectedSender++; continue; }
      if (new Date(message.envelope.date).getTime() < since - 60000) { diagnostic.rejectedDate++; continue; }
      const mail = await simpleParser(message.source, { skipHtmlToText: false, skipTextToHtml: true });
      if (!mail.to?.value?.some(a => a.address?.toLowerCase() === expectedEmail.toLowerCase())) { diagnostic.rejectedRecipient++; continue; }
      diagnostic.hasText = !!mail.text; diagnostic.hasHtml = !!mail.html;
      diagnostic.templatePresent = /copy and paste/i.test(mail.text || '');
      diagnostic.codeTokenCount = (String(mail.text || '').match(/\b[A-Za-z0-9]{8}\b/g) || []).length;
      const code = extractMailCode(mail);
      if (code) { diagnostic.codeFound = true; return code; }
      diagnostic.missingCode++; // Memory only: never store the code or email body.
    }
    return null;
  } catch (error) { diagnostic.error = error.code || 'mailbox_read_failed'; store.event('Could not read a verification message from the local Gmail connection'); return null; }
  finally { store.write('email-diagnostic', diagnostic); await client.logout().catch(() => {}); }
}
async function waitForCode(company, since, expectedEmail) {
  if (!status().connected) return null;
  for (let attempt = 0; attempt < 8; attempt++) {
    const code = await findCode(company, since, expectedEmail);
    if (code) return code;
    await new Promise(r => setTimeout(r, 5000));
  }
  return null;
}
module.exports = { status, connect, findCode, waitForCode, extractCode, extractMailCode, trustedSender };

async function findHiristOTP(since, expectedEmail) {
  const credentials = store.read('email-connection', null);
  if (!credentials || credentials.email !== expectedEmail) return null;
  const client = clientFor(credentials);
  const diagnostic = { portal: 'Hirist', checkedAt: new Date().toISOString(), matchingVerificationMessages: 0, codeFound: false };
  try {
    await client.connect(); await client.mailboxOpen('INBOX', { readOnly: true });
    const uids = await client.search({ since: new Date(since), or: [{ from: 'hirist.tech' }, { from: 'hirist.com' }] }, { uid: true });
    for (const uid of (uids || []).slice(-10).reverse()) {
      const head = await client.fetchOne(uid, { envelope: true, size: true }, { uid: true });
      if (!head || head.size > 150000 || Date.parse(head.envelope.date) < since) continue;
      if (!/otp|one.time|verification|login|sign.in/i.test(head.envelope.subject || '')) continue;
      if (!head.envelope.from?.some(f => /(?:^|\.)hirist\.(?:tech|com)$/.test(String(f.address || '').split('@').pop().toLowerCase()))) continue;
      diagnostic.matchingVerificationMessages++;
      const source = await client.fetchOne(uid, { source: true }, { uid: true });
      const mail = await simpleParser(source.source);
      if (!mail.to?.value?.some(a => a.address?.toLowerCase() === expectedEmail.toLowerCase())) continue;
      const $ = cheerio.load(String(mail.html || '')); $('script,style').remove(); $('br').replaceWith('\n'); $('p,div,td,li').append('\n');
      const text = String((mail.text || '') + '\n' + $.root().text()).replace(/[*_`]/g, '').replace(/\s+/g, ' ');
      const spacedCodes = [...text.matchAll(/\b(\d(?:\s+\d){5})\b/g)].map(m => m[1].replace(/\s/g, ''));
      const candidates = [...new Set([...(text.match(/\b\d{6}\b/g) || []), ...spacedCodes])];
      diagnostic.numericTokenLengths = (text.match(/\b\d{4,8}\b/g) || []).map(n => n.length); diagnostic.bodyChars = text.length; diagnostic.otpKeywordInBody = /otp|one.time|code/i.test(text);
      diagnostic.sixDigitTokens = candidates.length; diagnostic.otpSubject = /otp|one.time/i.test(head.envelope.subject || '');
      const match = text.match(/(?:otp|one.time\s*(?:password|passcode)|verification code|login code)[^\d]{0,100}(\d{4,8})\b/i) || text.match(/\b(\d{4,8})\s+is\s+(?:your\s+)?(?:otp|one.time)/i) || (diagnostic.otpSubject && candidates.length === 1 ? [null, candidates[0]] : null);
      if (match) { diagnostic.codeFound = true; diagnostic.receivedAt = new Date(head.envelope.date).toISOString(); return match[1]; }
    }
    return null;
  } catch (error) { diagnostic.error = error.code || 'mailbox_read_failed'; return null; }
  finally { store.write('hirist-email-status', diagnostic); await client.logout().catch(() => {}); }
}
module.exports.findHiristOTP = findHiristOTP;
