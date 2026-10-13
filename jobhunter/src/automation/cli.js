require('dotenv').config();
const { run, recover } = require('./runner');
const browser = require('./browser');
const store = require('./store');
const mode = process.argv[2] || 'discover';
if (!['discover', 'dry-run', 'apply', 'daily'].includes(mode)) { console.error('Use discover, dry-run, apply, or daily'); process.exit(1); }
if (process.argv.includes('--companies')) {
  const { discover } = require('./discovery');
  const { profile } = require('./runner');
  const index = process.argv.indexOf('--companies');
  discover(profile(), store.event, process.argv[index + 1].split(','))
    .then(result => { require('./reports').save(); console.log(JSON.stringify(result.slice(-10), null, 2)); })
    .catch(error => { console.error(error.message); process.exitCode = 1; });
} else {
run({ discovery: ['discover', 'daily'].includes(mode), apply: mode !== 'discover', dryRun: mode === 'dry-run', jobId: process.argv.includes('--job') ? process.argv[process.argv.indexOf('--job') + 1] : undefined })
  .then(result => console.log(JSON.stringify(result, null, 2)))
  .catch(error => { console.error(error.message); process.exitCode = 1; })
  .finally(() => browser.close());
}
