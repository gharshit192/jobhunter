const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(process.env.AUTOMATION_DATA_DIR || path.join(__dirname, '../../.automation'));
function ensure() { fs.mkdirSync(ROOT, { recursive: true, mode: 0o700 }); }
function read(name, fallback) {
  ensure();
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, `${name}.json`), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}
function write(name, value) {
  ensure();
  const dest = path.join(ROOT, `${name}.json`);
  const tmp = `${dest}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, dest);
  return value;
}
function state() { return read('state', { jobs: [], runs: [], events: [], answers: {}, excludedCompanies: [], settings: { autoApply: true, dailyTarget: 15, paused: false, headless: true } }); }
function mutate(fn) { const value = state(); fn(value); write('state', value); return value; }
function event(message) { mutate(s => { s.events.unshift({ time: new Date().toISOString(), message }); s.events = s.events.slice(0, 300); }); }
function indiaDay(date = new Date()) { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date); }
function acquireLock() {
  ensure();
  const file = path.join(ROOT, 'worker.lock');
  try { const fd = fs.openSync(file, 'wx', 0o600); fs.writeSync(fd, String(process.pid)); fs.closeSync(fd); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const pid = Number(fs.readFileSync(file, 'utf8'));
    try { process.kill(pid, 0); } catch (e) { if (e.code === 'ESRCH') { fs.unlinkSync(file); return acquireLock(); } throw e; }
    throw new Error('Another automation worker is already running');
  }
  return () => { try { fs.unlinkSync(file); } catch (e) { if (e.code !== 'ENOENT') throw e; } };
}
function workerActive() {
  const file = path.join(ROOT, 'worker.lock');
  if (!fs.existsSync(file)) return false;
  const pid = Number(fs.readFileSync(file, 'utf8'));
  if (!Number.isInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
}
module.exports = { ROOT, read, write, state, mutate, event, indiaDay, acquireLock, workerActive };
