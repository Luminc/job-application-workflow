const fs = require('fs');
const path = require('path');

// Colors for terminal output
const colors = {
    reset: "\x1b[0m",
    bright: "\x1b[1m",
    dim: "\x1b[2m",
    fg: {
        red: "\x1b[31m",
        green: "\x1b[32m",
        yellow: "\x1b[33m",
        blue: "\x1b[34m",
        magenta: "\x1b[35m",
        cyan: "\x1b[36m",
        white: "\x1b[37m",
    }
};

const ROOT_DIR = require('../lib/profile.js').WORKSPACE;
const ACTIVE_DIR = path.join(ROOT_DIR, 'active');
const SUBMITTED_DIR = path.join(ROOT_DIR, 'submitted');

// Thresholds in days
const STAGNANT_ACTIVE_DAYS = 7;
const STAGNANT_SUBMITTED_DAYS = 14;

function getDirectories(srcPath) {
    if (!fs.existsSync(srcPath)) return [];
    return fs.readdirSync(srcPath)
        .filter(file => fs.statSync(path.join(srcPath, file)).isDirectory());
}

function getDirectoryAgeDays(dirPath) {
    const stats = fs.statSync(dirPath);
    // Prefer birthtime (creation), fallback to mtime (modification)
    const time = stats.birthtimeMs > 0 ? stats.birthtimeMs : stats.mtimeMs;
    const diffTime = Math.abs(Date.now() - time);
    return Math.ceil(diffTime / (1000 * 60 * 60 * 24));
}

function getMostRecentFileDate(dirPath) {
    if (!fs.existsSync(dirPath)) return 0;

    let latestTime = 0;
    const files = fs.readdirSync(dirPath);

    for (const file of files) {
        const fullPath = path.join(dirPath, file);
        const stats = fs.statSync(fullPath);

        if (stats.isDirectory()) {
            const nestedTime = getMostRecentFileDate(fullPath);
            if (nestedTime > latestTime) latestTime = nestedTime;
        } else {
            if (stats.mtimeMs > latestTime) latestTime = stats.mtimeMs;
        }
    }
    return latestTime || Date.now(); // Fallback to now if empty
}

function getDaysSinceLastUpdate(dirPath) {
    const latestFileTime = getMostRecentFileDate(dirPath);
    const diffTime = Math.abs(Date.now() - latestFileTime);
    return Math.ceil(diffTime / (1000 * 60 * 60 * 24)) - 1; // 0 days means today
}

function scanApplications() {
    const stats = {
        active: [],
        submittedPending: [],
        rejectedCount: 0,      // every rejection, whether or not an interview happened
        invitedCount: 0,       // every application that reached an interview
        acceptedCount: 0,
        withdrawnCount: 0,     // pulled out himself, with or without an interview
        withdrawnNoInterview: 0,
        rejectedNoInterview: 0 // rejected without an interview; kept separate so
                               // Total Sent does not count the same application twice
    };

    // 1. Scan Active
    const activeDirs = getDirectories(ACTIVE_DIR);
    for (const dir of activeDirs) {
        const fullPath = path.join(ACTIVE_DIR, dir);
        const age = getDaysSinceLastUpdate(fullPath);
        stats.active.push({ name: dir, daysInactive: age });
    }

    // 2. Scan Submitted/Rejected
    const rejectedDir = path.join(SUBMITTED_DIR, 'rejected');
    stats.rejectedNoInterview = getDirectories(rejectedDir).length;
    stats.rejectedCount = stats.rejectedNoInterview;

    // Withdrawn by himself: sent, but neither waiting nor rejected
    stats.withdrawnNoInterview = getDirectories(path.join(SUBMITTED_DIR, 'withdrawn')).length;
    stats.withdrawnCount = stats.withdrawnNoInterview;

    // 3. Scan Submitted/Invited (and nested accepted/rejected)
    const invitedDir = path.join(SUBMITTED_DIR, 'invited');
    const invitedSubdirs = getDirectories(invitedDir);

    for (const dir of invitedSubdirs) {
        if (dir === 'accepted') {
            stats.acceptedCount = getDirectories(path.join(invitedDir, 'accepted')).length;
            stats.invitedCount += stats.acceptedCount; // accepted implies invited
        } else if (dir === 'rejected') {
            // These count as BOTH invited AND rejected eventually, but for dashboard simplicity 
            // we'll count them towards the overall "rejected" count, but they were definitely "invited"
            // Count the applications inside, not the folder itself.
            const n = getDirectories(path.join(invitedDir, 'rejected')).length;
            stats.rejectedCount += n;
            stats.invitedCount += n; // they got an invite first
        } else if (dir === 'withdrawn') {
            const n = getDirectories(path.join(invitedDir, 'withdrawn')).length;
            stats.withdrawnCount += n;
            stats.invitedCount += n; // they got an invite first
        } else {
            // It's a company folder actively in the invited phase
            stats.invitedCount++;
            stats.active.push({ name: dir + " (Invited/Prep)", daysInactive: getDaysSinceLastUpdate(path.join(invitedDir, dir)) });
        }
    }

    // 4. Scan Submitted/Pending (awaiting response)
    // Applications live in submitted/pending/; anything sitting directly in
    // submitted/ is a legacy layout, so count both. 'pending' must be treated
    // as a state folder here -- omitting it counted the folder itself as one
    // application and hid everything inside it.
    const STATE_FOLDERS = ['invited', 'rejected', 'accepted', 'pending', 'withdrawn'];

    const pendingSources = [
        path.join(SUBMITTED_DIR, 'pending'),
        SUBMITTED_DIR,
    ];

    for (const source of pendingSources) {
        for (const dir of getDirectories(source)) {
            if (source === SUBMITTED_DIR && STATE_FOLDERS.includes(dir)) continue;

            const fullPath = path.join(source, dir);
            const age = getDirectoryAgeDays(fullPath);
            stats.submittedPending.push({ name: dir, daysWaiting: age });
        }
    }

    return stats;
}

