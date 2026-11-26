// Fill state/matches.json by reading vacancies in your own, logged-in Chrome
// through headless `claude -p --chrome` runs (Claude in Chrome extension).
//
// Why a browser: Indeed blocks scrapers on detail pages (401/403 as a guest)
// and logging in from an automated Chromium stalls on reCAPTCHA. Your everyday
// browser is already signed in to Indeed and LinkedIn. LinkedIn keyword
// searches and Nationale Vacaturebank (NL) need no browser at all.
//
// The model only does what needs a browser; everything deterministic lives
// here (2026-10-05, to cut tokens and make every decision auditable):
//
//   1. cards    model reads the result cards of each search page, judges nothing;
//               LinkedIn keyword searches skip the model and use LinkedIn's
//               public search endpoint (2026-10-07)
//   2. script   dedups on vacancy ID against seen/inbox and application
//               folders, triages the titles in one Haiku API call (rules in
//               chrome_triage_prompt.md), applies --max-details by priority
//               to browser pages only
//   3. details  LinkedIn via the public posting endpoint, the rest by the
//               model in Chrome (verbatim text)
//
// Own links (state/urls.txt) skip straight to step 3.
//
// Usage:  node scripts/chrome-fetch.js [--search] [--urls <bestand>]
//           [--queries quick|full|deep] [--term "..."]... [--pages N] [--days N]
//           [--max-details N] [--platforms indeed,linkedin,nvb] [--linkedin-browser]
//           [--linkedin-fallback-chrome] [--retriage] [--retriage-days N]
//           [--cards-model <naam>] [--model <naam>] [--effort <niveau>]
//           [--print-prompt] [--verbose]
//         npm run chrome-fetch     own links from state/urls.txt
//         npm run chrome-search    search round (terms in <profile>/search/queries.json)
//         npm run chrome-retriage  earlier title rejections through the current triage again
//
// Output is state/matches.json; npm run score scores and reviews it.

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const P = require('../lib/profile.js');
const ROOT = P.ROOT;
const SEARCH = P.profile().search || {};
// The API key is only for the triage call, so it is read from .env into a
// local value and never put in process.env: the headless `claude` sessions
// inherit process.env, and with ANTHROPIC_API_KEY set they authenticate with
// the key instead of the claude.ai login — which disables Claude in Chrome
// (found 2026-10-05). Also avoids depending on dotenv.
function envValue(name) {
  if (process.env[name]) return process.env[name];
  const file = path.join(ROOT, '.env');
  if (!fs.existsSync(file)) return null;
  for (const line of fs.readFileSync(file, 'utf-8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && m[1] === name) return m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return null;
}


const COMMON_PROMPT = path.join(__dirname, 'prompts', 'chrome_common.md');
const CARDS_PROMPT = path.join(__dirname, 'prompts', 'chrome_cards.md');
const DETAILS_PROMPT = path.join(__dirname, 'prompts', 'chrome_details.md');
const TRIAGE_PROMPT = P.profilePath('prompts', 'triage.md');
const TRIAGE_CONFIG = P.profilePath('search', 'triage.json');
const QUERIES_FILE = P.profilePath('search', 'queries.json');
const STATE_FILE = P.statePath('chrome_state.json');
const DEFAULT_URLS_FILE = P.statePath('urls.txt');
const OUT_FILE = P.statePath('matches.json');
const SEEN_FILE = P.statePath('seen.json');
const INBOX_FILE = P.statePath('inbox.json');
const COST_LOG = P.statePath('chrome_cost.log');  // one JSON line per session
// Sessions run in a working directory outside the project, so they don't load
// the project's CLAUDE.md and memory (thousands of tokens per turn they never
// use). Batch files land there and are copied to state/chrome_out for
// inspection after the run.
const BATCH_DIR = path.join(os.tmpdir(), 'chrome-fetch-work');
const DEBUG_DIR = P.statePath('chrome_out');

// Search pages per cards session. A page of cards is ~2 KB of snippet output,
// so this keeps a session small while not paying startup cost per page.
const PER_CARD_PAGES = 8;
// Detail pages per session. Each verbatim text is read once and written once,
// so this keeps a session's context and its Write call small.
const PER_BATCH_DETAILS = 10;

const TRIAGE_MODEL = process.env.TRIAGE_MODEL || 'claude-haiku-4-5';
// 80 per call let the model drift on the later cards (reasons shrank to two
// words, obvious keeps got rejected); 40 costs a few cents more per round.
const TRIAGE_CHUNK = 40;

const SHORT_DESCRIPTION_CHARS = 1200;

const ALLOWED_TOOLS = ['mcp__claude-in-chrome', 'Read', 'Write'];
// Measured 2026-10-05 on the same small task: $0.235 with defaults, $0.075 with
// these (48 tools instead of 232, only the Chrome MCP server, no skill list).
// Auto mode is what makes headless Chrome work at all: in default and even
// bypassPermissions mode every browser call is refused with "Claude in Chrome
// requires permission", because the extension's per-site approval needs a
// person; when the auto-mode classifier approves a call, the extension skips
// that check. Auto mode is not available on Haiku, so browser sessions run on
// Sonnet; the cheap model is used for triage, which needs no browser.
const SESSION_FLAGS = ['--permission-mode', 'auto', '--strict-mcp-config', '--disable-slash-commands',
  '--exclude-dynamic-system-prompt-sections'];

// Search area, from profile.json "search". Add the region to a town name
// ("Springfield, Example County"): an ambiguous name makes Indeed search wider.
const INDEED_DOMAIN = SEARCH.indeed_domain || 'www.indeed.com';
const INDEED_LOCATION = SEARCH.indeed_location || '';
const LINKEDIN_LOCATION = SEARCH.linkedin_location || INDEED_LOCATION;
const RADIUS_KM = SEARCH.radius_km || 25;
// LinkedIn's distance is in miles and only offers 5/10/25/50. The scorer's
// commute filter (home.max_commute_km) trims the wider net.
const LINKEDIN_DISTANCE_MI = SEARCH.linkedin_distance_mi || 25;
const DEFAULT_PLATFORMS = (SEARCH.platforms || ['indeed', 'linkedin']).join(',');

// Indeed's date filter only offers these steps in its UI; round the window
// up to the next one so the URL stays one Indeed itself would generate.
const DAY_STEPS = [1, 3, 7, 14];
const FIRST_RUN_DAYS = 7;

const BAD_STATUSES = ['logged_out', 'captcha', 'blocked', 'error', 'rate_limited', 'no_browser', 'skipped'];
const WALL_STATUSES = ['logged_out', 'captcha', 'blocked'];

function argValue(argv, flag) {
  const i = argv.indexOf(flag);
  return i !== -1 && argv[i + 1] !== undefined ? argv[i + 1] : null;
}

function argValues(argv, flag) {
  const out = [];
  argv.forEach((a, i) => { if (a === flag && argv[i + 1] !== undefined) out.push(argv[i + 1]); });
  return out;
}

function intArg(argv, flag, fallback) {
  const v = argValue(argv, flag);
  if (v === null) return fallback;
  const n = parseInt(v, 10);
  if (!Number.isFinite(n) || n < 1) {
    console.error(`[error] ${flag} expects a positive number, got "${v}"`);
    process.exit(1);
  }
  return n;
}

function readJson(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch (e) {
    console.warn(`  [!] ${path.basename(file)} is not readable: ${e.message}`);
    return fallback;
  }
}

// Indeed and LinkedIn URLs carry tracking params that differ per source
// (job boards add refId/trackingId), so dedup on the ID.
function vacancyId(url) {
  const jk = url.match(/indeed\.com\/.*[?&]jk=([0-9a-f]{16})/i);
  if (jk) return `indeed:${jk[1].toLowerCase()}`;
  const li = url.match(/linkedin\.com\/jobs\/view\/(?:[^/?]*-)?(\d{6,})/i);
  if (li) return `linkedin:${li[1]}`;
  const nvb = url.match(/nationalevacaturebank\.nl\/vacature\/([0-9a-f-]{36})/i);
  if (nvb) return `nvb:${nvb[1].toLowerCase()}`;
  return null;
}

// A card's raw ID as the snippet returned it; anything else is rejected
// rather than guessed, since a wrong ID silently breaks dedup.
function cardId(platform, raw) {
  const v = String(raw || '').trim();
  // Indeed sometimes renders a placeholder card with this jk (2026-10-05).
  // Indeed sometimes renders placeholder cards whose jk is a slice of the hex
  // sequence (123456789abcdef0, 789abcdef0123456; 2026-10-05).
  const placeholder = '0123456789abcdef'.repeat(2).includes(v.toLowerCase());
  if (platform === 'Indeed' && /^[0-9a-f]{16}$/i.test(v) && !placeholder) return `indeed:${v.toLowerCase()}`;
  if (platform === 'LinkedIn' && /^\d{6,}$/.test(v)) return `linkedin:${v}`;
  if (platform === 'NVB' && /^[0-9a-f-]{36}$/i.test(v)) return `nvb:${v.toLowerCase()}`;
  return null;
}

function canonicalUrl(id) {
  const [kind, v] = id.split(':');
  if (kind === 'indeed') return `https://${INDEED_DOMAIN}/viewjob?jk=${v}`;
  if (kind === 'nvb') return `https://www.nationalevacaturebank.nl/vacature/${v}`;
  return `https://www.linkedin.com/jobs/view/${v}/`;
}

const PLATFORM_BY_KIND = { linkedin: 'LinkedIn', indeed: 'Indeed', nvb: 'NVB' };
const platformOf = (id) => PLATFORM_BY_KIND[(id || '').split(':')[0]] || null;

function knownIds() {
  const ids = new Map();
  for (const file of [SEEN_FILE, INBOX_FILE]) {
    const data = readJson(file, {});
    for (const [url, entry] of Object.entries(data)) {
      const id = vacancyId(url);
      if (id) ids.set(id, (entry && entry.company) || '');
    }
  }
  // Applications started by hand (npm run new / prep) never pass through
  // seen.json; without this, they come back in the next search round.
  for (const [id, company] of applicationIds()) if (!ids.has(id)) ids.set(id, company);
  return ids;
}

// Title rejections are a soft decision (seen: "triaged", since 2026-10-08):
// they still count as known for the search, so a card is not triaged again
// every round, but an own link or --retriage may bring one back, and the
// scorer scores it then.
function softIds() {
  const out = new Set();
  for (const [url, entry] of Object.entries(readJson(SEEN_FILE, {}) || {})) {
    const id = vacancyId(url);
    if (id && entry && entry.decision === 'triaged') out.add(id);
  }
  return out;
}

const RETRIAGE_DAYS = 21;

function triagedEntries(days) {
  const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  const out = [];
  for (const [url, v] of Object.entries(readJson(SEEN_FILE, {}) || {})) {
    if (!v || v.decision !== 'triaged' || (v.seen_at || '') < since) continue;
    const id = vacancyId(url);
    if (!id) continue;
    const company = v.company || '';
    // The scorer stores chrome titles as "Company: Title".
    const title = company && (v.title || '').startsWith(`${company}: `) ? v.title.slice(company.length + 2) : (v.title || '');
    out.push({ id, title, company, location: v.location || '', platform: platformOf(id) });
  }
  return out;
}

function applicationIds() {
  const out = new Map();
  const dirs = [P.workPath('active'), P.workPath('archive', 'parked')];
  const submitted = P.workPath('submitted');
  if (fs.existsSync(submitted)) {
    for (const d of fs.readdirSync(submitted, { withFileTypes: true })) {
      if (d.isDirectory()) dirs.push(path.join(submitted, d.name));
    }
  }
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const file = path.join(dir, d.name, 'vacancy.md');
      if (!fs.existsSync(file)) continue;
      const head = fs.readFileSync(file, 'utf-8').slice(0, 2000);
      const id = vacancyId((head.match(/^url:\s*(\S+)/m) || [])[1] || '');
      if (id) out.set(id, d.name);
    }
  }
  return out;
}

