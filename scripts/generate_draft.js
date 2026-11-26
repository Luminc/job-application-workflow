// npm run prompt <Folder>   write active/<Folder>/prompt.md to paste into a chat
// npm run draft <Folder>    call the API and put the draft into letter-input.md
//
// The draft is a starting point, never the letter: review and rewrite it
// against STYLEGUIDE.md before `npm run build`.

const fs = require('fs');
const path = require('path');
const P = require('../lib/profile.js');
const { cvAsText, styleRules, splitFrontmatter, field } = require('./letter-context.js');

const ACTIVE_DIR = P.workPath('active');
const MODEL = process.env.DRAFT_MODEL || 'claude-sonnet-5-5';

const args = process.argv.slice(2);
const isApiMode = args.includes('--api');
const targetSlug = args.find((arg) => !arg.startsWith('--'));

if (!targetSlug) {
  console.error('Usage: npm run draft <Folder>  OR  npm run prompt <Folder>');
  process.exit(1);
}

const targetDir = path.join(ACTIVE_DIR, targetSlug);
const vacancyPath = path.join(targetDir, 'vacancy.md');
const letterInputPath = path.join(targetDir, 'letter-input.md');

if (!fs.existsSync(vacancyPath) || !fs.existsSync(letterInputPath)) {
  console.error(`Missing vacancy.md or letter-input.md in active/${targetSlug}`);
  process.exit(1);
}

const vacancy = fs.readFileSync(vacancyPath, 'utf8');
const letterData = fs.readFileSync(letterInputPath, 'utf8');
const [fm] = splitFrontmatter(letterData);
const cvVariant = field(fm, 'cv_variant') || (P.profile().cv || {}).default_variant;
const language = field(fm, 'language') || P.profile().language || 'en';

const cv = cvAsText(cvVariant);
if (!cv) console.warn(`Warning: CV variant '${cvVariant}' not found in the profile.`);

const promptText = `You are drafting a tailored cover letter for one job application, in ${language === 'nl' ? 'Dutch' : language === 'en' ? 'English' : `the language "${language}"`}.

These are my rules for writing letters: my style guide and my profile (identity, evidence, claim limits, lessons learned). They are the standard the letter is held to.

<rules>
${styleRules()}
</rules>

The CV variant I am sending with this letter:

<my_cv>
${cv || '(not found)'}
</my_cv>

The vacancy:

<vacancy>
${vacancy}
</vacancy>

Task:
- Draft the letter body (~250 words). Follow the rules above exactly.
- Be specific to this organisation: show that I know their work.
- Use only claims supported by the profile and CV; never invent experience.
- The template adds the salutation above and the closing and my name below, from the frontmatter. Output ONLY the paragraphs in between.
`;

if (!isApiMode) {
  const promptPath = path.join(targetDir, 'prompt.md');
  fs.writeFileSync(promptPath, promptText, 'utf8');
  console.log(`\n✅ Prompt written to active/${targetSlug}/prompt.md — paste it into a chat.`);
  process.exit(0);
}

require('dotenv').config({ path: path.join(P.ROOT, '.env') });
if (!process.env.ANTHROPIC_API_KEY) {
  console.error('ANTHROPIC_API_KEY is missing in .env');
  process.exit(1);
}

const Anthropic = require('@anthropic-ai/sdk');
const anthropic = new Anthropic();

(async () => {
  console.log(`Drafting for ${targetSlug} with ${MODEL}...`);
  try {
    const msg = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 4000,
      messages: [{ role: 'user', content: promptText }],
    });
    const draft = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
    const [front] = splitFrontmatter(letterData);
    fs.writeFileSync(letterInputPath, `---\n${front}\n---\n\n${draft}\n`, 'utf8');
    console.log(`\n✅ Draft written to active/${targetSlug}/letter-input.md`);
    console.log('   Review and rewrite it before building.\n');
  } catch (error) {
    console.error('API error:', error.message);
    process.exit(1);
  }
})();
