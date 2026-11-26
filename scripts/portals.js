// Job boards from community-portals (github.com/ai-job-search-dev/community-portals)
// as search sources. Every portal there is a small Bun CLI with the same
// contract: `search` returns { meta, results: [{ id, title, company, location,
// date, url }] } and `detail <id|url>` returns one posting with its full
// `description`, both as JSON on stdout; errors go to stderr as JSON with exit 1.
// That contract is what makes one adapter enough for every board.
//
// Setup:
//   1. Install Bun (https://bun.sh).
//   2. Clone community-portals next to this repo, or anywhere, and point
//      PORTALS_DIR (env or .env) or "dir" in <profile>/search/portals.json at
//      its portals/ folder. A portal you wrote yourself can live anywhere with
//      the same layout: <dir>/<country>/<name>/cli/src/cli.ts.
//   3. Run `bun install` once in each portal's cli/ folder (dev types only;
//      portals have no runtime dependencies), or skip it: they run without.
//   4. List the portals to use in <profile>/search/portals.json, and add
//      "portals" to profile.json search.platforms.
//
// <profile>/search/portals.json:
//   {
//     "dir": "../community-portals/portals",
//     "portals": {
//       "linkedin-search": { "args": { "location": "Utrecht, Netherlands" } },
//       "jobindex-search": { "terms": ["redaktør", "kommunikation"] }
//     }
//   }
// "args" become CLI flags on every search (--location ...). "terms" override
// the search terms; otherwise the preset in queries.json supplies them: its
// key with the portal's name, else its "portals" list, else the preset itself
// when it is a plain list. Read each portal's SKILL.md for its flags and
// query syntax.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const P = require('../lib/profile.js');

const CONFIG_FILE = P.profilePath('search', 'portals.json');
const TIMEOUT_MS = 120000;

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch { return fallback; }
}

function setting(name) {
  if (process.env[name]) return process.env[name];
  try {
    const m = fs.readFileSync(path.join(P.ROOT, '.env'), 'utf8').match(new RegExp(`^\\s*${name}\\s*=\\s*(.*?)\\s*$`, 'm'));
    if (m && m[1]) return m[1].replace(/^["']|["']$/g, '');
  } catch { /* no .env */ }
  return null;
}

function config() {
  const cfg = readJson(CONFIG_FILE, null) || {};
  const dir = setting('PORTALS_DIR') || cfg.dir || '../community-portals/portals';
  return { dir: path.resolve(P.ROOT, dir), portals: cfg.portals || {} };
}

// <dir>/<country>/<name>/cli/src/cli.ts, or <dir>/<name>/cli/src/cli.ts.
function cliPath(name, dir = config().dir) {
  const direct = path.join(dir, name, 'cli', 'src', 'cli.ts');
  if (fs.existsSync(direct)) return direct;
  if (!fs.existsSync(dir)) return null;
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const p = path.join(dir, d.name, name, 'cli', 'src', 'cli.ts');
    if (fs.existsSync(p)) return p;
  }
  return null;
}

let bunChecked = null;
function bunAvailable() {
  if (bunChecked === null) {
    const r = spawnSync('bun', ['--version'], { encoding: 'utf-8' });
    bunChecked = r.status === 0;
  }
  return bunChecked;
}

function flags(args) {
  const out = [];
  for (const [k, v] of Object.entries(args || {})) {
    if (v === false || v === null || v === undefined) continue;
    out.push(`--${k}`);
    if (v !== true) out.push(String(v));
  }
  return out;
}

// Runs a portal CLI; { status: 200, data } or { status: 'error', error }.
function run(name, argv) {
  const cli = cliPath(name);
  if (!cli) return { status: 'missing', error: `portal ${name} not found under ${config().dir}` };
  // No shell: arguments go to bun as they are, so a search term cannot be
  // read as a command. bun.exe is on PATH after a normal install.
  const r = spawnSync('bun', ['run', cli, ...argv], {
    encoding: 'utf-8', timeout: TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024,
    cwd: path.dirname(path.dirname(cli)),
  });
  if (r.error) return { status: 'error', error: r.error.message };
  if (r.status !== 0) {
    let err = (r.stderr || '').trim();
    try { err = JSON.parse(err).error || err; } catch { /* plain text */ }
    return { status: 'error', error: err.slice(0, 300) || `exit ${r.status}` };
  }
  try { return { status: 200, data: JSON.parse(r.stdout) }; } catch { return { status: 'error', error: 'no JSON on stdout' }; }
}

// Search one term. `days` maps to --jobage, which every portal accepts (a
// portal that cannot filter on age documents that and ignores it).
function search(name, term, days, { args = {}, limit } = {}) {
  const argv = ['search', ...(term ? ['--query', term] : []), ...flags(args), '--format', 'json'];
  if (days && !('jobage' in args)) argv.push('--jobage', String(days));
  if (limit) argv.push('--limit', String(limit));
  const r = run(name, argv);
  if (r.status !== 200) return { status: r.status, error: r.error, results: [] };
  const results = Array.isArray(r.data.results) ? r.data.results : [];
  return { status: 200, results: results.filter((x) => x && x.url) };
}

// Full posting as a matches job, or { status } when it could not be read.
function detail(name, idOrUrl) {
  const r = run(name, ['detail', String(idOrUrl), '--format', 'json']);
  if (r.status !== 200) return { status: r.status, error: r.error };
  const d = r.data && (r.data.result || r.data.job || r.data);
  if (!d || !d.description) return { status: 'no description' };
  const facts = [
    d.salary ? `Salary: ${typeof d.salary === 'object' ? JSON.stringify(d.salary) : d.salary}` : '',
    d.hours ? `Hours: ${d.hours}` : '',
    d.employmentType ? `Employment: ${d.employmentType}` : '',
    d.deadline ? `Closes: ${d.deadline}` : '',
  ].filter(Boolean);
  return {
    status: 200,
    job: {
      url: d.url || String(idOrUrl),
      title: d.title || '',
      company: d.company || '',
      location: d.location || '',
      platform: name,
      apply_link: d.applyUrl || d.apply_link || '',
      description: [...facts, d.description, `[Full text from the ${name} portal.]`].join('\n\n'),
    },
  };
}

module.exports = { config, cliPath, bunAvailable, search, detail, CONFIG_FILE };

// Quick check from the command line: node scripts/portals.js [term]
if (require.main === module) {
  const cfg = config();
  console.log(`portals dir: ${cfg.dir}${fs.existsSync(cfg.dir) ? '' : '  (not found)'}`);
  console.log(`bun: ${bunAvailable() ? 'found' : 'NOT found (https://bun.sh)'}`);
  const names = Object.keys(cfg.portals);
  if (!names.length) console.log(`no portals configured in ${P.rel(CONFIG_FILE)}`);
  const term = process.argv[2];
  for (const name of names) {
    const cli = cliPath(name, cfg.dir);
    if (!cli || !term) { console.log(`  ${name}: ${cli ? 'ok' : 'NOT found'}`); continue; }
    const r = search(name, term, 7, { args: cfg.portals[name].args, limit: 5 });
    console.log(`  ${name}: ${r.status === 200 ? `${r.results.length} result(s)` : `${r.status} ${r.error || ''}`}`);
    for (const x of r.results) console.log(`      ${x.company || '?'} — ${x.title || '?'}  ${x.url}`);
  }
}