function readUrls(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf-8').split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
}

// Comment processed URLs out instead of deleting them, so the file doubles
// as a log of what was fetched when.
function markDone(file, urls) {
  const today = new Date().toISOString().slice(0, 10);
  const done = new Set(urls);
  const lines = fs.readFileSync(file, 'utf-8').split(/\r?\n/)
    .map((l) => (done.has(l.trim()) ? `# ${today} ${l.trim()}` : l));
  fs.writeFileSync(file, lines.join('\n'));
}

function daysBetween(fromIso, to) {
  return Math.floor((to - new Date(`${fromIso}T00:00:00`)) / 86400000);
}

// The search window follows the last successful read of that platform +
// term instead of a fixed "last 3 days": skipping a week no longer leaves a
// hole, and a quick run doesn't shrink the window for terms it didn't cover.
// One day of overlap, since dedup on the vacancy ID makes overlap free.
function searchKey(platform, term) {
  return `${platform}|${term}`;
}

function windowDays(lastIso, explicit) {
  if (explicit) return explicit;
  if (!lastIso) return FIRST_RUN_DAYS;
  const gap = daysBetween(lastIso, new Date()) + 1;
  return DAY_STEPS.find((d) => d >= gap) || DAY_STEPS[DAY_STEPS.length - 1];
}

const PLATFORM_KEYS = { indeed: 'Indeed', linkedin: 'LinkedIn', nvb: 'NVB' };
const PLATFORM_ORDER = ['Indeed', 'LinkedIn', 'NVB'];
// Platforms read through the extension; all of them blocked = Chrome is down.
const CHROME_PLATFORMS = ['Indeed', 'LinkedIn'];

// terms: { indeed: [...], linkedin: [...], nvb: [...] }
function staleTerms(state, terms, platforms) {
  const max = DAY_STEPS[DAY_STEPS.length - 1];
  const out = [];
  for (const key of platforms) {
    const p = PLATFORM_KEYS[key];
    for (const t of terms[key] || []) {
      const last = (state.searches || {})[searchKey(p, t)];
      if (last && daysBetween(last, new Date()) + 1 > max) out.push(`${p} ${t ? `"${t}"` : '(recommended)'} (${last})`);
    }
  }
  return out;
}

// A preset is one list for every platform or an object per platform; Indeed
// costs a browser session per 8 pages while LinkedIn and NVB are free apart
// from triage, so their lists can be longer (2026-10-07).
function searchTerms(argv) {
  const perPlatform = (list) => Object.fromEntries(Object.keys(PLATFORM_KEYS).map((k) => [k, list]));
  const terms = argValues(argv, '--term');
  if (terms.length) return { terms: perPlatform(terms), label: `--term (${terms.length})` };
  const preset = argValue(argv, '--queries') || 'full';
  const presets = readJson(QUERIES_FILE, null);
  const value = presets && presets[preset];
  if (!value || typeof value !== 'object') {
    console.error(`[error] Preset "${preset}" not found in ${QUERIES_FILE} (quick|full|deep).`);
    process.exit(1);
  }
  if (Array.isArray(value)) return { terms: perPlatform(value), label: preset };
  return { terms: Object.fromEntries(Object.keys(PLATFORM_KEYS).map((k) => [k, value[k] || []])), label: preset };
}

function searchUrls(terms, platforms, pages, state, explicitDays) {
  const enc = encodeURIComponent;
  const out = [];
  const daysFor = (platform, term) => windowDays((state.searches || {})[searchKey(platform, term)], explicitDays);
  if (platforms.includes('indeed')) {
    for (const term of terms.indeed || []) {
      const days = daysFor('Indeed', term);
      for (let p = 0; p < pages; p++) {
        out.push({
          platform: 'Indeed', term, page: p + 1, days,
          url: `https://${INDEED_DOMAIN}/jobs?q=${enc(term)}&l=${enc(INDEED_LOCATION)}` +
               `&radius=${RADIUS_KM}&fromage=${days}` + (p ? `&start=${p * 10}` : ''),
        });
      }
    }
  }
  if (platforms.includes('linkedin')) {
    for (const term of terms.linkedin || []) {
      if (!term) {
        // No keyword = LinkedIn's own profile-based list. It has no date or
        // location filter; dedup and the distance filter in the scorer cover that.
        out.push({ platform: 'LinkedIn', term, page: 1, days: null, url: 'https://www.linkedin.com/jobs/collections/recommended/' });
        continue;
      }
      const days = daysFor('LinkedIn', term);
      for (let p = 0; p < pages; p++) {
        out.push({
          platform: 'LinkedIn', term, page: p + 1, days,
          url: `https://www.linkedin.com/jobs/search/?keywords=${enc(term)}` +
               `&location=${enc(LINKEDIN_LOCATION)}&distance=${LINKEDIN_DISTANCE_MI}` +
               `&f_TPR=r${days * 86400}` + (p ? `&start=${p * 25}` : ''),
        });
      }
    }
  }
  if (platforms.includes('nvb')) {
    // One entry per term: nvbSearch pages through the API itself and stops at
    // the edge of the search window, so --pages does not apply.
    for (const term of (terms.nvb || []).filter(Boolean)) {
      out.push({ platform: 'NVB', term, page: 1, days: daysFor('NVB', term), url: null });
    }
  }
  // Platform by platform, so a wall on one platform skips its remaining
  // sessions without touching the other.
  out.sort((a, b) => PLATFORM_ORDER.indexOf(a.platform) - PLATFORM_ORDER.indexOf(b.platform));
  out.forEach((s, i) => { s.nr = i + 1; });
  return out;
}

// matches.json is overwritten every run; carry over what the scorer
// never saw, so it isn't lost.
function unscoredPrevious(known) {
  const data = readJson(OUT_FILE, null);
  if (!data || !Array.isArray(data.jobs)) return [];
  return data.jobs.filter((j) => {
    const id = vacancyId(j.url || '');
    return id && !known.has(id);
  });
}

const termLabel = (t) => (t ? `"${t}"` : '(recommended)');

function chunk(list, n) {
  const out = [];
  for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n));
  return out;
}

function batchFile(name) {
  return path.join(BATCH_DIR, `${name}.json`);
}

function cardsPrompt(common, cards, pages, out) {
  const rel = path.basename(out);
  return `${common}\n\n${cards}\n\n## Mode\n\n` +
    `Search pages (${pages.length}), in this order:\n\n` +
    pages.map((s) => `- nr ${s.nr} | ${s.platform} | ${termLabel(s.term)} | p${s.page} | ${s.url}`).join('\n') +
    `\n\nWrite the output to \`${rel}\`.\n`;
}

function detailsPrompt(common, details, urls, out) {
  const rel = path.basename(out);
  return `${common}\n\n${details}\n\n## Mode\n\nURLs (${urls.length}):\n\n` +
    urls.map((u) => `- ${u}`).join('\n') +
    `\n\nWrite the output to \`${rel}\`.\n`;
}

