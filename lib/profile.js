// The one place the engine learns who it is working for.
//
// Everything personal lives in a profile folder: identity and contact details
// (profile.json), the evidence and rules a letter is held to (PROFILE.md,
// STYLEGUIDE.md, warehouse.md), CV variants, prompts, search terms and the
// LaTeX templates that give letters and CVs their look.
//
// Everything else personal (applications, history, search state, built PDFs)
// lives in the workspace: $WORKSPACE_DIR, or this repo itself when unset.
//
//   <workspace>/profile/     your profile (when it has a profile.json)
//   <workspace>/active/      applications being written
//   <workspace>/submitted/   sent applications and their outcomes
//   <workspace>/archive/     parked applications
//   <workspace>/state/       seen vacancies, inbox, search windows, caches
//   <workspace>/output/      built CVs
//
// Pointing WORKSPACE_DIR at a separate private folder or repo keeps this repo
// free of personal data, so you can pull updates and send pull requests
// without sorting private from public files.
//
// Profile resolution order:
//   1. $PROFILE_DIR
//   2. <workspace>/profile/
//   3. examples/profile/     the fictitious example, so a fresh clone runs
//
// WORKSPACE_DIR and PROFILE_DIR may be set in the environment or in this
// repo's .env; relative paths resolve against this repo.

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

/** A setting from the environment, else from this repo's .env. */
function setting(name) {
  if (process.env[name]) return process.env[name];
  try {
    const text = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
    const m = text.match(new RegExp(`^\\s*${name}\\s*=\\s*(.*?)\\s*$`, 'm'));
    if (m && m[1]) return m[1].replace(/^["']|["']$/g, '');
  } catch { /* no .env */ }
  return null;
}

const WORKSPACE = setting('WORKSPACE_DIR') ? path.resolve(ROOT, setting('WORKSPACE_DIR')) : ROOT;

function resolveProfileDir() {
  if (setting('PROFILE_DIR')) return path.resolve(ROOT, setting('PROFILE_DIR'));
  const own = path.join(WORKSPACE, 'profile');
  if (fs.existsSync(path.join(own, 'profile.json'))) return own;
  return path.join(ROOT, 'examples', 'profile');
}

const PROFILE_DIR = resolveProfileDir();
const STATE_DIR = path.join(WORKSPACE, 'state');
const IS_EXAMPLE = PROFILE_DIR === path.join(ROOT, 'examples', 'profile');

/** Absolute path inside the workspace, e.g. workPath('active', 'Acme'). */
function workPath(...parts) {
  return path.join(WORKSPACE, ...parts);
}

/** A path for display: relative to the workspace or this repo, else absolute. */
function rel(p) {
  for (const base of [WORKSPACE, ROOT]) {
    const r = path.relative(base, p);
    if (!r.startsWith('..') && !path.isAbsolute(r)) return (r || '.').split(path.sep).join('/');
  }
  return p;
}

/** Absolute path inside the profile folder. */
function profilePath(...parts) {
  return path.join(PROFILE_DIR, ...parts);
}

/** Absolute path inside state/, creating state/ on first use. */
function statePath(...parts) {
  if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive: true });
  return path.join(STATE_DIR, ...parts);
}

let cached = null;
/** profile.json, parsed once. */
function profile() {
  if (cached) return cached;
  const file = profilePath('profile.json');
  if (!fs.existsSync(file)) {
    throw new Error(`No profile.json in ${PROFILE_DIR}. Copy examples/profile to profile/ and edit it.`);
  }
  cached = JSON.parse(fs.readFileSync(file, 'utf8'));
  return cached;
}

/** Name used in output file names, e.g. "RobinVale" in CV_RobinVale_2026.pdf. */
function fileName() {
  const p = profile();
  return p.file_name || String(p.name || 'Applicant').replace(/[^\p{L}\p{N}]+/gu, '');
}

/** A profile text file, or null when it does not exist. */
function readProfileFile(...parts) {
  const file = profilePath(...parts);
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
}

/** Directories that hold CV variants, most general first. */
function cvDirs() {
  const base = profilePath('cv');
  return [base, path.join(base, 'company')];
}

/** Source file of a CV variant, or null. */
function cvSourcePath(variant) {
  for (const dir of cvDirs()) {
    const p = path.join(dir, `${variant}.md`);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/** A LaTeX template from the profile, e.g. template('letter'). */
function template(name) {
  return profilePath('templates', `${name}.tex`);
}

/**
 * A pandoc metadata file holding the profile's identity, so templates can use
 * $sender.name$, $sender.email$ and so on. Written to state/ on each build;
 * values in a document's own frontmatter still win.
 */
function pandocMetadataFile() {
  const p = profile();
  const meta = { sender: p.sender || { name: p.name } };
  const file = statePath('pandoc-profile.json');
  fs.writeFileSync(file, JSON.stringify(meta, null, 2));
  return file;
}

module.exports = {
  ROOT, WORKSPACE, PROFILE_DIR, STATE_DIR, IS_EXAMPLE,
  workPath, rel, profile, profilePath, statePath, fileName, readProfileFile,
  cvDirs, cvSourcePath, template, pandocMetadataFile,
};
