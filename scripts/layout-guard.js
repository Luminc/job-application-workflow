// Advisory layout check for a freshly built CV: orphans, split words, overflow.
// Silent when clean. Never fails the build; `npm run check-type` is the hard gate.
const { spawnSync } = require('child_process');
const path = require('path');

function runLayoutCheck(pdfPath) {
  const script = path.join(__dirname, 'run-python.js');
  const result = spawnSync(
    process.execPath,
    [script, path.join(__dirname, 'check_typography.py'), '--brief', pdfPath],
    { stdio: 'inherit' }
  );
  return result.status === 0;
}

module.exports = { runLayoutCheck };