// One headless session. JSON output so every session reports its cost and
// turns; they go to chrome_cost.log so tuning (model, effort, batch sizes)
// can be judged on numbers.
function runClaude(prompt, { model, effort, label, verbose }) {
  // Prompt via stdin: on Windows shell:true reparses argv through cmd.exe,
  // which mangles a multi-kilobyte prompt (hence stdin).
  const args = ['-p', '--chrome', ...SESSION_FLAGS, '--allowedTools', ...ALLOWED_TOOLS, '--model', model, '--output-format', 'json'];
  if (effort) args.push('--effort', effort);
  return new Promise((resolve) => {
    // Never hand the session an API key: it must run on the claude.ai login,
    // the only auth under which Claude in Chrome is available (see envValue).
    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY;
    const child = spawn('claude', args, {
      cwd: BATCH_DIR,
      env,
      stdio: ['pipe', 'pipe', 'inherit'],
      shell: process.platform === 'win32',
    });
    let stdout = '';
    child.stdin.on('error', () => {});
    child.stdin.write(prompt);
    child.stdin.end();
    child.stdout.on('data', (d) => { stdout += d; });
    child.on('error', (err) => {
      console.error(`\n[error] Could not start 'claude': ${err.message}`);
      resolve({ code: 1 });
    });
    child.on('close', (code) => {
      let res = null;
      try { res = JSON.parse(stdout.trim().split(/\r?\n/).pop()); } catch { /* not JSON */ }
      if (!res) {
        if (stdout.trim()) console.log(stdout.trim());
        resolve({ code });
        return;
      }
      const cost = res.total_cost_usd ?? null;
      const u = res.usage || {};
      const line = {
        at: new Date().toISOString(), label, model, effort: effort || null,
        cost_usd: cost, turns: res.num_turns ?? null, secs: res.duration_ms ? Math.round(res.duration_ms / 1000) : null,
        input: u.input_tokens ?? null, cache_read: u.cache_read_input_tokens ?? null,
        cache_write: u.cache_creation_input_tokens ?? null, output: u.output_tokens ?? null,
        error: res.is_error ? res.subtype || 'error' : null,
      };
      fs.appendFileSync(COST_LOG, JSON.stringify(line) + '\n');
      if (verbose && res.result) console.log(`  ${String(res.result).trim().replace(/\n/g, '\n  ')}`);
      resolve({ code: res.is_error ? 1 : code, cost, turns: line.turns });
    });
  });
}

function costNote(r) {
  return r.cost != null ? `$${r.cost.toFixed(3)}, ${r.turns} turns` : 'cost unknown';
}

// Title triage in one cheap API call instead of inside the browser session:
// the rules live in the profile's prompts/triage.md, every decision comes back with a
// reason, and nothing costs a browser turn. Fails open (keep everything) so
// an API problem never silently drops vacancies.
// Your own decisions as calibration for the title triage: roles you were
// invited for, roles you applied to, and roles you turned down after
// reading the full text. Titles only, newest first, so the prompt stays
// a few kilobytes.
const EXAMPLES_APPLIED = 40;
const EXAMPLES_NO = 30;

function frontmatterValue(file, key) {
  if (!fs.existsSync(file)) return '';
  const m = fs.readFileSync(file, 'utf-8').slice(0, 3000).match(new RegExp(`^${key}:\\s*(.+)$`, 'm'));
  return m ? m[1].trim().replace(/^["']|["']$/g, '') : '';
}

function applicationRoles(dirs) {
  const out = [];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!d.isDirectory() || ['accepted', 'rejected', 'withdrawn'].includes(d.name)) continue;
      const folder = path.join(dir, d.name);
      const position = frontmatterValue(path.join(folder, 'letter-input.md'), 'position')
        || frontmatterValue(path.join(folder, 'vacancy.md'), 'position');
      if (!position || position.startsWith('[')) continue;
      const company = frontmatterValue(path.join(folder, 'vacancy.md'), 'company') || d.name.replace(/_/g, ' ');
      out.push({ line: `${position} | ${company}`, mtime: fs.statSync(folder).mtimeMs });
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime).map((r) => r.line);
}

function triageExamples() {
  const sub = (...p) => P.workPath('submitted', ...p);
  const invited = applicationRoles([sub('invited'), sub('invited', 'accepted'), sub('invited', 'rejected')]);
  const invitedSet = new Set(invited);
  const applied = applicationRoles([sub('pending'), sub('rejected')])
    .filter((l) => !invitedSet.has(l)).slice(0, EXAMPLES_APPLIED);
  const seen = Object.values(readJson(SEEN_FILE, {}) || {});
  const no = seen.filter((v) => v && v.decision === 'no' && v.title)
    .slice(-EXAMPLES_NO).reverse().map((v) => `${v.title} | ${v.company || '?'}`);
  // Some sources put a whole text in the company field; cut every line to
  // a card's length.
  const short = (l) => (l.length > 120 ? `${l.slice(0, 117)}...` : l);
  const block = (head, lines) => (lines.length ? `\n### ${head}\n${lines.map((l) => `- ${short(l)}`).join('\n')}\n` : '');
  return `\n\n## Calibration: what ${P.profile().name || 'the candidate'} chose before\n` +
    'Title | organisation. Use this to recognise what fits; the rules above take precedence, ' +
    'also where older applications were broader.\n' +
    block('Invited to an interview (strongest signal)', invited) +
    block('Applied (most recent first)', applied) +
    block('No, after reading the full text', no);
}

// The rejection rules as codes, read from the prompt's list ("- `code` —"
// before "## Never reject"), so the prompt stays the single place they live.
function triageRules(text) {
  const section = text.split(/^## (Never reject|Nooit afwijzen)/m)[0];
  return [...section.matchAll(/^- `([a-z_]+)` —/gm)].map((m) => m[1]);
}

// Backstop for the prompt's "Never reject" list: a valid code is not enough
// when the title itself names that work (a small model rejected a copywriter
// as marketing and a textbook author as teaching). The patterns live in the
// profile's search/triage.json; keep them narrow ("museum" would also keep the
// museum's dishwasher). Rules listed in rules_over_keep (junior, region...)
// still reject such a title.
const TRIAGE_CFG = readJson(TRIAGE_CONFIG, {});
const NEVER_REJECT = (TRIAGE_CFG.never_reject || []).length
  ? new RegExp(TRIAGE_CFG.never_reject.join('|'), 'i') : null;
const TITLE_RULES_OVER_KEEP = TRIAGE_CFG.rules_over_keep || [];

// The triage is a coarse first sieve; the scorer and you judge quality. So a
// rejection only counts when it names one of the prompt's rules: small models
// invent reasons the prompt never gave ("no technical component"). Without a
// valid code the card is kept.
async function triage(cands) {
  const keepAll = (reason) => cands.map((c) => ({ ...c, keep: true, priority: 3, reason }));
  if (!cands.length) return [];
  const apiKey = envValue('ANTHROPIC_API_KEY');
  if (!apiKey) {
    console.warn('  [!] No ANTHROPIC_API_KEY in .env: no triage, everything kept.');
    return keepAll('no triage (no API key)');
  }
  if (!fs.existsSync(TRIAGE_PROMPT)) {
    console.warn(`  [!] No ${TRIAGE_PROMPT}: no triage, everything kept.`);
    return keepAll('no triage (no prompt)');
  }
  const prompt = fs.readFileSync(TRIAGE_PROMPT, 'utf-8');
  const codes = triageRules(prompt);
  if (!codes.length) {
    console.warn(`  [!] No rule codes found in ${TRIAGE_PROMPT}: no triage, everything kept.`);
    return keepAll('no triage (no rule codes)');
  }
  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey });
  const rules = prompt + triageExamples();
  const tool = {
    name: 'triage',
    description: 'One decision per card: keep or reject, with a reason and a priority.',
    input_schema: {
      type: 'object',
      properties: {
        decisions: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              nr: { type: 'integer' },
              keep: { type: 'boolean' },
              rule: { type: 'string', enum: codes, description: 'when rejecting: the rule code; omit when keeping' },
              priority: { type: 'integer', enum: [1, 2, 3] },
              reason: { type: 'string', description: 'a few words' },
            },
            required: ['nr', 'keep', 'reason'],
          },
        },
      },
      required: ['decisions'],
    },
  };
  const out = [];
  for (const part of chunk(cands, TRIAGE_CHUNK)) {
    const lines = part.map((c, i) => `${i + 1}. ${c.title} | ${c.company} | ${c.location} | ${c.platform}`).join('\n');
    try {
      const msg = await client.messages.create({
        model: TRIAGE_MODEL,
        max_tokens: 8000,
        system: rules,
        tools: [tool],
        tool_choice: { type: 'tool', name: 'triage' },
        messages: [{ role: 'user', content: `Triage these ${part.length} cards; give exactly one decision per nr.\n\n${lines}` }],
      });
      const decisions = (msg.content.find((b) => b.type === 'tool_use') || {}).input?.decisions || [];
      const byNr = new Map(decisions.map((d) => [d.nr, d]));
      part.forEach((c, i) => {
        const d = byNr.get(i + 1);
        if (!d) { out.push({ ...c, keep: true, priority: 3, reason: 'no triage decision' }); return; }
        if (d.keep === false && !codes.includes(d.rule)) {
          out.push({ ...c, keep: true, priority: 3, reason: `rejection without a valid rule: ${d.reason || '?'}` });
          return;
        }
        if (d.keep === false && NEVER_REJECT && !TITLE_RULES_OVER_KEEP.includes(d.rule) && NEVER_REJECT.test(c.title || '')) {
          out.push({ ...c, keep: true, priority: 2, reason: `never reject (title), triage said ${d.rule}: ${d.reason || '?'}` });
          return;
        }
        out.push({ ...c, keep: d.keep !== false, priority: d.priority || 3, rule: d.keep === false ? d.rule : undefined, reason: d.reason || '' });
      });
    } catch (e) {
      console.warn(`  [!] Triage failed (${e.message}); ${part.length} cards kept.`);
      out.push(...part.map((c) => ({ ...c, keep: true, priority: 3, reason: 'no triage (API error)' })));
    }
  }
  return out;
}

