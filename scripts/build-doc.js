#!/usr/bin/env node
// Markdown -> PDF in your own house style, for working documents and agreements.
//
//   npm run doc <path/to/file.md> [-- --out path/to/output.pdf]
//
// Frontmatter picks the template from the profile (templates/<name>.tex):
//   template: document   working documents (default; uses `recipient`, `subject`)
//   template: contract   agreements, if your profile has a contract.tex
// `output:` sets a file name; otherwise <folder>/outputs/<name>.pdf when outputs/ exists.
//
// Fonts often lack emoji and some symbols. GLYPHS replaces those in a temporary
// copy, so the source stays untouched. Other missing glyphs are reported.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const P = require('../lib/profile.js');

const GLYPHS = [
  [/️/g, ''],
  [/[✔✓]/g, 'yes'],
  [/✗|✘/g, 'no'],
];

function frontmatter(text) {
  const m = text.replace(/\r\n/g, '\n').match(/^---\n([\s\S]*?)\n---/);
  if (!m) return {};
  const out = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (kv) out[kv[1]] = kv[2].replace(/^["']|["']$/g, '').trim();
  }
  return out;
}

function main() {
  const args = process.argv.slice(2);
  const input = args.find((a) => !a.startsWith('--'));
  const outIdx = args.indexOf('--out');
  if (!input) {
    console.error('Usage: npm run doc <file.md> [-- --out output.pdf]');
    process.exit(1);
  }
  const src = path.resolve(input);
  if (!fs.existsSync(src)) {
    console.error(`Not found: ${src}`);
    process.exit(1);
  }

  const text = fs.readFileSync(src, 'utf8');
  const fm = frontmatter(text);
  const templateName = fm.template || 'document';
  const template = P.template(templateName);
  if (!fs.existsSync(template)) {
    console.error(`Template does not exist: ${template}`);
    process.exit(1);
  }

  const dir = path.dirname(src);
  const base = path.basename(src, path.extname(src));
  let output;
  if (outIdx !== -1 && args[outIdx + 1]) output = path.resolve(args[outIdx + 1]);
  else {
    const outDir = fs.existsSync(path.join(dir, 'outputs')) ? path.join(dir, 'outputs') : dir;
    output = path.join(outDir, fm.output || `${base}.pdf`);
  }

  let printable = text;
  for (const [re, rep] of GLYPHS) printable = printable.replace(re, rep);
  const tmp = path.join(os.tmpdir(), `build-doc-${process.pid}-${base}.md`);
  fs.writeFileSync(tmp, printable, 'utf8');

  const res = spawnSync('pandoc', [
    tmp, '-f', 'markdown+hard_line_breaks', '-o', output,
    `--template=${template}`, `--metadata-file=${P.pandocMetadataFile()}`,
    '--pdf-engine=lualatex', `--resource-path=${dir}`,
  ], { encoding: 'utf8' });
  fs.unlinkSync(tmp);

  const log = `${res.stdout || ''}${res.stderr || ''}`;
  const missing = [...new Set([...log.matchAll(/There is no (.+?) \(U\+/g)].map((m) => m[1]))];
  if (res.status !== 0 || !fs.existsSync(output) || fs.statSync(output).size < 1024) {
    console.error(log.trim());
    console.error(`❌ No PDF made from ${path.relative(process.cwd(), src)}`);
    process.exit(1);
  }
  if (missing.length) console.warn(`⚠️  Characters the font lacks (replace them or add them to GLYPHS): ${missing.join(' ')}`);

  const info = spawnSync('pdfinfo', [output], { encoding: 'utf8' });
  const pages = (info.stdout || '').match(/Pages:\s+(\d+)/);
  console.log(`✅ ${path.relative(process.cwd(), output)} (${templateName}${pages ? `, ${pages[1]} p.` : ''})`);
}

main();
