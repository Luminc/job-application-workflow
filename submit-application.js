// Mark application as submitted
// Usage: npm run submit CompanyName

const fs = require('fs');
const path = require('path');
const P = require('./lib/profile.js');
const { slugifyRole } = require('./scripts/prior-applications.js');

function readPosition(letterInput) {
  try {
    const m = fs.readFileSync(letterInput, 'utf8').match(/^position:\s*(.+)$/m);
    return m ? m[1].trim().replace(/^["']|["']$/g, '') : null;
  } catch {
    return null;
  }
}

function findApplication(companySlug) {
  const activeDir = path.join(P.WORKSPACE, 'active');

  if (!fs.existsSync(activeDir)) {
    return null;
  }

  const folders = fs.readdirSync(activeDir).filter(f => {
    return fs.statSync(path.join(activeDir, f)).isDirectory();
  });

  // Exact match
  if (folders.includes(companySlug)) {
    return companySlug;
  }

  // Case-insensitive match
  const match = folders.find(f => f.toLowerCase() === companySlug.toLowerCase());
  return match || null;
}

function submitApplication(companySlug) {
  let appFolder = findApplication(companySlug);

  if (!appFolder) {
    console.log(`❌ Application not found: ${companySlug}`);
    console.log(`\nSearched in: active/`);
    return false;
  }

  const sourcePath = path.join(P.WORKSPACE, 'active', appFolder);
  const pendingDir = path.join(P.WORKSPACE, 'submitted', 'pending');

  // A folder of this name may already exist because the same organisation was
  // applied to before, for a different role. Disambiguate by role rather than
  // refusing -- re-applying is normal.
  let targetName = appFolder;
  let targetPath = path.join(pendingDir, targetName);

  if (fs.existsSync(targetPath)) {
    const position = readPosition(path.join(sourcePath, 'letter-input.md'));
    const roleSuffix = slugifyRole(position);

    if (!roleSuffix) {
      console.log(`❌ Already exists in submitted/pending: ${appFolder}`);
      console.log(`   No 'position' in letter-input.md to disambiguate by.`);
      return false;
    }

    targetName = `${appFolder}_${roleSuffix}`;
    targetPath = path.join(pendingDir, targetName);
    let n = 2;
    while (fs.existsSync(targetPath)) {
      targetName = `${appFolder}_${roleSuffix}_${n++}`;
      targetPath = path.join(pendingDir, targetName);
    }

    console.log(`ℹ️  ${appFolder} already exists in submitted/pending.`);
    console.log(`   This is a different role, so filing it separately as:`);
    console.log(`   ${targetName}\n`);
  }

  try {
    fs.renameSync(sourcePath, targetPath);
    console.log(`✅ Marked as submitted`);
    console.log(`   From: active/${appFolder}`);
    console.log(`   To:   submitted/pending/${targetName}`);
    appFolder = targetName;
    console.log(`\nNext steps:`);
    console.log(`  - Wait for response from company`);
    console.log(`  - When feedback arrives:`);
    console.log(`    npm run outcome ${appFolder} invited   # Got interview`);
    console.log(`    npm run outcome ${appFolder} rejected  # No interview`);
    return true;
  } catch (error) {
    console.log(`❌ Failed to move application: ${error.message}`);
    return false;
  }
}

function main() {
  if (process.argv.length < 3) {
    console.log('Usage: npm run submit CompanyName');
    console.log('Example: npm run submit Acme_Museum');
    console.log('\nThis moves the application from active/ to submitted/pending/');
    process.exit(1);
  }

  const companySlug = process.argv.slice(2).join('_');

  console.log('📮 Submit Application');
  console.log('=====================\n');

  const success = submitApplication(companySlug);

  if (!success) {
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { submitApplication };