// LinkedIn detail pages don't render in a background tab (the description
// stays a grey skeleton, 2026-10-05), but LinkedIn's public job-posting
// endpoint serves the same description as server-rendered HTML without login.
// Fetching it here costs no model tokens at all; anything that fails falls
// back to a Chrome session.
const LINKEDIN_GUEST_DELAY_MS = 1500;
// LinkedIn's public endpoints rate-limit after roughly 70 requests in a few
// minutes. Falling back to Chrome costs an 80-turn session per 8 pages. Now: a slower, jittered pace, a backoff when the limit hits,
// and whatever is still refused waits for the next run.
const LINKEDIN_PACE_MS = [2500, 4000];
const LINKEDIN_BACKOFF_MS = [30000, 90000];
const RATE_LIMITED = [429, 999];
const linkedinPause = () => sleep(LINKEDIN_PACE_MS[0] + Math.random() * (LINKEDIN_PACE_MS[1] - LINKEDIN_PACE_MS[0]));

async function linkedinFetch(url) {
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(url, { headers: { 'User-Agent': BROWSER_UA, 'Accept-Language': SEARCH.accept_language || 'en;q=0.9' } });
    } catch {
      return { status: 0 };
    }
    if (!RATE_LIMITED.includes(res.status) || attempt >= LINKEDIN_BACKOFF_MS.length) return res;
    const wait = LINKEDIN_BACKOFF_MS[attempt];
    console.log(`  (LinkedIn is rate limiting: waiting ${Math.round(wait / 1000)} s)`);
    await sleep(wait);
  }
}
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function htmlText(html) {
  const entities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };
  return String(html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|li|h\d|ul|ol|div)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+|#39);/gi, (m, e) => {
      if (entities[e]) return entities[e];
      if (/^#x/i.test(e)) return String.fromCodePoint(parseInt(e.slice(2), 16));
      if (/^#\d/.test(e)) return String.fromCodePoint(parseInt(e.slice(1), 10));
      return m;
    })
    .split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n');
}

// Contents of the first <div> whose class starts with `cls`, counting nested
// divs: a lazy regex stops at the first inner </div> and cut descriptions
// to a few hundred characters.
function innerDiv(html, cls) {
  const start = html.search(new RegExp(`<div class="${cls}[^"]*"[^>]*>`));
  if (start < 0) return null;
  const open = html.indexOf('>', start) + 1;
  const tag = /<(\/?)div\b[^>]*>/gi;
  tag.lastIndex = open;
  let depth = 1;
  for (let m; (m = tag.exec(html));) {
    depth += m[1] ? -1 : 1;
    if (depth === 0) return html.slice(open, m.index);
  }
  return html.slice(open);
}

