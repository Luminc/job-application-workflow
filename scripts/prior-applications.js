// Find earlier applications to the same organisation.
//
// Matching is done on the `company_slug` frontmatter field, not on the folder
// name. Folder names get disambiguated by role when someone applies twice
// (Acme_Museum_Content_Editor), and prefix matching on names
// would wrongly link genuinely different organisations such as
// Acme and Acme_Labs.

const fs = require('fs');
const path = require('path');

const P = require('../lib/profile.js');
const ROOT = P.WORKSPACE;
const SUBMITTED = path.join(ROOT, 'submitted');

function readField(letterInput, field) {
  try {
    const text = fs.readFileSync(letterInput, 'utf8');
    const m = text.match(new RegExp(`^${field}:\\s*(.+)$`, 'm'));
    return m ? m[1].trim().replace(/^["']|["']$/g, '') : null;
  } catch {
    return null;
  }
}

// Walk submitted/ recursively; application folders are the ones holding a
// letter-input.md, at whatever depth (pending/, invited/, invited/rejected/).
function collectApplications(dir, relParts = []) {
  const found = [];
  if (!fs.existsSync(dir)) return found;

  for (const entry of fs.readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (!fs.statSync(full).isDirectory()) continue;

    const letterInput = path.join(full, 'letter-input.md');
    if (fs.existsSync(letterInput)) {
      found.push({
        folder: entry,
        status: relParts.join('/') || 'submitted',
        path: full,
        slug: readField(letterInput, 'company_slug') || entry,
        position: readField(letterInput, 'position'),
        // letter-input.md mtime, not the folder's: renaming a folder (which
        // happens when disambiguating by role) resets the directory mtime.
        date: fs.statSync(letterInput).mtime,
      });
    } else {
      found.push(...collectApplications(full, [...relParts, entry]));
    }
  }
  return found;
}

/**
 * Earlier applications to the same organisation as `companySlug`.
 * `excludePath` skips the application being processed right now.
 */
function findPriorApplications(companySlug, excludePath = null) {
  const target = String(companySlug).toLowerCase();
  return collectApplications(SUBMITTED)
    .filter(a => a.slug.toLowerCase() === target)
    .filter(a => !excludePath || path.resolve(a.path) !== path.resolve(excludePath))
    .sort((a, b) => b.date - a.date);
}

/** Turn a job title into a folder-name-safe suffix. */
function slugifyRole(position) {
  if (!position) return null;
  return position
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/&/g, 'en')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .split(/[\s-]+/)
    .slice(0, 3)
    .join('_');
}

/** Print a warning if this organisation has been applied to before. */
function warnIfPrior(companySlug, appPath) {
  const prior = findPriorApplications(companySlug, appPath);
  if (prior.length === 0) return prior;

  const plural = prior.length === 1 ? 'application' : 'applications';
  console.log(`⚠️  ${prior.length} earlier ${plural} to ${companySlug}:`);
  for (const p of prior) {
    const when = p.date.toISOString().slice(0, 10);
    console.log(`     ${p.position || '(role unknown)'}`);
    console.log(`       ${p.status} · ${when} · ${p.folder}`);
  }
  console.log(`   Make sure this letter does not repeat the earlier one, and`);
  console.log(`   consider referencing the previous contact if it makes sense.\n`);
  return prior;
}

module.exports = { findPriorApplications, slugifyRole, warnIfPrior };
