// Shared helper to resolve the project's Python executable.
// Prefers the project venv (either OS layout), then falls back to a system
// Python so the same repo works on Windows + macOS without activation.
const fs = require('fs');
const path = require('path');

const projectRoot = path.join(__dirname, '..');

function resolvePython() {
  const candidates = [
    path.join(projectRoot, 'venv', 'Scripts', 'python.exe'), // Windows venv
    path.join(projectRoot, 'venv', 'bin', 'python'),         // macOS/Linux venv
  ];
  for (const exe of candidates) {
    if (fs.existsSync(exe)) return exe;
  }
  // No venv found: fall back to system Python on PATH.
  return process.platform === 'win32' ? 'python' : 'python3';
}

module.exports = { resolvePython, projectRoot };
