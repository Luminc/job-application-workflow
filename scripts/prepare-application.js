// npm run prep "Company Name" [path/to/vacancy.txt]
//
// Creates active/<Company>/ like `npm run new`, but reads the vacancy text and
// pre-fills position, contact, hours, salary, deadline, CV variant and an
// email lead with one cheap model call. The rules for that call (which CV
// variant fits which role, how to write the lead) live in the profile:
// prompts/metadata.md, shared with the scorer's review step.

const fs = require('fs');
const path = require('path');
const P = require('../lib/profile.js');

const ACTIVE_DIR = P.workPath('active');
const MODEL = process.env.METADATA_MODEL || 'claude-haiku-4-5';

require('dotenv').config({ path: path.join(P.ROOT, '.env') });

// Same result as make_slug() in score.py.
function slugify(text) {
  return text.replace(/[^\p{L}\p{N}_\s-]/gu, '').trim().replace(/[\s-]+/g, '_');
}

// Quote a YAML value only when a plain scalar would break (colon-space).
function yamlScalar(value) {
  const t = String(value ?? '');
  return /: | #|^["'&*!|>%@`\[\]{},?#-]|^\s|\s$/.test(t) ? JSON.stringify(t) : t;
}

async function extractMetadata(companyName, vacancyText) {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn('⚠️  ANTHROPIC_API_KEY missing in .env. Using a blank template.');
    return null;
  }
  const system = P.readProfileFile('prompts', 'metadata.md');
  if (!system) {
    console.warn('⚠️  No prompts/metadata.md in the profile. Using a blank template.');
    return null;
  }

  const Anthropic = require('@anthropic-ai/sdk');
  const anthropic = new Anthropic();
  console.log(`Analyzing vacancy for ${companyName}...`);
  try {
    const msg = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system,
      messages: [{
        role: 'user',
        content: `Today: ${new Date().toISOString().slice(0, 10)}\nOrganisation given by the user: ${companyName}\n\n${vacancyText}`,
      }],
    });
    const text = msg.content[0].text.trim();
    return JSON.parse((text.match(/\{[\s\S]*\}/) || [text])[0]);
  } catch (error) {
    console.error('❌ API error:', error.message);
    return null;
  }
}

async function main() {
  const args = process.argv.slice(2);
  const companyArg = args.find((a) => !a.startsWith('--') && !/\.(txt|md)$/i.test(a));
  const fileArg = args.find((a) => /\.(txt|md)$/i.test(a));

  if (!companyArg) {
    console.error('Usage: npm run prep "Company Name" [path/to/vacancy.txt]');
    process.exit(1);
  }

  let vacancyText = '';
  if (fileArg) {
    if (!fs.existsSync(fileArg)) {
      console.error(`❌ Vacancy file not found: ${fileArg}`);
      process.exit(1);
    }
    vacancyText = fs.readFileSync(fileArg, 'utf8');
    console.log(`📖 Read vacancy text from ${fileArg}`);
  }

  const meta = vacancyText ? await extractMetadata(companyArg, vacancyText) : null;
  const company = meta?.company || companyArg;
  const slug = slugify(company);
  const appDir = path.join(ACTIVE_DIR, slug);

  if (fs.existsSync(appDir)) {
    console.error(`❌ Folder already exists: active/${slug}`);
    process.exit(1);
  }
  fs.mkdirSync(path.join(appDir, 'outputs'), { recursive: true });

  const front = [
    `company: ${yamlScalar(company)}`,
    meta?.position && `position: ${yamlScalar(meta.position)}`,
    'source: manual',
    meta?.hours && `hours: ${yamlScalar(meta.hours)}`,
    meta?.salary && `salary: ${yamlScalar(meta.salary)}`,
    meta?.deadline && `deadline: ${yamlScalar(meta.deadline)}`,
    meta?.deadline_iso && `deadline_iso: ${meta.deadline_iso}`,
    `found_at: ${new Date().toISOString().slice(0, 10)}`,
    'status: active',
  ].filter(Boolean).join('\n');
  // "Applied:" stays empty: the folder exists long before anything is sent.
  fs.writeFileSync(path.join(appDir, 'vacancy.md'),
    `---\n${front}\n---\n\n# ${company}\n\n## Job Posting\n\n${vacancyText || '[Paste the job posting here]'}\n\n` +
    `## Company Info\n\n[Research notes about the organisation]\n\n## Application Notes\n\n` +
    `- Position: ${meta?.position || ''}\n- Applied:\n- Source: manual\n`);

  const p = P.profile();
  const language = meta?.language || p.language || 'en';
  const position = meta?.position || '[Position]';
  fs.writeFileSync(path.join(appDir, 'letter-input.md'), `---
recipient:
  - ${yamlScalar(company)}
  - ${yamlScalar(meta?.contact_name || '[Contact name]')}
salutation: ${yamlScalar(meta?.salutation || '[Dear Name]')}
email: ${meta?.contact_email || ''}
subject: ${yamlScalar(meta?.subject || position)}
cv_variant: ${meta?.cv_variant || (p.cv && p.cv.default_variant) || ''}
position: ${yamlScalar(position)}
company_slug: ${slug}
language: ${language}
email_lead: ${yamlScalar(meta?.email_lead || '[A hook: one or two sentences; see STYLEGUIDE.md]')}
---
[Letter body]
`);

  console.log(`\n✅ Created active/${slug}/${meta ? ' (pre-filled from the vacancy)' : ''}`);
  console.log(`\nNext steps:`);
  console.log(`  1. Check the frontmatter in active/${slug}/letter-input.md`);
  console.log(`  2. npm run pack ${slug}   (or: npm run draft ${slug})`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
