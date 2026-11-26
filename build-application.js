// Build application materials for a specific company
// Usage: npm run build CompanyName   (no name: every folder in active/)

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { runLayoutCheck } = require('./scripts/layout-guard.js');
const P = require('./lib/profile.js');

function findApplication(companySlug) {
  const activeDir = path.join(P.WORKSPACE, 'active');

  if (!fs.existsSync(activeDir)) {
    console.log('❌ active/ directory not found');
    return null;
  }

  const folders = fs.readdirSync(activeDir).filter(f => {
    return fs.statSync(path.join(activeDir, f)).isDirectory();
  });

  if (folders.includes(companySlug)) return companySlug;

  const match = folders.find(f => f.toLowerCase() === companySlug.toLowerCase());
  if (match) return match;

  console.log(`❌ Application not found: ${companySlug}`);
  console.log(`\nAvailable applications:`);
  folders.forEach(f => console.log(`  - ${f}`));
  return null;
}

function parseFrontmatter(content) {
  const normalised = content.replace(/\r\n/g, '\n');
  const frontmatterMatch = normalised.match(/^---\n([\s\S]*?)\n---/);
  if (!frontmatterMatch) return {};

  const frontmatter = {};
  const lines = frontmatterMatch[1].split('\n');
  let currentKey = null;

  for (const line of lines) {
    if (line.match(/^[a-z_]+:/)) {
      const [key, ...valueParts] = line.split(':');
      currentKey = key.trim();
      const value = valueParts.join(':').trim();
      frontmatter[currentKey] = value || [];
    } else if (currentKey && line.trim().startsWith('-')) {
      if (!Array.isArray(frontmatter[currentKey])) frontmatter[currentKey] = [];
      frontmatter[currentKey].push(line.trim().substring(1).trim());
    }
  }

  return frontmatter;
}

// Rebuild whenever a source is newer than the PDF. "Output exists" alone
// meant an edited letter or CV variant silently kept its old PDF.
function isUpToDate(output, sources) {
  if (!fs.existsSync(output)) return false;
  const built = fs.statSync(output).mtimeMs;
  return sources.every((s) => !fs.existsSync(s) || fs.statSync(s).mtimeMs <= built);
}

function getPdfPageCount(filePath) {
  try {
    const data = fs.readFileSync(filePath, 'binary');
    const matches = data.match(/\/Type\s*\/Page[^s]/g);
    return matches ? matches.length : null;
  } catch {
    return null;
  }
}

// Reports how much content actually spills past page 1: the rendered lines
// (and word count) pdftotext places after the first form-feed. Page count
// alone doesn't tell you whether you're 20 words over or a whole paragraph.
function getPdfOverflow(filePath) {
  try {
    const text = execSync(`pdftotext -layout "${filePath}" -`, { encoding: 'utf-8' });
    const pages = text.split('\f').filter((page, i, arr) => i < arr.length - 1 || page.trim());
    if (pages.length <= 1) return null;

    const overflowLines = pages.slice(1).join('\n')
      .split('\n')
      .map(l => l.trim())
      .filter(Boolean);
    const wordCount = overflowLines.join(' ').split(/\s+/).filter(Boolean).length;

    return { pages: pages.length, overflowLines, wordCount };
  } catch {
    return null;
  }
}

const letterFile = (companySlug) => `${companySlug}_${P.fileName()}.pdf`;

function buildLetter(appDir, companySlug, forceRebuild = false) {
  const letterInput = path.join(appDir, 'letter-input.md');
  const outputDir = path.join(appDir, 'outputs');
  const letterOutput = path.join(outputDir, letterFile(companySlug));

  if (!fs.existsSync(letterInput)) {
    console.log(`❌ Letter input not found: letter-input.md`);
    return false;
  }

  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  const templatePath = P.template('letter');
  if (!forceRebuild && isUpToDate(letterOutput, [letterInput, templatePath, P.profilePath('profile.json')])) {
    console.log(`\n✉️  Cover letter up to date. Skipping.`);
    return 'skipped';
  }

  console.log(`\n✉️  Building cover letter...`);
  console.log(`   Input:  letter-input.md`);
  console.log(`   Output: outputs/${letterFile(companySlug)}`);

  try {
    execSync(
      `pandoc "${letterInput}" -f markdown+hard_line_breaks -o "${letterOutput}" ` +
      `--template="${templatePath}" --metadata-file="${P.pandocMetadataFile()}" ` +
      `--resource-path="${P.PROFILE_DIR}" --pdf-engine=lualatex`,
      { cwd: appDir, stdio: 'inherit' }
    );

    const fileSizeKB = (fs.statSync(letterOutput).size / 1024).toFixed(1);

    const overflow = getPdfOverflow(letterOutput);
    if (overflow) {
      console.log(`   ✅ Generated (${fileSizeKB} KB)`);
      console.error(`   ⚠️  Letter is ${overflow.pages} pages — it must fit on one! ` +
        `${overflow.overflowLines.length} line(s) / ~${overflow.wordCount} words run onto page 2:`);
      overflow.overflowLines.forEach(l => console.error(`        "${l}"`));
      console.error(`      Shorten letter-input.md to fit on one page.`);
      return false;
    }

    console.log(`   ✅ Generated (${fileSizeKB} KB, 1 page)`);
    return true;
  } catch (error) {
    console.error(`   ❌ Failed to generate PDF`);
    return false;
  }
}