function displayDashboard(stats) {
    console.log(`\n${colors.bright}${colors.fg.cyan}=================================================${colors.reset}`);
    console.log(`${colors.bright}${colors.fg.cyan}           APPLICATIONS KANBAN DASHBOARD         ${colors.reset}`);
    console.log(`${colors.bright}${colors.fg.cyan}=================================================${colors.reset}\n`);

    // --- Stats Summary ---
    // Each application counted once: still waiting, rejected or withdrawn
    // without an interview, or reached an interview (whatever happened afterwards).
    const totalSent = stats.submittedPending.length + stats.rejectedNoInterview + stats.withdrawnNoInterview + stats.invitedCount;
    // Conversion rate is (total invited / total sent) * 100
    // Prevent division by zero
    const conversionRate = totalSent > 0 ? ((stats.invitedCount / totalSent) * 100).toFixed(1) : 0;

    console.log(`${colors.bright}📋 PIPELINE OVERVIEW${colors.reset}`);
    console.log(`  Active (Drafting): ${colors.fg.yellow}${stats.active.length}${colors.reset}`);
    console.log(`  Awaiting Response: ${colors.fg.blue}${stats.submittedPending.length}${colors.reset}`);
    console.log(`  Total Sent:        ${stats.totalSent || totalSent}`);
    console.log(`  Invitations:       ${colors.fg.green}${stats.invitedCount}${colors.reset}`);
    console.log(`  Rejections:        ${colors.fg.red}${stats.rejectedCount}${colors.reset}`);
    console.log(`  Withdrawn:         ${stats.withdrawnCount}`);

    if (totalSent > 0) {
        const convColor = conversionRate > 20 ? colors.fg.green : (conversionRate > 10 ? colors.fg.yellow : colors.fg.red);
        console.log(`  Conversion Rate:   ${convColor}${conversionRate}%${colors.reset}\n`);
    } else {
        console.log(`  Conversion Rate:   0.0%\n`);
    }

    // --- Active Board ---
    console.log(`${colors.bright}🚀 ACTIVE APPLICATIONS${colors.reset}`);
    if (stats.active.length === 0) {
        console.log(`  ${colors.dim}No applications currently in progress.${colors.reset}`);
    } else {
        // Sort by days inactive, descending
        stats.active.sort((a, b) => b.daysInactive - a.daysInactive).forEach(app => {
            let color = colors.fg.green;
            let warning = "";
            if (app.daysInactive >= STAGNANT_ACTIVE_DAYS) {
                color = colors.fg.red;
                warning = ` ${colors.bright}⚠️  STAGNANT${colors.reset}`;
            } else if (app.daysInactive >= STAGNANT_ACTIVE_DAYS - 2) {
                color = colors.fg.yellow;
            }

            const daysText = app.daysInactive === 0 ? "updated today" : `${app.daysInactive} days inactive`;
            console.log(`  - ${app.name.padEnd(30)} [${color}${daysText}${colors.reset}]${warning}`);
        });
    }
    console.log("");

    // --- Waiting Board ---
    console.log(`${colors.bright}⏳ AWAITING RESPONSE (Submitted)${colors.reset}`);
    if (stats.submittedPending.length === 0) {
        console.log(`  ${colors.dim}No applications pending response.${colors.reset}`);
    } else {
        // Sort by days waiting, descending
        stats.submittedPending.sort((a, b) => b.daysWaiting - a.daysWaiting).forEach(app => {
            let color = colors.fg.cyan;
            let warning = "";
            if (app.daysWaiting >= STAGNANT_SUBMITTED_DAYS) {
                color = colors.fg.red;
                warning = ` ${colors.bright}⚠️  FOLLOW UP OVERDUE${colors.reset}`;
            } else if (app.daysWaiting >= STAGNANT_SUBMITTED_DAYS - 3) {
                color = colors.fg.yellow;
                warning = ` ${colors.bright}⏱️  Consider Follow-up${colors.reset}`;
            }

            console.log(`  - ${app.name.padEnd(30)} [${color}Sent ${app.daysWaiting} days ago${colors.reset}]${warning}`);
        });
    }
    console.log(`\n${colors.bright}${colors.fg.cyan}=================================================${colors.reset}\n`);
}

function init() {
    try {
        const stats = scanApplications();
        displayDashboard(stats);
    } catch (e) {
        console.error(`${colors.fg.red}Error scanning directories: ${e.message}${colors.reset}`);
    }
}

init();