async function linkedinGuest(id) {
  const res = await linkedinFetch(`https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/${id.split(':')[1]}`);
  if (!res.ok) return { status: res.status };
  const html = await res.text();
  const markup = innerDiv(html, 'show-more-less-html__markup');
  if (!markup) return { status: 'no text' };
  const one = (re) => htmlText((html.match(re) || [])[1]).replace(/\n/g, ' ');
  const criteria = [...html.matchAll(/description__job-criteria-subheader">([\s\S]*?)<\/h3>\s*<span[^>]*>([\s\S]*?)<\/span>/g)]
    .map((m) => `${htmlText(m[1])}: ${htmlText(m[2])}`);
  const body = htmlText(markup).split('\n').join('\n\n');
  return {
    status: 200,
    job: {
      url: canonicalUrl(id),
      title: one(/<h2[^>]*top-card-layout__title[^>]*>([\s\S]*?)<\/h2>/),
      company: one(/topcard__org-name-link[^>]*>([\s\S]*?)<\/a>/),
      location: one(/<span class="topcard__flavor topcard__flavor--bullet">([\s\S]*?)<\/span>/),
      platform: 'LinkedIn',
      apply_link: '',
      description: [...criteria, body, '[Full text fetched from the public LinkedIn job page.]'].join('\n\n'),
    },
  };
}

// LinkedIn keyword searches without a browser: the public search endpoint
// returns server-rendered cards, 10 per request, paged by `start` in steps of
// 10. Reading them in Chrome cost more than half of a run's money and time.
// The profile-based "Recommended for you" list needs the login and stays in
// Chrome.
const LINKEDIN_GUEST_PAGE = 10;

async function linkedinGuestSearch(term, days, maxResults) {
  const enc = encodeURIComponent;
  const cards = [];
  for (let start = 0; start < maxResults; start += LINKEDIN_GUEST_PAGE) {
    if (start) await linkedinPause();
    const res = await linkedinFetch('https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search' +
      `?keywords=${enc(term)}&location=${enc(LINKEDIN_LOCATION)}&distance=${LINKEDIN_DISTANCE_MI}` +
      `&f_TPR=r${days * 86400}&start=${start}`);
    // Past the last result LinkedIn answers 400 instead of an empty list.
    if (res.status === 400 && start) break;
    if (!res.ok) return { status: res.status, cards };
    const html = await res.text();
    const chunks = html.split(/<li[^>]*>/).slice(1);
    let n = 0;
    for (const c of chunks) {
      const id = (c.match(/urn:li:jobPosting:(\d{6,})/) || [])[1];
      if (!id) continue;
      const one = (re) => htmlText((c.match(re) || [])[1]).replace(/\n/g, ' ');
      cards.push([
        id,
        one(/base-search-card__title[^>]*>([\s\S]*?)<\/h3>/),
        one(/base-search-card__subtitle[^>]*>([\s\S]*?)<\/h4>/),
        one(/job-search-card__location[^>]*>([\s\S]*?)<\/span>/),
      ]);
      n += 1;
    }
    if (n < LINKEDIN_GUEST_PAGE) break;
  }
  return { status: 200, cards };
}

// Nationale Vacaturebank (Netherlands, DPG Media) without a browser. Optional:
// enable it with "nvb" in profile.json search.platforms and search.nvb. the site's own JSON
// API answers without login or Cloudflare and returns the full vacancy text,
// salary, hours and deadline in the search result itself, so NVB needs no
// detail step (2026-10-07). `query` is free text over title and description;
// sorted by date, paging stops at the edge of the search window. The website
// itself sits behind a DPG consent wall, the API does not.
const NVB_API = 'https://api.nationalevacaturebank.nl/api/jobs/v3/sites/nationalevacaturebank.nl/jobs';
const NVB = SEARCH.nvb || {};
const NVB_LAT_LON = `latitude:${NVB.lat} longitude:${NVB.lon}`;
const NVB_DISTANCE_KM = NVB.distance_km || 30;
const NVB_PAGE = 50;
const NVB_MAX_PAGES = 4;

async function nvbSearch(term, days) {
  const since = Date.now() - days * 86400000;
  const jobs = [];
  for (let page = 1; page <= NVB_MAX_PAGES; page++) {
    if (page > 1) await sleep(LINKEDIN_GUEST_DELAY_MS);
    const filters = `${NVB_LAT_LON} distance:${NVB_DISTANCE_KM}`;
    let res;
    try {
      res = await fetch(`${NVB_API}?page=${page}&limit=${NVB_PAGE}&sort=date` +
        `&query=${encodeURIComponent(term)}&filters=${encodeURIComponent(filters)}`, {
        headers: { 'User-Agent': BROWSER_UA, Accept: 'application/json', 'Accept-Language': 'nl-NL,nl;q=0.9' },
      });
    } catch {
      return { status: 0, jobs };
    }
    if (!res.ok) return { status: res.status, jobs };
    let data;
    try { data = await res.json(); } catch { return { status: 'no json', jobs }; }
    const batch = ((data._embedded || {}).jobs) || [];
    let older = false;
    for (const j of batch) {
      if (Date.parse(j.startDate || '') < since) { older = true; continue; }
      jobs.push(j);
    }
    if (older || batch.length < NVB_PAGE || page >= (data.pages || 0)) break;
  }
  return { status: 200, jobs };
}

// One NVB vacancy by ID, for own links and --retriage: the same record as in
// the search result, so no browser and no consent wall.
async function nvbById(id) {
  try {
    const res = await fetch(`${NVB_API}/${id.split(':')[1]}`, {
      headers: { 'User-Agent': BROWSER_UA, Accept: 'application/json', 'Accept-Language': 'nl-NL,nl;q=0.9' },
    });
    if (!res.ok) return { status: res.status };
    return { status: 200, job: nvbJob(await res.json()) };
  } catch {
    return { status: 0 };
  }
}

// An NVB API record as a matches job: the key facts first, then the
// employer's text, so the scorer sees hours and salary even in a long text.
function nvbJob(j) {
  const loc = j.workLocation || {};
  const s = j.salary || {};
  const h = j.workingHours || {};
  const facts = [
    s.min || s.max ? `Salary: €${s.min || '?'} - €${s.max || '?'} (${s.type || 'per month'})` : '',
    h.min || h.max ? `Hours: ${h.min || '?'} - ${h.max || '?'} per week` : '',
    (j.contractTypes || []).length ? `Contract: ${j.contractTypes.join(', ')}` : '',
    j.careerLevel ? `Level: ${j.careerLevel}` : '',
    (j.educationLevels || []).length ? `Education: ${j.educationLevels.join(', ')}` : '',
    j.endDate ? `Closes: ${j.endDate.slice(0, 10)}` : '',
  ].filter(Boolean);
  return {
    url: canonicalUrl(`nvb:${j.id}`),
    title: j.title || j.functionTitle || '',
    company: (j.company || {}).name || '',
    location: loc.city || '',
    platform: 'Nationale Vacaturebank',
    apply_link: (j.apply || {}).url || '',
    description: [...facts, htmlText(j.description).split('\n').join('\n\n'),
      '[Full text fetched from the Nationale Vacaturebank API.]'].join('\n\n'),
  };
}

// A security check or login wall needs a person: Claude doesn't solve
// CAPTCHAs, and the sessions work in a background tab group where a check goes
// unnoticed. The session leaves that tab open and stops; this asks you to
// solve it and then retries. A topmost dialog rather than a toast, because a
// toast disappears while the run is waiting.
const MAX_WALL_RETRIES = 2;
const WAIT_STATUSES = ['captcha', 'logged_out', 'no_browser'];

const HUMAN_MESSAGES = {
  captcha: (p) => [`${p} asks for a security check (Cloudflare/CAPTCHA).`,
    "Solve it in Chrome: the tab is open in Claude's tab group."],
  logged_out: (p) => [`You are logged out of ${p}.`, `Log in to ${p} again in Chrome.`],
  no_browser: () => ['The Claude extension in Chrome is not responding.',
    'Open Chrome and check via the Claude icon that the extension is connected.'],
  no_chrome: () => ['Chrome is not open.', 'Start Chrome; the Claude extension must be connected.'],
};

function askHuman(platform, status) {
  const [what, todo] = HUMAN_MESSAGES[status](platform);
  console.error(`\x07\n  [!] ${what} ${todo}\n      Waiting for the dialog: OK = retry, Cancel = skip ${platform}.`);
  if (process.platform !== 'win32') {
    const r = spawnSync('bash', ['-c', 'read -r -p "  Enter = retry, s + Enter = skip: " a </dev/tty; [ "$a" != s ]'], { stdio: 'inherit' });
    return r.status === 0;
  }
  const text = `${what}\n\n${todo}\n\nOK = retry\nCancel = skip ${platform} for this round`;
  // DefaultDesktopOnly keeps the box on top of every window until clicked.
  const psText = text.split('\n').map((l) => `'${l.replace(/'/g, "''")}'`).join(' + [char]10 + ');
  const ps = 'Add-Type -AssemblyName System.Windows.Forms; ' +
    `$r = [System.Windows.Forms.MessageBox]::Show((${psText}), 'chrome-fetch: ${platform}', 'OKCancel', 'Warning', 'Button1', 'DefaultDesktopOnly'); ` +
    "if ($r -eq 'OK') { exit 0 } else { exit 1 }";
  const r = spawnSync('powershell.exe', ['-NoProfile', '-Command', ps], { stdio: 'ignore' });
  return r.status === 0;
}

// Chrome not running used to cost a full round of sessions that each gave up
// after a few turns and marked every page "error", without a dialog. A process check is free;
// null means it could not be checked, which counts as running.
function chromeRunning() {
  const r = process.platform === 'win32'
    ? spawnSync('tasklist', ['/FI', 'IMAGENAME eq chrome.exe', '/NH'], { encoding: 'utf-8' })
    : spawnSync('pgrep', ['-x', process.platform === 'darwin' ? 'Google Chrome' : 'chrome'], { encoding: 'utf-8' });
  if (r.error) return null;
  return process.platform === 'win32' ? /chrome\.exe/i.test(r.stdout || '') : r.status === 0;
}

// Checked once, right before the first browser session; false = no Chrome
// sessions this run.
let chromeChecked = null;
function ensureChrome() {
  if (chromeChecked !== null) return chromeChecked;
  for (let attempt = 0; ; attempt++) {
    if (process.env.CHROME_FETCH_SIMULATE_WALL !== 'no_chrome' && chromeRunning() !== false) return (chromeChecked = true);
    if (attempt >= MAX_WALL_RETRIES || !askHuman('Chrome', 'no_chrome')) return (chromeChecked = false);
  }
}

// A session in which every page or URL came back "error" and nothing was read
// means the extension is not answering (Chrome open, extension disconnected)
// rather than a problem with those pages.
function looksDisconnected(statuses, found) {
  return !found && statuses.length > 0 && statuses.every((st) => st === 'error' || st === 'no_browser');
}

// Test hook: CHROME_FETCH_SIMULATE_WALL=cards|details makes the first attempt
// of the first batch of that kind come back as a CAPTCHA without starting a
// session, so the dialog and retry can be tested without a real Cloudflare page.
let simulated = false;
function simulateWall(kind, b) {
  if (simulated || b.retry || process.env.CHROME_FETCH_SIMULATE_WALL !== kind) return null;
  simulated = true;
  const data = kind === 'cards'
    ? { pages: b.pages.map((s) => ({ nr: s.nr, status: 'captcha', cards: [] })) }
    : { jobs: [], expired: [], status: 'captcha' };
  fs.writeFileSync(b.out, JSON.stringify(data));
  console.log('  (simulated security check)');
  return { code: 0, cost: 0, turns: 0 };
}

function checkJobs(jobs) {
  const missing = jobs.filter((j) => !j.url || !j.description);
  if (missing.length) console.error(`\n[!] ${missing.length} of ${jobs.length} vacancies lack a url or description.`);
  const short = jobs.filter((j) => (j.description || '').length < SHORT_DESCRIPTION_CHARS);
  if (short.length) {
    console.error(`\n[!] ${short.length} description(s) shorter than ${SHORT_DESCRIPTION_CHARS} characters — possibly summarised:`);
    for (const j of short) console.error(`      ${(j.description || '').length} chars  ${j.company} — ${j.title}`);
  }
  const badIds = jobs.filter((j) => !vacancyId(j.url || ''));
  if (badIds.length) {
    console.error(`\n[!] ${badIds.length} URL(s) without a recognisable Indeed/LinkedIn ID — deduplication won't work for them:`);
    for (const j of badIds) console.error(`      ${j.url}`);
  }
}

function report(merged, cappedKeys) {
  const { searches, capped, expired } = merged.run;
  if (searches.length) {
    console.log('\n  Search round:');
    for (const s of searches) {
      const counts = ['results', 'seen', 'triaged_out', 'opened'].map((k) => `${k} ${s[k] ?? '?'}`).join(', ');
      const flag = BAD_STATUSES.includes(s.status) ? '  <-- [!]' : '';
      const layout = s.layout ? `  [${s.layout}]` : '';
      console.log(`    ${(s.platform || '?').padEnd(8)} ${termLabel(s.term)} p${s.page || 1}: ${s.status || '?'} (${counts})${layout}${flag}`);
    }
  }
  const bad = searches.filter((s) => BAD_STATUSES.includes(s.status));
  if (bad.length) {
    console.error(`\n  [!] ${bad.length} search page(s) not read (${[...new Set(bad.map((s) => s.platform))].join(', ')}).`);
    if (bad.some((s) => s.status === 'logged_out')) console.error('      Log in to that platform in Chrome again and rerun the search.');
    if (bad.some((s) => s.status === 'captcha')) console.error('      There was a CAPTCHA or security check; solve it yourself in Chrome.');
    if (bad.some((s) => s.status === 'rate_limited')) console.error('      LinkedIn rate limited; those terms keep their search window and come back next run.');
    if (bad.some((s) => ['no_browser', 'skipped'].includes(s.status))) {
      console.error('      Chrome or the Claude extension was unreachable; those terms keep their search window and come back next run.');
    }
  }
  if (capped.length) {
    console.error(`\n  [!] ${capped.length} candidate(s) not opened (max-details or failed session):`);
    for (const c of capped) console.error(`      ${c.company || '?'} — ${c.title || '?'}`);
    console.error('      The next run picks them up (the search window of those terms does not move).');
  }
  if (merged.triaged_out.length) {
    // Shown so a too-strict triage is visible; npm run score records these as
    // "triaged", which npm run chrome-retriage can still revisit.
    console.log(`\n  Dropped on title (${merged.triaged_out.length}) — npm run score records them as triaged (revisable with chrome-retriage):`);
    for (const t of merged.triaged_out) {
      const rule = t.rule ? `${t.rule}: ` : '';
      console.log(`      ${(t.platform || '').padEnd(8)} ${t.company || '?'} — ${t.title || '?'}  [${rule}${t.reason || ''}]`);
    }
  }
  if (expired.length) console.log(`\n  Expired/removed: ${expired.length}`);

  // A platform + term window only moves on when all its pages were read and
  // nothing was left behind for it.
  const byKey = new Map();
  for (const s of searches) {
    const k = searchKey(s.platform, s.term || '');
    byKey.set(k, (byKey.get(k) ?? true) && ['ok', 'empty'].includes(s.status));
  }
  return [...byKey].filter(([k, ok]) => ok && !cappedKeys.has(k)).map(([k]) => k);
}

async function main() {
  const argv = process.argv;
  const verbose = argv.includes('--verbose');
  const search = argv.includes('--search');
  const printOnly = argv.includes('--print-prompt');
  const detailModel = argValue(argv, '--model') || process.env.CHROME_FETCH_MODEL || 'sonnet';
  const cardsModel = argValue(argv, '--cards-model') || process.env.CHROME_CARDS_MODEL || 'sonnet';
  const effort = argValue(argv, '--effort') || process.env.CHROME_FETCH_EFFORT || null;
  const urlsFile = argValue(argv, '--urls') ? path.resolve(argValue(argv, '--urls')) : DEFAULT_URLS_FILE;
  const fileUrls = readUrls(urlsFile);
  const urls = [...fileUrls];
  const retriage = argv.includes('--retriage');

  if (!urls.length && !search && !retriage) {
    console.error(`[error] No URLs in ${P.rel(urlsFile)} and no --search or --retriage.`);
    console.error('       Put your links there (one per line, # = comment) or run npm run chrome-search.');
    process.exit(1);
  }

  const known = knownIds();
  const soft = softIds();
  // Decisions that stand: everything known except the soft title rejections.
  const hard = new Map([...known].filter(([id]) => !soft.has(id)));

  // --retriage: earlier title rejections judged again by the current prompt
  // and calibration; what passes now is fetched like an own link and scored
  // by the next npm run score. For after a change to prompts/triage.md.
  if (retriage) {
    const days = intArg(argv, '--retriage-days', RETRIAGE_DAYS);
    const cands = triagedEntries(days);
    console.log(`[retriage] ${cands.length} title rejection(s) from the last ${days} days through the triage again ...`);
    const again = (await triage(cands)).filter((d) => d.keep).sort((a, b) => a.priority - b.priority);
    console.log(`  ${again.length} pass now:`);
    for (const c of again) console.log(`      p${c.priority} ${c.company || '?'} — ${c.title || '?'}  [${c.reason || ''}]`);
    const have = new Set(urls.map((u) => vacancyId(u)));
    urls.push(...again.filter((c) => !have.has(c.id)).map((c) => canonicalUrl(c.id)));
    if (!urls.length && !search) { console.log('\n[OK] Nothing to fetch.'); return; }
  }
  // Unscored finds from an earlier run are carried over instead of being
  // overwritten: matches.json is a holding area until npm run score moves
  // them into the inbox (state/inbox.json).
  const previous = readJson(OUT_FILE, {}) || {};
  const leftover = unscoredPrevious(hard);
  const leftoverTriage = (Array.isArray(previous.triaged_out) ? previous.triaged_out : [])
    .filter((t) => { const id = vacancyId(t.url || ''); return id && !known.has(id); });
  if (leftover.length) {
    console.log(`  ${leftover.length} unscored vacancies from the previous run carried over.`);
  }

  const alreadySeen = urls.filter((u) => hard.has(vacancyId(u) || ''));
  if (alreadySeen.length) {
    console.warn(`\n  [!] ${alreadySeen.length} URL(s) already in seen/inbox; the scorer skips them:`);
    for (const u of alreadySeen) console.warn(`      ${u}  (${known.get(vacancyId(u))})`);
    console.warn('      To score them again, remove them from state/seen.json first.');
  }

  const state = readJson(STATE_FILE, {});
  const maxDetails = intArg(argv, '--max-details', 40);
  let list = [];
  let plan = null;
  if (search) {
    const { terms, label } = searchTerms(argv);
    const pages = intArg(argv, '--pages', 2);
    const platforms = (argValue(argv, '--platforms') || DEFAULT_PLATFORMS).toLowerCase().split(',').map((s) => s.trim());
    const explicitDays = argValue(argv, '--days') !== null ? intArg(argv, '--days', FIRST_RUN_DAYS) : null;
    list = searchUrls(terms, platforms, pages, state, explicitDays);
    const windows = [...new Set(list.map((s) => s.days).filter(Boolean))].sort((a, b) => a - b);
    plan = { label, terms, pages, platforms, windows };
    const stale = explicitDays ? [] : staleTerms(state, terms, platforms);
    if (stale.length) {
      console.warn(`  [!] Not searched for more than ${DAY_STEPS[DAY_STEPS.length - 1]} days; older vacancies fall outside this round:`);
      for (const t of stale) console.warn(`      ${t}`);
    }
  }

  const common = fs.readFileSync(COMMON_PROMPT, 'utf-8');
  const cardsText = fs.readFileSync(CARDS_PROMPT, 'utf-8');
  const detailsText = fs.readFileSync(DETAILS_PROMPT, 'utf-8');
  // LinkedIn keyword pages go through the public endpoint (linkedinGuestSearch);
  // only the logged-in "Recommended" list needs Chrome. --linkedin-browser
  // restores the old route.
  const guestPages = argv.includes('--linkedin-browser') ? []
    : list.filter((s) => s.platform === 'LinkedIn' && s.term);
  const cardBatches = [];
  for (const platform of ['Indeed', 'LinkedIn']) {
    chunk(list.filter((s) => s.platform === platform && !guestPages.includes(s)), PER_CARD_PAGES)
      .forEach((pages) => cardBatches.push({ platform, pages }));
  }
  const numberBatches = () => cardBatches.forEach((b, i) => {
    b.out = b.out || batchFile(`cards-${String(i + 1).padStart(2, '0')}`);
  });
  numberBatches();

  if (printOnly) {
    for (const b of cardBatches) {
      process.stdout.write(`\n===== ${path.basename(b.out)} (${cardsModel}) =====\n`);
      process.stdout.write(cardsPrompt(common, cardsText, b.pages, b.out));
    }
    chunk(urls, PER_BATCH_DETAILS).forEach((part, i) => {
      const out = batchFile(`urls-${String(i + 1).padStart(2, '0')}`);
      process.stdout.write(`\n===== ${path.basename(out)} (${detailModel}) =====\n`);
      process.stdout.write(detailsPrompt(common, detailsText, part, out));
    });
    if (search) process.stdout.write('\n(The detail batches of a search round only exist after the triage.)\n');
    return;
  }

  if (fs.existsSync(OUT_FILE)) {
    const backup = OUT_FILE.replace(/\.json$/, '.previous.json');
    fs.copyFileSync(OUT_FILE, backup);
    console.log(`  previous export kept as ${path.basename(backup)}`);
  }
  fs.rmSync(BATCH_DIR, { recursive: true, force: true });
  fs.mkdirSync(BATCH_DIR, { recursive: true });

  console.log('\n[Chrome] starting headless claude sessions...');
  console.log(`  models: cards ${cardsModel}, details ${detailModel}${effort ? `, effort ${effort}` : ''}`);
  if (urls.length) console.log(`  own URLs: ${urls.length}`);
  if (plan) {
    const counts = plan.platforms.map((k) => `${PLATFORM_KEYS[k] || k} ${(plan.terms[k] || []).length}`).join(', ');
    console.log(`  search round: ${plan.label} — terms: ${counts}; ${plan.pages} page(s) per term; ` +
                `${cardBatches.length} card session(s) in Chrome, the rest without a browser`);
    console.log(`  search window: ${plan.windows.join('/') || '-'} days (per term, since the last successful round), max ${maxDetails} detail pages in Chrome`);
  }
  // Without Indeed, the recommended list or own links other than LinkedIn and
  // NVB nothing needs a browser.
  const browserUrls = urls.filter((u) => !['LinkedIn', 'NVB'].includes(platformOf(vacancyId(u) || '')));
  if (cardBatches.length || browserUrls.length || list.some((s) => s.platform === 'Indeed')) {
    console.log('  Chrome must be open with the Claude extension connected.\n');
  } else console.log('');

  const merged = {
    generated_at: new Date().toISOString().slice(0, 10),
    loops: { manual: { label: 'Claude in Chrome', cv_variant: '' } },
    jobs: [],
    triaged_out: [],
    run: { searches: [], capped: [], expired: [] },
  };
  const fetched = new Set();      // IDs written to jobs this run
  const triagedIds = new Set();
  for (const j of leftover) {
    merged.jobs.push(j);
    fetched.add(vacancyId(j.url));
  }
  for (const t of leftoverTriage) {
    const id = vacancyId(t.url);
    if (fetched.has(id) || triagedIds.has(id)) continue;
    triagedIds.add(id);
    merged.triaged_out.push(t);
  }
  const blocked = new Set();
  const chromeDown = () => CHROME_PLATFORMS.every((p) => blocked.has(p));
  const doneUrls = [];
  const started = Date.now();
  let totalCost = 0;
  const addCost = (r) => { if (r.cost != null) totalCost += r.cost; };

  // ── 1. Cards ────────────────────────────────────────────────────────────────
  const pageStats = new Map();    // nr -> { ...search, status, results, seen, ids: [] }
  for (const s of list) pageStats.set(s.nr, { platform: s.platform, term: s.term, page: s.page, status: 'error', results: 0, seen: 0, ids: [] });  // ids: first sightings only
  const cards = new Map();        // id -> { id, title, company, location, platform, keys: Set }

  // One card from either route; true when it is new this run.
  const addCard = (platform, st, search, parts) => {
    const id = cardId(platform, parts[0]);
    if (!id) return false;
    st.results += 1;
    // triagedIds holds rejections from an earlier, not yet scored run:
    // they are decided, so they count as seen instead of being re-triaged.
    if (known.has(id) || fetched.has(id) || triagedIds.has(id)) { st.seen += 1; return false; }
    const [, title = '', company = '', location = ''] = parts;
    let isNew = false;
    if (!cards.has(id)) {
      cards.set(id, { id, title, company, location, platform, keys: new Set() });
      st.ids.push(id);
      isNew = true;
    } else st.seen += 1;  // on an earlier page this run
    cards.get(id).keys.add(searchKey(search.platform, search.term));
    return isNew;
  };

  // 1a. LinkedIn keyword searches without a browser. A page here is 25
  // results, the size of a LinkedIn page in Chrome, so --pages means the same
  // on both routes. A term that fails keeps its search window and comes back
  // next run; --linkedin-fallback-chrome sends it to a Chrome session instead.
  if (guestPages.length) {
    const t0 = Date.now();
    const terms = [...new Set(guestPages.map((s) => s.term))];
    console.log(`[LinkedIn direct] ${terms.length} search term(s) via the public search page ...`);
    let n = 0;
    let stopped = false;
    const fallback = [];
    for (const term of terms) {
      const pages = guestPages.filter((s) => s.term === term);
      if (stopped) { pages.forEach((s) => { pageStats.get(s.nr).status = 'rate_limited'; }); continue; }
      const r = await linkedinGuestSearch(term, pages[0].days, pages.length * 25);
      if (r.status !== 200) {
        const limited = RATE_LIMITED.includes(r.status);
        if (limited) stopped = true;
        pages.forEach((s) => { pageStats.get(s.nr).status = limited ? 'rate_limited' : 'error'; });
        if (argv.includes('--linkedin-fallback-chrome')) fallback.push(...pages);
        continue;
      }
      pages.forEach((s) => { pageStats.get(s.nr).status = 'empty'; });
      r.cards.forEach((parts, i) => {
        const s = pages[Math.min(Math.floor(i / 25), pages.length - 1)];
        const st = pageStats.get(s.nr);
        st.status = 'ok';
        if (addCard('LinkedIn', st, s, parts)) n += 1;
      });
      await linkedinPause();
    }
    const mins = ((Date.now() - t0) / 60000).toFixed(1);
    const unread = guestPages.filter((s) => ['rate_limited', 'error'].includes(pageStats.get(s.nr).status));
    console.log(`  ${n} new card(s), ${mins} min` +
                (unread.length ? `; ${unread.length} page(s) not read${stopped ? ' (LinkedIn rate limit)' : ''}` +
                  (fallback.length ? ', via Chrome' : ', next run') : ''));
    chunk(fallback, PER_CARD_PAGES).forEach((pages) => cardBatches.push({ platform: 'LinkedIn', pages }));
    numberBatches();
  }

  // 1b. Nationale Vacaturebank via its API. The search result already holds
  // the full text, kept here until triage decides what goes to the scorer.
  const nvbFull = new Map();      // id -> matches job
  const nvbPages = list.filter((s) => s.platform === 'NVB');
  if (nvbPages.length) {
    const t0 = Date.now();
    console.log(`[NVB] ${nvbPages.length} search term(s) via the API ...`);
    let n = 0;
    let failed = 0;
    for (const s of nvbPages) {
      const r = await nvbSearch(s.term, s.days);
      const st = pageStats.get(s.nr);
      if (r.status !== 200) { failed += 1; continue; }
      st.status = r.jobs.length ? 'ok' : 'empty';
      for (const j of r.jobs) {
        if (addCard('NVB', st, s, [j.id, j.title || j.functionTitle, (j.company || {}).name, (j.workLocation || {}).city])) n += 1;
        const id = cardId('NVB', j.id);
        if (id && !nvbFull.has(id)) nvbFull.set(id, nvbJob(j));
      }
      await sleep(LINKEDIN_GUEST_DELAY_MS);
    }
    const mins = ((Date.now() - t0) / 60000).toFixed(1);
    console.log(`  ${n} new card(s), ${mins} min${failed ? `; ${failed} term(s) failed` : ''}`);
  }

  // Batches are appended to while iterating: a wall the user solved queues a
  // retry of the unread pages right after the current batch.
  for (const [i, b] of cardBatches.entries()) {
    const tag = `[cards ${i + 1}/${cardBatches.length}] ${b.platform} ${b.pages.length} page(s)` +
                (b.retry ? ` (attempt ${b.retry + 1})` : '');
    if (!blocked.has(b.platform) && !ensureChrome()) CHROME_PLATFORMS.forEach((p) => blocked.add(p));
    if (blocked.has(b.platform)) {
      for (const s of b.pages) pageStats.get(s.nr).status = 'skipped';
      console.log(`${tag}: skipped (${chromeChecked === false ? 'Chrome not open' : `${b.platform} blocked`})`);
      continue;
    }
    const t0 = Date.now();
    console.log(`${tag} ...`);
    const r = simulateWall('cards', b)
      || await runClaude(cardsPrompt(common, cardsText, b.pages, b.out), { model: cardsModel, effort, label: `cards ${b.platform}`, verbose });
    addCost(r);
    const data = r.code === 0 ? readJson(b.out, null) : null;
    const mins = ((Date.now() - t0) / 60000).toFixed(1);
    if (!data || !Array.isArray(data.pages)) {
      console.error(`  [!] failed (${r.code !== 0 ? `exit ${r.code}` : `no valid ${path.basename(b.out)}`}, ${mins} min, ${costNote(r)})`);
      continue;
    }
    let n = 0;
    let wall = null;
    for (const p of data.pages) {
      const st = pageStats.get(p.nr);
      if (!st || st.platform !== b.platform) continue;
      st.status = p.status || 'error';
      if (WAIT_STATUSES.includes(st.status)) wall = wall || st.status;
      else if (WALL_STATUSES.includes(st.status)) blocked.add(b.platform);
      // LinkedIn's new layout ignores the location in the URL and uses the
      // location saved in the account.
      if (p.layout === 'new') {
        st.layout = `new: ${p.location || '?'}`;
        const town = LINKEDIN_LOCATION.split(',')[0].trim().toLowerCase();
        if (town && !(p.location || '').toLowerCase().includes(town)) {
          console.warn(`  [!] LinkedIn (new layout) searches around "${p.location || '?'}" — set your location in LinkedIn itself to ${LINKEDIN_LOCATION}.`);
        }
      }
      const search = list[p.nr - 1];
      for (const c of Array.isArray(p.cards) ? p.cards : []) {
        // Cards arrive as "id | title | company | location" lines (fewer
        // output tokens than JSON arrays); arrays are still accepted.
        const parts = typeof c === 'string' ? c.split('|').map((x) => x.trim())
          : Array.isArray(c) ? c : [c.id, c.title, c.company, c.location];
        if (addCard(b.platform, st, search, parts)) n += 1;
      }
    }
    const pageCards = data.pages.reduce((sum, p) => sum + (Array.isArray(p.cards) ? p.cards.length : 0), 0);
    if (looksDisconnected(b.pages.map((s) => pageStats.get(s.nr).status), pageCards)) {
      wall = 'no_browser';
      b.pages.forEach((s) => { pageStats.get(s.nr).status = 'no_browser'; });
    }
    console.log(`  ${n} new card(s), ${mins} min, ${costNote(r)}${blocked.size ? `; blocked: ${[...blocked].join(', ')}` : ''}`);
    if (wall) {
      const unread = b.pages.filter((s) => !['ok', 'empty'].includes(pageStats.get(s.nr).status));
      const retry = (b.retry || 0) + 1;
      if (unread.length && retry <= MAX_WALL_RETRIES && askHuman(b.platform, wall)) {
        cardBatches.splice(i + 1, 0, { platform: b.platform, pages: unread, retry, out: b.out.replace(/\.json$/, `-r${retry}.json`) });
      } else if (wall === 'no_browser') {
        // The extension serves every platform: no point in the other sessions.
        CHROME_PLATFORMS.forEach((p) => blocked.add(p));
      } else {
        blocked.add(b.platform);
      }
    }
  }

  // ── 2. Triage + cap ─────────────────────────────────────────────────────────
  const decided = await triage([...cards.values()]);
  const keep = decided.filter((d) => d.keep);
  for (const d of decided.filter((x) => !x.keep)) {
    triagedIds.add(d.id);
    merged.triaged_out.push({ url: canonicalUrl(d.id), title: d.title, company: d.company, location: d.location, platform: d.platform, rule: d.rule, reason: d.reason });
  }
  // Highest priority first; ties keep search order (Map insertion order).
  keep.sort((a, b) => a.priority - b.priority);
  // --max-details limits browser sessions only. LinkedIn details come from the
  // public endpoint at no cost, so all of them are opened.
  const liKeep = keep.filter((c) => c.platform === 'LinkedIn');
  const otherKeep = keep.filter((c) => c.platform === 'Indeed');
  const toOpen = [...liKeep, ...otherKeep.slice(0, maxDetails)];
  const cappedCards = otherKeep.slice(maxDetails);
  // NVB needs no detail step: the full text came with the search result.
  for (const c of keep.filter((x) => x.platform === 'NVB')) {
    const job = nvbFull.get(c.id);
    if (!job || fetched.has(c.id)) continue;
    fetched.add(c.id);
    merged.jobs.push({ ...job, job_title: job.title, search_id: 'manual', cv_variant: '', source: 'nvb' });
  }
  if (cards.size) {
    console.log(`\n[triage] ${cards.size} new cards: ${keep.length} kept, ${decided.length - keep.length} rejected` +
                (cappedCards.length ? `, ${cappedCards.length} over --max-details` : ''));
  }

  // ── 3. Details ──────────────────────────────────────────────────────────────
  const expiredIds = new Set();
  const isLinkedIn = (u) => platformOf(vacancyId(u) || '') === 'LinkedIn';

  // 3a. LinkedIn without a browser (see linkedinGuest).
  const liTargets = [
    ...urls.filter(isLinkedIn).map((u) => ({ id: vacancyId(u), own: u })),
    ...toOpen.filter((c) => c.platform === 'LinkedIn').map((c) => ({ id: c.id })),
  ];
  const liLeft = [];
  if (liTargets.length) {
    console.log(`\n[LinkedIn direct] ${liTargets.length} vacancies via the public job page ...`);
    let stopped = false;
    let ok = 0;
    const rateLimited = [];
    for (const t of liTargets) {
      if (stopped) { rateLimited.push(t); continue; }
      if (fetched.has(t.id)) continue;
      const r = await linkedinGuest(t.id);
      if (r.job) {
        fetched.add(t.id);
        merged.jobs.push({ ...r.job, job_title: r.job.title, search_id: 'manual', cv_variant: '', source: 'linkedin-guest' });
        if (t.own) doneUrls.push(t.own);
        ok += 1;
      } else if (r.status === 404 || r.status === 410) {
        merged.run.expired.push(canonicalUrl(t.id));
        expiredIds.add(t.id);
        if (t.own) doneUrls.push(t.own);
      } else {
        // Rate limited: not to Chrome (a session per 10 on the subscription);
        // they show up as capped and come back next run. Own links still go.
        if (RATE_LIMITED.includes(r.status)) { stopped = true; rateLimited.push(t); } else liLeft.push(t);
      }
      await linkedinPause();
    }
    liLeft.push(...rateLimited.filter((t) => t.own));
    console.log(`  ${ok} fetched, ${liLeft.length} via Chrome` +
                (rateLimited.length ? `, ${rateLimited.filter((t) => !t.own).length} next run (LinkedIn rate limit)` : ''));
  }

  // 3b. Own NVB links through the API; only a failure goes to Chrome.
  const isNvb = (u) => platformOf(vacancyId(u) || '') === 'NVB';
  const nvbLeft = [];
  for (const u of urls.filter(isNvb)) {
    const id = vacancyId(u);
    if (fetched.has(id)) continue;
    const r = await nvbById(id);
    if (r.job) {
      fetched.add(id);
      merged.jobs.push({ ...r.job, job_title: r.job.title, search_id: 'manual', cv_variant: '', source: 'nvb' });
      doneUrls.push(u);
    } else if (r.status === 404 || r.status === 410) {
      merged.run.expired.push(u);
      expiredIds.add(id);
      doneUrls.push(u);
    } else nvbLeft.push(u);
    await sleep(LINKEDIN_GUEST_DELAY_MS);
  }

  // 3c. Everything else through Chrome.
  const detailBatches = [];
  const ownForChrome = [...urls.filter((u) => !isLinkedIn(u) && !isNvb(u)), ...nvbLeft,
    ...liLeft.filter((t) => t.own).map((t) => t.own)];
  chunk(ownForChrome, PER_BATCH_DETAILS).forEach((part) => detailBatches.push({ kind: 'urls', platform: null, urls: part }));
  const indeedOpen = toOpen.filter((c) => c.platform === 'Indeed').map((c) => canonicalUrl(c.id));
  const forChrome = {
    Indeed: indeedOpen,
    // LinkedIn falls back to Chrome only within what is left of the cap; the
    // rest is reported as capped and comes back next run.
    LinkedIn: liLeft.filter((t) => !t.own).map((t) => canonicalUrl(t.id))
      .slice(0, Math.max(0, maxDetails - indeedOpen.length)),
  };
  for (const platform of ['Indeed', 'LinkedIn']) {
    chunk(forChrome[platform], PER_BATCH_DETAILS).forEach((part) => detailBatches.push({ kind: 'search', platform, urls: part }));
  }
  detailBatches.forEach((b, i) => { b.out = batchFile(`details-${String(i + 1).padStart(2, '0')}`); });

  for (const [i, b] of detailBatches.entries()) {
    const tag = `[details ${i + 1}/${detailBatches.length}] ${b.kind === 'urls' ? 'own URLs' : b.platform} ${b.urls.length}` +
                (b.retry ? ` (attempt ${b.retry + 1})` : '');
    if (!(b.platform && blocked.has(b.platform)) && !chromeDown() && !ensureChrome()) CHROME_PLATFORMS.forEach((p) => blocked.add(p));
    if (chromeDown() || (b.platform && blocked.has(b.platform))) {
      console.log(`${tag}: skipped (${chromeChecked === false ? 'Chrome not open' : `${b.platform || 'Chrome'} blocked`})`);
      continue;
    }
    const t0 = Date.now();
    console.log(`${tag} ...`);
    const r = simulateWall('details', b)
      || await runClaude(detailsPrompt(common, detailsText, b.urls, b.out), { model: detailModel, effort, label: `details ${b.platform || 'urls'}`, verbose });
    addCost(r);
    const data = r.code === 0 ? readJson(b.out, null) : null;
    const mins = ((Date.now() - t0) / 60000).toFixed(1);
    if (!data || !Array.isArray(data.jobs)) {
      console.error(`  [!] failed (${r.code !== 0 ? `exit ${r.code}` : `no valid ${path.basename(b.out)}`}, ${mins} min, ${costNote(r)})`);
      continue;
    }
    const expiredHere = Array.isArray(data.expired) ? data.expired.length : 0;
    const wall = WAIT_STATUSES.includes(data.status) ? data.status
      : looksDisconnected([data.status || 'ok'], data.jobs.length + expiredHere) ? 'no_browser' : null;
    if (!wall && WALL_STATUSES.includes(data.status) && b.platform) blocked.add(b.platform);
    let added = 0;
    for (const j of data.jobs) {
      const id = vacancyId(j.url || '');
      if (id && (hard.has(id) || fetched.has(id))) continue;
      if (id) fetched.add(id);
      merged.jobs.push({
        ...j, job_title: j.job_title || j.title, search_id: 'manual', cv_variant: '', source: 'chrome',
      });
      added += 1;
    }
    for (const u of Array.isArray(data.expired) ? data.expired : []) {
      merged.run.expired.push(u);
      const id = vacancyId(u);
      if (id) expiredIds.add(id);
    }
    const unread = wall ? b.urls.filter((u) => { const id = vacancyId(u); return !id || (!fetched.has(id) && !expiredIds.has(id)); }) : [];
    if (b.kind === 'urls') doneUrls.push(...b.urls.filter((u) => !unread.includes(u)));
    console.log(`  ${added} vacancies, ${mins} min, ${costNote(r)}${blocked.size ? `; blocked: ${[...blocked].join(', ')}` : ''}`);
    if (wall && unread.length) {
      const platform = b.platform || platformOf(vacancyId(unread[0]) || '') || 'the site';
      const retry = (b.retry || 0) + 1;
      if (retry <= MAX_WALL_RETRIES && askHuman(platform, wall)) {
        detailBatches.splice(i + 1, 0, { ...b, urls: unread, retry, out: b.out.replace(/\.json$/, `-r${retry}.json`) });
      } else if (wall === 'no_browser') {
        CHROME_PLATFORMS.forEach((p) => blocked.add(p));
      } else if (b.platform) {
        blocked.add(b.platform);
      }
    }
  }

  // Anything meant to be opened but not fetched (cap, failed or skipped
  // session) stays open: its search window does not move, so the next run
  // finds it again.
  const cappedKeys = new Set();
  for (const c of keep) {
    if (fetched.has(c.id) || expiredIds.has(c.id)) continue;
    merged.run.capped.push({ url: canonicalUrl(c.id), title: c.title, company: c.company });
    c.keys.forEach((k) => cappedKeys.add(k));
  }
  for (const s of list) {
    const st = pageStats.get(s.nr);
    const ids = new Set(st.ids);
    merged.run.searches.push({
      platform: st.platform, term: st.term, page: st.page, status: st.status, layout: st.layout,
      results: st.results, seen: st.seen,
      triaged_out: decided.filter((d) => !d.keep && ids.has(d.id)).length,
      opened: [...ids].filter((id) => fetched.has(id) && cards.has(id)).length,
    });
  }
  merged.triaged_out = merged.triaged_out.filter((t) => !fetched.has(vacancyId(t.url || '')));

  fs.writeFileSync(OUT_FILE, JSON.stringify(merged, null, 2) + '\n');
  fs.rmSync(DEBUG_DIR, { recursive: true, force: true });
  fs.cpSync(BATCH_DIR, DEBUG_DIR, { recursive: true });
  console.log(`\n  run time: ${((Date.now() - started) / 60000).toFixed(1)} min, cost: $${totalCost.toFixed(2)} (per session in state/${path.basename(COST_LOG)})`);

  checkJobs(merged.jobs);
  const doneOwn = doneUrls.filter((u) => fileUrls.includes(u));
  if (doneOwn.length) markDone(urlsFile, doneOwn);

  if (plan) {
    const done = report(merged, cappedKeys);
    if (done.length) {
      const today = new Date().toISOString().slice(0, 10);
      const searches = { ...(state.searches || {}) };
      for (const k of done) searches[k] = today;
      fs.writeFileSync(STATE_FILE, JSON.stringify({ ...state, searches }, null, 2) + '\n');
    }
    const termKeys = new Set(list.map((s) => searchKey(s.platform, s.term)));
    if (done.length < termKeys.size) {
      console.error(`\n  Search window moved on for ${done.length} of ${termKeys.size} platform/term combinations.`);
    }
  }

  console.log(`\n[OK] ${merged.jobs.length} vacancies in state/${path.basename(OUT_FILE)}` +
              (merged.triaged_out.length ? ` (+${merged.triaged_out.length} dropped on title)` : ''));
  console.log('     Next: npm run score (score + review)');
}

if (require.main === module) main();
else module.exports = { triage, triageRules, triagedEntries, nvbById, chromeRunning, cardId, canonicalUrl, searchUrls, linkedinGuest, linkedinGuestSearch, applicationIds, triageExamples, nvbSearch };