// Optional: statement-input.md, for vacancies that ask for a separate answer per
// requirement (agencies, public tenders). It is built in .build/ and appended to
// the letter PDF, so portals that take a single motivation file get it too.
function buildStatement(appDir, forceRebuild = false) {
  const input = path.join(appDir, 'statement-input.md');
  if (!fs.existsSync(input)) return 'absent';

  const buildDir = path.join(appDir, '.build');
  if (!fs.existsSync(buildDir)) fs.mkdirSync(buildDir, { recursive: true });
  const output = path.join(buildDir, 'statement.pdf');
  const templatePath = P.template('statement');
  if (!forceRebuild && isUpToDate(output, [input, templatePath])) {
    console.log(`\n📋 Statement up to date. Skipping.`);
    return 'skipped';
  }

  console.log(`\n📋 Building statement...`);
  try {
    execSync(
      `pandoc "${input}" -f markdown+hard_line_breaks -o "${output}" --template="${templatePath}" ` +
      `--metadata-file="${P.pandocMetadataFile()}" --pdf-engine=lualatex`,
      { cwd: appDir, stdio: 'inherit' }
    );
    if (!fs.existsSync(output) || fs.statSync(output).size < 1024) {
      console.error(`   ❌ Statement PDF is empty — check the pandoc output above`);
      return false;
    }
    const overflow = getPdfOverflow(output);
    if (overflow) {
      console.error(`   ⚠️  Statement is ${overflow.pages} pages — keep it to one.`);
      return false;
    }
    console.log(`   ✅ Generated (${(fs.statSync(output).size / 1024).toFixed(1)} KB, 1 page)`);
    return true;
  } catch (error) {
    console.error(`   ❌ Failed to generate statement PDF`);
    return false;
  }
}

// Letter PDF = letter page 1 + statement. Taking only page 1 keeps this idempotent:
// a letter PDF that was already merged on a previous run still starts with the letter.
function appendStatement(appDir, companySlug) {
  const letterOutput = path.join(appDir, 'outputs', letterFile(companySlug));
  const statement = path.join(appDir, '.build', 'statement.pdf');
  const letterPage = path.join(appDir, '.build', 'letter-p1.pdf');
  const merged = path.join(appDir, '.build', 'merged.pdf');
  try {
    execSync(`pdfseparate -f 1 -l 1 "${letterOutput}" "${letterPage}"`);
    execSync(`pdfunite "${letterPage}" "${statement}" "${merged}"`);
    fs.copyFileSync(merged, letterOutput);
    console.log(`   📎 Statement appended to outputs/${letterFile(companySlug)} (2 pages)`);
    return true;
  } catch (error) {
    console.error(`   ❌ Could not merge letter and statement (pdfseparate/pdfunite)`);
    return false;
  }
}

