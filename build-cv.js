// Build every CV variant in the profile's cv/ folder to output/cv/.
// Usage: npm run build-cv [-- --force] [variant ...]

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { runLayoutCheck } = require('./scripts/layout-guard.js');
const P = require('./lib/profile.js');

const OUTPUT_DIR = path.join(P.WORKSPACE, 'output', 'cv');

function parseFrontmatter(content) {
  const m = content.replace(/\r\n/g, '\n').match(/^---\n([\s\S]*?)\n---/);
  if (!m) return {};
  const out = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([a-z0-9_-]+)\s*:\s*(.*)$/i);
    if (kv) out[kv[1].toLowerCase()] = kv[2].trim();
  }
  return out;
}

function isUpToDate(output, sources) {
  if (!fs.existsSync(output)) return false;
  const built = fs.statSync(output).mtimeMs;
  return sources.every((s) => !fs.existsSync(s) || fs.statSync(s).mtimeMs <= built);
}

function getPdfPageCount(filePath) {
  try {
    const matches = fs.readFileSync(filePath, 'binary').match(/\/Type\s*\/Page[^s]/g);
    return matches ? matches.length : null;
  } catch {
    return null;
  }
}

function buildCV(inputFile, forceRebuild = false) {
  const variant = path.basename(inputFile, '.md');
  const year = new Date().getFullYear();
  const outputFile = path.join(OUTPUT_DIR, `CV_${P.fileName()}_${year}_${variant}.pdf`);
  const template = P.template('cv');

  console.log(`\n📄 ${variant}`);

  if (!forceRebuild && isUpToDate(outputFile, [inputFile, template, P.profilePath('profile.json')])) {
    console.log(`   ⊘ up to date`);
    return true;
  }

  try {
    execSync(
      `pandoc "${inputFile}" -o "${outputFile}" --template="${template}" ` +
      `--metadata-file="${P.pandocMetadataFile()}" --pdf-engine=lualatex`,
      { cwd: P.PROFILE_DIR, stdio: 'inherit' }
    );

    const sizeKB = (fs.statSync(outputFile).size / 1024).toFixed(1);
    // Default limit is one page; a variant opts into more with max_pages.
    const fm = parseFrontmatter(fs.readFileSync(inputFile, 'utf-8'));
    const maxPages = parseInt(fm.max_pages, 10) || 1;
    const pageCount = getPdfPageCount(outputFile);
    if (pageCount !== null && pageCount > maxPages) {
      console.error(`   ⚠️  ${pageCount} pages — limit is ${maxPages}. Trim ${P.rel(inputFile)} or set max_pages.`);
      return false;
    }

    console.log(`   ✓ ${P.rel(outputFile)} (${sizeKB} KB, ${pageCount ?? '?'} page${pageCount === 1 ? '' : 's'})`);
    runLayoutCheck(outputFile);
    return true;
  } catch (error) {
    console.error(`   ✗ Failed: ${error.message}`);
    return false;
  }
}

function main() {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const only = args.filter((a) => !a.startsWith('--'));

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const files = [];
  for (const dir of P.cvDirs()) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.md') || f.toLowerCase() === 'readme.md') continue;
      if (only.length && !only.includes(path.basename(f, '.md'))) continue;
      files.push(path.join(dir, f));
    }
  }

  if (!files.length) {
    console.log(`ℹ️  No CV variants found in ${P.rel(P.profilePath('cv'))}/`);
    return;
  }

  let failed = 0;
  for (const f of files) if (!buildCV(f, force)) failed++;

  console.log(`\n${files.length - failed}/${files.length} built`);
  if (failed) process.exit(1);
}

if (require.main === module) main();

module.exports = { buildCV };
