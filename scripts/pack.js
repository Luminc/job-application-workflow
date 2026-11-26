// npm run pack <Folder> [--no-clip] [--no-examples]
//
// Bundles everything a browser chat needs to write the letter into one
// markdown file, active/<Folder>/pack.md, and puts it on the clipboard:
//
//   1. the task + the letter-input.md frontmatter it has to fit
//   2. the vacancy in full (vacancy.md)
//   3. research.md and deep_evaluation.md, if present
//   4. the CV variant being sent, as plain text
//   5. the style rules (profile STYLEGUIDE.md + PROFILE.md)
//   6. up to two earlier letters with the same cv_variant (invited first)
//
// The chat has no repo access, so everything it should know is in here --
// and nothing else (no scraper notes or command lists).

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const ctx = require('./letter-context.js');

const ACTIVE = require('../lib/profile.js').workPath('active');

function findFolder(name) {
  if (!name || !fs.existsSync(ACTIVE)) return null;
  const dirs = fs.readdirSync(ACTIVE).filter((d) => fs.statSync(path.join(ACTIVE, d)).isDirectory());
  return dirs.find((d) => d === name) || dirs.find((d) => d.toLowerCase() === name.toLowerCase()) || null;
}

function copyToClipboard(file) {
  if (process.platform === 'win32') {
    // clip.exe mangles UTF-8 (€, é, —); PowerShell's Set-Clipboard doesn't.
    execFileSync('powershell', [
      '-NoProfile', '-Command',
      `Get-Content -Raw -Encoding UTF8 -LiteralPath '${file.replace(/'/g, "''")}' | Set-Clipboard`,
    ]);
  } else if (process.platform === 'darwin') {
    execFileSync('pbcopy', { input: fs.readFileSync(file) });
  } else {
    execFileSync('xclip', ['-selection', 'clipboard'], { input: fs.readFileSync(file) });
  }
}

function main() {
  const args = process.argv.slice(2);
  const name = args.find((a) => !a.startsWith('--'));
  const folder = findFolder(name);
  if (!folder) {
    console.error('Usage: npm run pack <Folder>');
    if (name) console.error(`Not found in active/: ${name}`);
    process.exit(1);
  }
  const dir = path.join(ACTIVE, folder);

  const letterInput = ctx.readIfExists(path.join(dir, 'letter-input.md')) || '';
  const [fm] = ctx.splitFrontmatter(letterInput);
  const variant = ctx.field(fm, 'cv_variant');
  const language = ctx.field(fm, 'language') || 'en';

  const parts = [];
  parts.push(`# Task\n\nWrite the body of a cover letter (~250 words, language: ${language}) for the vacancy below, ` +
    'following the style rules at the end exactly. Output only the letter body: no salutation and no closing — ' +
    'those come from the frontmatter and the template.');
  parts.push(`## letter-input.md (frontmatter)\n\n\`\`\`yaml\n${fm.trim()}\n\`\`\``);

  parts.push(`# Vacancy\n\n${(ctx.readIfExists(path.join(dir, 'vacancy.md')) || '(vacancy.md missing)').trim()}`);

  const research = ctx.readIfExists(path.join(dir, 'research.md'));
  if (research) parts.push(`# Research on the organisation\n\n${research.trim()}`);
  const evaluation = ctx.readIfExists(path.join(dir, 'deep_evaluation.md'));
  if (evaluation) parts.push(`# Fit evaluation\n\n${evaluation.trim()}`);

  const cv = variant ? ctx.cvAsText(variant) : null;
  parts.push(`# My CV (variant: ${variant || 'unknown'})\n\n${cv || '(CV variant not found)'}`);

  parts.push(`# Style rules\n\n${ctx.styleRules()}`);

  const examples = args.includes('--no-examples') ? [] : ctx.exampleLetters(variant);
  if (examples.length) {
    parts.push('# Earlier letters with the same CV variant\n\nFor tone and level only — do not reuse or quote.\n\n' +
      examples.map((e) => `## ${e.folder} — ${e.position || ''} (${e.status})\n\n${e.body}`).join('\n\n'));
  }

  const out = path.join(dir, 'pack.md');
  const text = parts.join('\n\n---\n\n') + '\n';
  fs.writeFileSync(out, text, 'utf8');

  const words = text.split(/\s+/).length;
  console.log(`\n[OK] active/${folder}/pack.md  (~${words} words)`);
  console.log(`     vacancy${research ? ' + research' : ''}${evaluation ? ' + evaluation' : ''} + cv (${variant}) + style rules` +
    (examples.length ? ` + ${examples.length} earlier letter(s): ${examples.map((e) => e.folder).join(', ')}` : ''));

  if (!args.includes('--no-clip')) {
    try {
      copyToClipboard(out);
      console.log('     On the clipboard — paste it into your chat.');
    } catch (e) {
      console.log(`     (clipboard failed: ${e.message.split('\n')[0]}; open the file instead)`);
    }
  }
}

main();
