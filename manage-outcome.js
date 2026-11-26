// Manage application outcomes
// Usage: npm run outcome CompanyName [rejected|invited|accepted|withdrawn|parked]

const fs = require('fs');
const path = require('path');
const P = require('./lib/profile.js');
const { slugifyRole } = require('./scripts/prior-applications.js');

// Open applications first: a closed one with the same name (an earlier
// rejection at that organisation) must not shadow the one being decided.
function findApplication(companySlug, searchDirs = ['active', 'submitted/pending', 'submitted/invited', 'submitted/rejected']) {
  for (const dir of searchDirs) {
    const fullPath = path.join(P.WORKSPACE, dir);
    if (!fs.existsSync(fullPath)) continue;

    const folders = fs.readdirSync(fullPath).filter(f => {
      return fs.statSync(path.join(fullPath, f)).isDirectory() && !['accepted', 'rejected', 'withdrawn'].includes(f);
    });

    // Exact match
    if (folders.includes(companySlug)) {
      return { folder: companySlug, location: dir };
    }

    // Case-insensitive match
    const match = folders.find(f => f.toLowerCase() === companySlug.toLowerCase());
    if (match) {
      return { folder: match, location: dir };
    }
  }

  return null;
}

// Target taken (same organisation applied to before, e.g. a second role at an
// organisation already in submitted/rejected/): file it by role, like submit does.
function freeTarget(targetPath, sourcePath) {
  if (!fs.existsSync(targetPath)) return targetPath;
  const li = path.join(sourcePath, 'letter-input.md');
  const m = fs.existsSync(li) ? fs.readFileSync(li, 'utf8').match(/^position:\s*(.+)$/m) : null;
  const role = slugifyRole(m ? m[1].trim().replace(/^["']|["']$/g, '') : null);
  const base = role && !path.basename(targetPath).endsWith(role)
    ? `${targetPath}_${role}` : targetPath;
  let candidate = base;
  let n = 2;
  while (fs.existsSync(candidate)) candidate = `${base}_${n++}`;
  return candidate;
}

// Parking = decided not to apply after all (e.g. deep evaluation said
// "avoid"). Out of active/, but not in submitted/: it was never sent, so
// it must not count as an earlier application to that organisation.
function parkApplication(app, reason) {
  const sourcePath = path.join(P.WORKSPACE, app.location, app.folder);
  const targetPath = freeTarget(path.join(P.WORKSPACE, 'archive', 'parked', app.folder), sourcePath);
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });

  const vacature = path.join(sourcePath, 'vacancy.md');
  if (fs.existsSync(vacature)) {
    const today = new Date().toISOString().slice(0, 10);
    let text = fs.readFileSync(vacature, 'utf8');
    text = text.replace(/^(---\r?\n[\s\S]*?)^status:.*$/m, '$1status: parked');
    text += `\n- Parked: ${today}${reason ? ` — ${reason}` : ''}\n`;
    fs.writeFileSync(vacature, text, 'utf8');
  }

  fs.renameSync(sourcePath, targetPath);
  console.log(`✅ Parked`);
  console.log(`   From: ${app.location}/${app.folder}`);
  console.log(`   To:   ${P.rel(targetPath)}`);
  return true;
}

function moveApplication(companySlug, outcome, reason = '') {
  const validOutcomes = ['rejected', 'invited', 'accepted', 'withdrawn', 'parked'];

  if (!validOutcomes.includes(outcome)) {
    console.log(`❌ Invalid outcome: ${outcome}`);
    console.log(`   Valid: ${validOutcomes.join(', ')}`);
    return false;
  }

  const app = findApplication(companySlug);

  if (!app) {
    console.log(`❌ Application not found: ${companySlug}`);
    console.log(`\nSearched in: active/, submitted/rejected/, submitted/invited/`);
    return false;
  }

  if (outcome === 'rejected' && app.location === 'submitted/rejected') {
    console.log(`❌ ${app.location}/${app.folder} is already rejected; nothing moved.`);
    return false;
  }

  if (outcome === 'parked') {
    if (app.location !== 'active') {
      console.log(`❌ Only folders in active/ can be parked (found in ${app.location}/).`);
      return false;
    }
    return parkApplication(app, reason);
  }

  const sourcePath = path.join(P.WORKSPACE, app.location, app.folder);
  let targetPath;

  // Determine target based on outcome and current location
  if (outcome === 'rejected') {
    if (app.location === 'submitted/invited') {
      // Was invited, then rejected after interview
      targetPath = path.join(P.WORKSPACE, 'submitted', 'invited', 'rejected', app.folder);
    } else {
      // Rejected without interview
      targetPath = path.join(P.WORKSPACE, 'submitted', 'rejected', app.folder);
    }
  } else if (outcome === 'invited') {
    // Move to invited folder (pending interview outcome)
    targetPath = path.join(P.WORKSPACE, 'submitted', 'invited', app.folder);
  } else if (outcome === 'accepted') {
    // Accepted after interview
    targetPath = path.join(P.WORKSPACE, 'submitted', 'invited', 'accepted', app.folder);
  } else if (outcome === 'withdrawn') {
    // You pulled out yourself (often mutual: the role turned out too junior).
    // Kept apart from rejected so the rejection numbers stay honest; after an
    // interview it stays under invited/ so the invite still counts.
    if (app.location === 'active') {
      console.log(`❌ ${app.folder} is still in active/ (never sent): use parked.`);
      return false;
    }
    targetPath = app.location === 'submitted/invited'
      ? path.join(P.WORKSPACE, 'submitted', 'invited', 'withdrawn', app.folder)
      : path.join(P.WORKSPACE, 'submitted', 'withdrawn', app.folder);
  }

  const wanted = targetPath;
  targetPath = freeTarget(targetPath, sourcePath);
  if (targetPath !== wanted) {
    console.log(`ℹ️  ${P.rel(wanted)} already exists (earlier application);`);
    console.log(`   filing this one separately.\n`);
  }

  // Move the folder
  try {
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.renameSync(sourcePath, targetPath);
    const vacature = path.join(targetPath, 'vacancy.md');
    if (outcome === 'withdrawn' && fs.existsSync(vacature)) {
      const today = new Date().toISOString().slice(0, 10);
      fs.appendFileSync(vacature, `
- Withdrawn: ${today}${reason ? ` — ${reason}` : ''}
`, 'utf8');
    }
    console.log(`✅ Moved application`);
    console.log(`   From: ${app.location}/${app.folder}`);
    console.log(`   To:   ${P.rel(targetPath)}`);
    return true;
  } catch (error) {
    console.log(`❌ Failed to move application: ${error.message}`);
    return false;
  }
}

function listApplications() {
  console.log('📋 Current Applications\n');

  const sections = [
    { dir: 'active', label: 'Active (drafting)' },
    { dir: 'submitted/pending', label: 'Submitted (awaiting response)' },
    { dir: 'submitted/rejected', label: 'Submitted - Rejected (no interview)' },
    { dir: 'submitted/withdrawn', label: 'Submitted - Withdrawn (no interview)' },
    { dir: 'submitted/invited', label: 'Submitted - Invited (pending outcome)' },
    { dir: 'submitted/invited/accepted', label: 'Submitted - Invited - Accepted' },
    { dir: 'submitted/invited/rejected', label: 'Submitted - Invited - Rejected' },
    { dir: 'submitted/invited/withdrawn', label: 'Submitted - Invited - Withdrawn' }
  ];

  for (const section of sections) {
    const fullPath = path.join(P.WORKSPACE, section.dir);
    if (!fs.existsSync(fullPath)) continue;

    const folders = fs.readdirSync(fullPath).filter(f => {
      const stat = fs.statSync(path.join(fullPath, f));
      // Exclude the outcome subfolders in submitted/invited
      return stat.isDirectory() && !['accepted', 'rejected', 'withdrawn', '.gitkeep'].includes(f);
    });

    if (folders.length > 0) {
      console.log(`\n${section.label}:`);
      folders.forEach(f => console.log(`  - ${f}`));
    }
  }
}

function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === 'list') {
    listApplications();
    return;
  }

  if (args.length < 2) {
    console.log('Usage: npm run outcome CompanyName [rejected|invited|accepted|withdrawn|parked] [reason]');
    console.log('\nExamples:');
    console.log('  npm run outcome Acme_Museum rejected    # No interview');
    console.log('  npm run outcome Acme_Museum invited     # Got interview invitation');
    console.log('  npm run outcome Acme_Museum accepted    # Accepted after interview');
    console.log('  npm run outcome Acme_Museum withdrawn "too junior"  # you pulled out (after sending)');
    console.log('  npm run outcome Acme_Museum parked "wrong role"     # active/ -> archive/parked/, never sent');
    console.log('\nOr list all applications:');
    console.log('  npm run outcome list');
    process.exit(1);
  }

  const companySlug = args[0];
  const outcome = args[1];

  console.log('📊 Application Outcome Manager');
  console.log('===============================\n');

  moveApplication(companySlug, outcome, args.slice(2).join(' '));
}

if (require.main === module) {
  main();
}

module.exports = { moveApplication, findApplication, listApplications };