function buildCV(appDir, companySlug, forceRebuild = false) {
  const letterInput = path.join(appDir, 'letter-input.md');
  const outputDir = path.join(appDir, 'outputs');
  const year = new Date().getFullYear();
  const cvOutput = path.join(outputDir, `CV_${P.fileName()}_${year}.pdf`);

  let cvVariant = null;
  if (fs.existsSync(letterInput)) {
    cvVariant = parseFrontmatter(fs.readFileSync(letterInput, 'utf-8')).cv_variant;
  }

  if (!cvVariant || cvVariant === 'skip') {
    console.log(`\n📄 No CV specified (cv_variant: ${cvVariant || 'not set'})`);
    return true;
  }

  const cvInput = P.cvSourcePath(cvVariant);
  const template = P.template('cv');

  if (!cvInput) {
    console.log(`\n📄 Building CV...`);
    console.log(`   ⚠️  CV variant not found: ${cvVariant}`);
    console.log(`\n   Available variants:`);
    for (const dir of P.cvDirs()) {
      if (!fs.existsSync(dir)) continue;
      fs.readdirSync(dir).filter(f => f.endsWith('.md') && f.toLowerCase() !== 'readme.md')
        .forEach(f => console.log(`     - ${path.basename(f, '.md')}`));
    }
    return false;
  }

  // Which variant the current PDF was built from: switching cv_variant must
  // trigger a rebuild even when the new source file is older than the PDF.
  const stampFile = path.join(outputDir, '.cv_variant');
  const builtVariant = fs.existsSync(stampFile) ? fs.readFileSync(stampFile, 'utf8').trim() : null;
  if (!forceRebuild && builtVariant === cvVariant && isUpToDate(cvOutput, [cvInput, template, P.profilePath('profile.json')])) {
    console.log(`\n📄 CV up to date (${cvVariant}). Skipping.`);
    return 'skipped';
  }

  console.log(`\n📄 Building CV...`);
  console.log(`   Input:    ${P.rel(cvInput)}`);
  console.log(`   Template: ${P.rel(template)}`);
  console.log(`   Output:   active/${companySlug}/outputs/${path.basename(cvOutput)}`);

  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  try {
    // Run from the profile folder, so `photo: photos/me.jpg` in a variant resolves there.
    execSync(
      `pandoc "${cvInput}" -o "${cvOutput}" --template="${template}" ` +
      `--metadata-file="${P.pandocMetadataFile()}" --pdf-engine=lualatex`,
      { cwd: P.PROFILE_DIR, stdio: 'inherit' }
    );

    const fileSizeKB = (fs.statSync(cvOutput).size / 1024).toFixed(1);

    // Page limit per variant (max_pages: 2 for a long variant); default 1.
    const cvFront = parseFrontmatter(fs.readFileSync(cvInput, 'utf-8'));
    const maxPages = parseInt(cvFront.max_pages, 10) || 1;
    const pageCount = getPdfPageCount(cvOutput);
    if (pageCount !== null && pageCount > maxPages) {
      console.log(`   ✅ Generated: (${fileSizeKB} KB)`);
      console.error(`   ⚠️  CV is ${pageCount} pages — limit is ${maxPages}! Trim content in ${P.rel(cvInput)}`);
      return false;
    }

    fs.writeFileSync(stampFile, cvVariant, 'utf8');
    console.log(`   ✅ Generated: (${fileSizeKB} KB, ${pageCount ?? '?'} page)`);
    runLayoutCheck(cvOutput);
    return true;
  } catch (error) {
    console.error(`   ❌ Failed to generate CV PDF`);
    return false;
  }
}

function buildSingle(companySlug, forceRebuild = false) {
  const appFolder = findApplication(companySlug);
  if (!appFolder) return false;

  const appDir = path.join(P.WORKSPACE, 'active', appFolder);
  console.log(`\n📦 Building: active/${appFolder}`);
  if (P.IS_EXAMPLE) console.log('   (using the example profile — copy examples/profile to profile/ to use your own)');

  const letterResult = buildLetter(appDir, appFolder, forceRebuild);
  const cvResult = buildCV(appDir, appFolder, forceRebuild);
  const statementResult = buildStatement(appDir, forceRebuild);
  const mergeResult = (statementResult !== 'absent' && statementResult !== false && letterResult !== false)
    ? appendStatement(appDir, appFolder) : true;

  if (letterResult === false || cvResult === false || statementResult === false || mergeResult === false) {
    return false;
  }

  console.log(`\n✅ Build complete for ${appFolder}`);
  return true;
}

function buildAll(forceRebuild = false) {
  const activeDir = path.join(P.WORKSPACE, 'active');

  if (!fs.existsSync(activeDir)) {
    console.log('❌ active/ directory not found');
    return false;
  }

  const folders = fs.readdirSync(activeDir).filter(f => fs.statSync(path.join(activeDir, f)).isDirectory());

  if (folders.length === 0) {
    console.log('ℹ️  No applications found in active/');
    return true;
  }

  console.log(`\n📦 Building ${folders.length} application(s)...`);

  let successful = 0;
  let failed = 0;
  for (const folder of folders) {
    if (buildSingle(folder, forceRebuild)) successful++;
    else failed++;
  }

  console.log(`\n${'='.repeat(50)}`);
  console.log('Summary');
  console.log('='.repeat(50));
  console.log(`Successful: ${successful}`);
  console.log(`Failed: ${failed}`);
  console.log(`Total: ${folders.length}`);

  return failed === 0;
}

function main() {
  const args = process.argv.slice(2);
  const forceRebuild = args.includes('--force') || args.includes('--rebuild') ||
                       process.env.REBUILD === '1' || process.env.REBUILD === 'true';
  const companyArg = args.find(arg => !arg.startsWith('--'));

  const success = companyArg ? buildSingle(companyArg, forceRebuild) : buildAll(forceRebuild);
  process.exit(success ? 0 : 1);
}

if (require.main === module) main();

module.exports = { buildLetter, buildCV, findApplication };
