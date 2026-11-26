// CLI wrapper: run a Python script through the resolved project Python.
// Usage: node scripts/run-python.js <script.py> [args...]
const { spawnSync } = require('child_process');
const { resolvePython, projectRoot } = require('./python-exec.js');

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error('Usage: node scripts/run-python.js <script.py> [args...]');
  process.exit(2);
}

const python = resolvePython();
const result = spawnSync(python, args, { cwd: projectRoot, stdio: 'inherit' });

if (result.error) {
  console.error(`\n❌ Failed to launch Python (${python}): ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status === null ? 1 : result.status);
