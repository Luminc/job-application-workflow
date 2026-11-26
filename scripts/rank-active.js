// Rank active/ vacancies by closing-date urgency, with score as tiebreaker.
// Pure parsing of vacancy.md — no API calls, safe to run any time.
const fs = require('fs');
const path = require('path');

const colors = {
    reset: "\x1b[0m",
    bright: "\x1b[1m",
    dim: "\x1b[2m",
    fg: {
        red: "\x1b[31m",
        green: "\x1b[32m",
        yellow: "\x1b[33m",
        blue: "\x1b[34m",
        cyan: "\x1b[36m",
    }
};

const ROOT_DIR = require('../lib/profile.js').WORKSPACE;
const ACTIVE_DIR = path.join(ROOT_DIR, 'active');

const DUTCH_MONTHS = {
    januari: 1, februari: 2, maart: 3, april: 4, mei: 5, juni: 6,
    juli: 7, augustus: 8, september: 9, oktober: 10, november: 11, december: 12,
};

// Parses "27 september 2026" or "28-08-2026" / "28/08/2026". Returns null if
// the text is missing, "unknown", or doesn't match either shape.
function parseDeadline(raw) {
    if (!raw) return null;
    const text = raw.trim();
    if (!text || /^(unknown|onbekend|n\/a)$/i.test(text)) return null;

    const dutchMatch = text.match(/(\d{1,2})\s+([a-zé]+)\s+(\d{4})/i);
    if (dutchMatch) {
        const day = parseInt(dutchMatch[1], 10);
        const month = DUTCH_MONTHS[dutchMatch[2].toLowerCase()];
        const year = parseInt(dutchMatch[3], 10);
        if (month) {
            const d = new Date(year, month - 1, day);
            if (!isNaN(d)) return d;
        }
    }

    const numericMatch = text.match(/(\d{1,2})[-\/](\d{1,2})[-\/](\d{2,4})/);
    if (numericMatch) {
        const day = parseInt(numericMatch[1], 10);
        const month = parseInt(numericMatch[2], 10);
        let year = parseInt(numericMatch[3], 10);
        if (year < 100) year += 2000;
        const d = new Date(year, month - 1, day);
        if (!isNaN(d)) return d;
    }

    return null;
}

// vacancy.md frontmatter (written by the scraper and prep since
// 2026-09-26). Older folders have none; the regexes below cover those.
function parseFront(content) {
    const m = content.replace(/\r\n/g, '\n').match(/^---\n([\s\S]*?)\n---/);
    const front = {};
    if (!m) return front;
    for (const line of m[1].split('\n')) {
        const kv = line.match(/^([a-z_]+):\s*(.*)$/);
        if (kv) front[kv[1]] = kv[2].trim().replace(/^"(.*)"$/, '$1');
    }
    return front;
}

