// Shared building blocks for everything that hands a vacancy to a letter
// writer: `npm run prompt` / `npm run draft` (generate_draft.js) and
// `npm run pack` (pack.js). One place, so the context the API gets and the
// context you paste into a browser chat can't drift apart.

const fs = require('fs');
const path = require('path');

const P = require('../lib/profile.js');

const ROOT = P.ROOT;
const SUBMITTED = P.workPath('submitted');

function readIfExists(file) {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
}

/** Split "---\nyaml\n---\nbody" into [frontmatterText, body]. */
function splitFrontmatter(text) {
  const m = text.replace(/\r\n/g, '\n').match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  return m ? [m[1], m[2]] : ['', text];
}

function field(frontmatterText, key) {
  const m = frontmatterText.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'));
  return m ? m[1].trim().replace(/^["']|["']$/g, '') : null;
}

/** A `## Heading` section of a markdown file, up to the next `## `. */
function section(markdown, heading) {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const start = lines.findIndex((l) => l.trim() === `## ${heading}`);
  if (start === -1) return '';
  let end = lines.findIndex((l, i) => i > start && /^## /.test(l));
  if (end === -1) end = lines.length;
  return lines.slice(start, end).join('\n').trim();
}

/**
 * The letter-writing rules: the profile's STYLEGUIDE.md and PROFILE.md in
 * full. PROFILE.md holds identity, evidence, claim limits and lessons learned;
 * a letter writer needs all of it and nothing about commands or scrapers.
 */
function styleRules() {
  const parts = [];
  for (const file of ['STYLEGUIDE.md', 'PROFILE.md']) {
    const text = P.readProfileFile(file);
    if (text) parts.push(text.trim());
  }
  return parts.join('\n\n---\n\n');
}

const cvSourcePath = P.cvSourcePath;

/**
 * A CV variant as readable text. The sources are YAML + LaTeX macros
 * (\cventry{...}); a chat model reads plain lines far better, and you can
 * check at a glance what the letter writer was told.
 */
function cvAsText(variant) {
  const file = cvSourcePath(variant);
  if (!file) return null;
  const [fm, body] = splitFrontmatter(fs.readFileSync(file, 'utf8'));

  const out = [];
  const title = field(fm, 'title');
  if (title) out.push(`# ${P.profile().name} — ${title}`);
  // summary is a folded block (summary: >) on the following indented lines
  const sm = fm.match(/^summary:\s*>?-?\s*\n((?:[ \t]+.*\n?)+)/m);
  if (sm) out.push(sm[1].split('\n').map((l) => l.trim()).filter(Boolean).join(' '));

  const text = body
    .replace(/\\vspace\{[^}]*\}/g, '')
    .replace(/\\cvsection\{([^}]*)\}/g, '\n## $1')
    .replace(/\\cventry\{([^}]*)\}\{([^}]*)\}\{([^}]*)\}/g, '\n**$2** — $3 ($1)')
    .replace(/\\cvdesc\{([^}]*)\}/g, '- $1')
    .replace(/\\cveducation\{([^}]*)\}\{([^}]*)\}/g, '- $1: $2')
    .replace(/\\cvskill\{([^}]*)\}\{([^}]*)\}/g, '- **$1:** $2')
    .replace(/\\&/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  out.push(text);
  return out.join('\n\n');
}

// Application folders under submitted/, at any depth (pending/, invited/,
// invited/rejected/): the ones that hold a letter-input.md.
function collectSubmitted(dir = SUBMITTED, status = []) {
  const found = [];
  if (!fs.existsSync(dir)) return found;
  for (const entry of fs.readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (!fs.statSync(full).isDirectory()) continue;
    const li = path.join(full, 'letter-input.md');
    if (fs.existsSync(li)) {
      found.push({ folder: entry, status: status.join('/'), letterInput: li, mtime: fs.statSync(li).mtime });
    } else {
      found.push(...collectSubmitted(full, [...status, entry]));
    }
  }
  return found;
}

/**
 * Earlier sent letters that used the same CV variant, newest first -- the
 * closest thing to "letters for a similar role". Invited ones go first:
 * those are the letters that demonstrably worked.
 */
function exampleLetters(cvVariant, limit = 2) {
  const rank = (s) => (s.startsWith('invited') ? 0 : 1);
  return collectSubmitted()
    .map((a) => {
      const [fm, body] = splitFrontmatter(fs.readFileSync(a.letterInput, 'utf8'));
      return { ...a, cvVariant: field(fm, 'cv_variant'), position: field(fm, 'position'), body: body.trim() };
    })
    .filter((a) => a.cvVariant === cvVariant && a.body.length > 400)
    .sort((a, b) => rank(a.status) - rank(b.status) || b.mtime - a.mtime)
    .slice(0, limit);
}

module.exports = {
  ROOT, readIfExists, splitFrontmatter, field, section,
  styleRules, cvSourcePath, cvAsText, exampleLetters,
};
