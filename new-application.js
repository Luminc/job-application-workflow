// Create an empty application folder.
// Usage: npm run new "Company Name"
// For a folder pre-filled from the vacancy text, use npm run prep.

const fs = require('fs');
const path = require('path');
const P = require('./lib/profile.js');

function slugify(text) {
  return text
    .replace(/[^\p{L}\p{N}_\s-]/gu, '')
    .trim()
    .replace(/[\s-]+/g, '_');
}

function createApplication(companyName) {
  const slug = slugify(companyName);
  const appDir = path.join(P.WORKSPACE, 'active', slug);

  if (fs.existsSync(appDir)) {
    console.log(`❌ Application folder already exists: active/${slug}`);
    return false;
  }

  fs.mkdirSync(path.join(appDir, 'outputs'), { recursive: true });

  const today = new Date().toISOString().slice(0, 10);
  fs.writeFileSync(path.join(appDir, 'vacancy.md'), `---
company: ${companyName}
position:
url:
source: manual
found_at: ${today}
status: active
---

# ${companyName}

## Job Posting

[Paste the job posting here]

## Company Info

[Research notes about the organisation]

## Application Notes

- Position:
- Applied:
- Source: manual
`);

  const p = P.profile();
  const lang = p.language || 'en';
  const variant = (p.cv && p.cv.default_variant) || '';
  fs.writeFileSync(path.join(appDir, 'letter-input.md'), `---
recipient:
  - ${companyName}
  - "[Contact name]"
salutation: "[Dear Name]"
email:
subject: "[Application for Position]"
cv_variant: ${variant}
position: "[Position title]"
company_slug: ${slug}
language: ${lang}
email_lead: "[A hook: one or two sentences with a concrete image from their work; see STYLEGUIDE.md]"
---
[Letter body]
`);

  console.log(`✅ Created active/${slug}/`);
  console.log(`   📄 vacancy.md`);
  console.log(`   ✉️  letter-input.md`);
  console.log(`   📁 outputs/`);
  console.log(`\nNext steps:`);
  console.log(`  1. Paste the posting into active/${slug}/vacancy.md`);
  console.log(`  2. Draft the letter in active/${slug}/letter-input.md (or: npm run pack ${slug})`);
  console.log(`  3. npm run build ${slug}`);
  return true;
}

function main() {
  if (process.argv.length < 3) {
    console.log('Usage: npm run new "Company Name"');
    process.exit(1);
  }
  createApplication(process.argv.slice(2).join(' '));
}

if (require.main === module) main();

module.exports = { createApplication, slugify };