function parseVacancy(content) {
    const front = parseFront(content);

    const companyMatch = content.match(/^#\s+(.+)$/m);
    const company = front.company || (companyMatch ? companyMatch[1].trim() : null);

    const scoreMatch = content.match(/Score:\s*(\d+(?:\.\d+)?)\s*\/\s*10/i);
    const score = front.score ? parseFloat(front.score) : (scoreMatch ? parseFloat(scoreMatch[1]) : null);

    const positionMatch = content.match(/^-?\s*(?:Position|Functie):\s*(.+)$/im);
    let position = front.position || (positionMatch ? positionMatch[1].trim() : null);
    if (position && /^(unknown|onbekend)$/i.test(position)) position = null;

    const deadlineMatch = content.match(/(?:Deadline|Sluitingsdatum):\*{0,2}\s*([^\n|]+)/i);
    const deadlineRaw = front.deadline || (deadlineMatch ? deadlineMatch[1].trim() : null);
    let deadline = null;
    if (front.deadline_iso) {
        const [y, mo, d] = front.deadline_iso.split('-').map(Number);
        deadline = new Date(y, mo - 1, d);
    } else {
        deadline = parseDeadline(deadlineRaw);
    }

    return { company, position, score, deadlineRaw, deadline };
}

function getDirectories(srcPath) {
    if (!fs.existsSync(srcPath)) return [];
    return fs.readdirSync(srcPath)
        .filter(name => fs.statSync(path.join(srcPath, name)).isDirectory());
}

function daysBetween(a, b) {
    const MS_PER_DAY = 1000 * 60 * 60 * 24;
    return Math.ceil((a - b) / MS_PER_DAY);
}

function scoreLabel(score) {
    if (score === null) return `${colors.dim}?/10${colors.reset}`;
    const color = score >= 7 ? colors.fg.green : (score >= 5 ? colors.fg.yellow : colors.fg.red);
    return `${color}${score}/10${colors.reset}`;
}

function main() {
    const dirs = getDirectories(ACTIVE_DIR);
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const entries = [];
    for (const dir of dirs) {
        const vacancyFile = path.join(ACTIVE_DIR, dir, 'vacancy.md');
        if (!fs.existsSync(vacancyFile)) continue;
        const content = fs.readFileSync(vacancyFile, 'utf-8');
        const parsed = parseVacancy(content);
        entries.push({ folder: dir, ...parsed });
    }

    if (entries.length === 0) {
        console.log(`${colors.dim}No vacancies with a vacancy.md in active/${colors.reset}`);
        return;
    }

    const expired = [];
    const upcoming = [];
    const noDeadline = [];

    for (const e of entries) {
        if (e.deadline) {
            const days = daysBetween(e.deadline, today);
            e.daysLeft = days;
            if (days < 0) expired.push(e);
            else upcoming.push(e);
        } else {
            noDeadline.push(e);
        }
    }

    upcoming.sort((a, b) => a.daysLeft - b.daysLeft || (b.score ?? 0) - (a.score ?? 0));
    noDeadline.sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
    expired.sort((a, b) => b.daysLeft - a.daysLeft);

    console.log(`\n${colors.bright}${colors.fg.cyan}=================================================${colors.reset}`);
    console.log(`${colors.bright}${colors.fg.cyan}         ACTIVE VACANCIES — PRIORITY RANKING     ${colors.reset}`);
    console.log(`${colors.bright}${colors.fg.cyan}=================================================${colors.reset}\n`);

    function printEntry(e, urgencyLabel) {
        const name = e.company || e.folder;
        const pos = e.position ? ` — ${e.position}` : '';
        console.log(`  ${colors.bright}${name}${colors.reset}${pos}`);
        console.log(`    ${scoreLabel(e.score)}  ${urgencyLabel}  ${colors.dim}(${e.folder})${colors.reset}`);
    }

    if (upcoming.length) {
        console.log(`${colors.bright}⏰ DEADLINE APPROACHING${colors.reset} (most urgent first)`);
        upcoming.forEach(e => {
            const color = e.daysLeft <= 3 ? colors.fg.red : (e.daysLeft <= 10 ? colors.fg.yellow : colors.fg.blue);
            printEntry(e, `${color}${e.daysLeft} day(s) — ${e.deadlineRaw}${colors.reset}`);
        });
        console.log('');
    }

    if (noDeadline.length) {
        console.log(`${colors.bright}📋 NO KNOWN DEADLINE${colors.reset} (best score first)`);
        noDeadline.forEach(e => printEntry(e, `${colors.dim}no deadline${colors.reset}`));
        console.log('');
    }

    if (expired.length) {
        console.log(`${colors.bright}${colors.fg.red}🗑  VERLOPEN${colors.reset} (overweeg te verplaatsen/verwijderen)`);
        expired.forEach(e => printEntry(e, `${colors.fg.red}expired on ${e.deadlineRaw}${colors.reset}`));
        console.log('');
    }

    console.log(`${colors.bright}${colors.fg.cyan}=================================================${colors.reset}\n`);
}

main();
