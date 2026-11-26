// RSS feeds as a search source. Many job boards and employers publish a feed
// of new vacancies for feed readers; this reads them the same way. One
// request per feed per search round: every item becomes a card for the title
// triage, and only the items that pass are opened for their full text, one
// page at a time at a reader's pace.
//
// Read the site's terms before adding a feed; a feed made for subscribers is
// not a licence for everything. Keep the feeds you use in your own profile.
//
// <profile>/search/feeds.json:
//   {
//     "feeds": {
//       "museum-jobs": {
//         "url": "https://example.org/vacancies/feed/",
//         "title_split": ": ",                 // "Organisation: Position" titles
//         "location_regex": " in ([^|]+?) (?:is|zoekt)", // from the item text
//         "details": true,                     // open kept items for the full text
//         "delay_s": 5,                        // between page requests
//         "max_details": 30                    // pages opened per round; the rest next round
//       }
//     }
//   }
// Everything except "url" is optional. Enable with "feeds" in
// profile.json search.platforms.

const fs = require('fs');
const P = require('../lib/profile.js');

const CONFIG_FILE = P.profilePath('search', 'feeds.json');
const UA = 'Mozilla/5.0 (compatible; job-application-workflow/1.0; feed reader)';

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch { return fallback; }
}

function config() {
  return (readJson(CONFIG_FILE, null) || {}).feeds || {};
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
function decode(text) {
  return String(text || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => {
      if (e[0] === '#') {
        const cp = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : '';
      }
      return ENTITIES[e.toLowerCase()] ?? m;
    });
}

// Text a reader sees: no scripts, styles, comments or hidden elements; block
// elements become line breaks; invisible characters are dropped.
const INVISIBLE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F­؜᠎​-‏‪-‮⁠-⁯︀-️﻿]/g;
function htmlToText(html) {
  return decode(String(html || '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|template|noscript)\b[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<([a-z][\w-]*)\b[^>]*\s(?:hidden|style="[^"]*display\s*:\s*none[^"]*")[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\/(p|li|h[1-6]|div|tr|section|article)>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, ' '))
    .replace(INVISIBLE, '')
    .split('\n').map((l) => l.replace(/[ \t   ]+/g, ' ').trim()).join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function tag(item, name) {
  const m = item.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? decode(m[1]).trim() : '';
}

// Items of an RSS 2.0 or Atom feed: { url, title, company, location, date, summary, categories }.
function parseFeed(xml, cfg = {}) {
  const chunks = xml.includes('<item') ? xml.split(/<item\b[^>]*>/i).slice(1) : xml.split(/<entry\b[^>]*>/i).slice(1);
  const out = [];
  for (const raw of chunks) {
    const item = raw.split(/<\/(?:item|entry)>/i)[0];
    let url = tag(item, 'link');
    if (!url) url = (item.match(/<link\b[^>]*href="([^"]+)"/i) || [])[1] || '';
    if (!/^https?:\/\//i.test(url)) continue;
    let title = htmlToText(tag(item, 'title'));
    let company = '';
    if (cfg.title_split && title.includes(cfg.title_split)) {
      const i = title.indexOf(cfg.title_split);
      company = title.slice(0, i).trim();
      title = title.slice(i + cfg.title_split.length).trim();
    }
    const summary = htmlToText(tag(item, 'description') || tag(item, 'summary') || tag(item, 'content'));
    let location = '';
    if (cfg.location_regex) {
      const m = summary.match(new RegExp(cfg.location_regex, 'i'));
      if (m) location = (m[1] || m[0]).trim();
    }
    const categories = [...item.matchAll(/<category\b[^>]*>([\s\S]*?)<\/category>/gi)].map((m) => decode(m[1]).trim())
      .concat([...item.matchAll(/<category\b[^>]*term="([^"]+)"/gi)].map((m) => decode(m[1])));
    const date = tag(item, 'pubDate') || tag(item, 'updated') || tag(item, 'published');
    out.push({ url, title, company, location, date, summary, categories });
  }
  return out;
}

async function get(url) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'application/rss+xml, application/atom+xml, text/html;q=0.9, */*;q=0.5' },
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) return { status: res.status };
    return { status: 200, text: await res.text() };
  } catch (e) {
    return { status: 0, error: e.message };
  }
}

async function readFeed(name) {
  const cfg = config()[name];
  if (!cfg || !cfg.url) return { status: 'missing', items: [] };
  const r = await get(cfg.url);
  if (r.status !== 200) return { status: r.status, error: r.error, items: [] };
  return { status: 200, items: parseFeed(r.text, cfg) };
}

// The posting's main text: <article>, then <main>, then the whole body.
function mainText(html) {
  const pick = (re) => { const m = html.match(re); return m ? m[0] : null; };
  const block = pick(/<article\b[\s\S]*?<\/article>/i) || pick(/<main\b[\s\S]*?<\/main>/i)
    || pick(/<body\b[\s\S]*?<\/body>/i) || html;
  return htmlToText(block);
}

// A matches job for one feed item; the full page when details are on.
async function job(name, item) {
  const cfg = config()[name] || {};
  const facts = [item.summary, item.categories.length ? `Tags: ${item.categories.join(', ')}` : ''].filter(Boolean);
  let text = '';
  if (cfg.details !== false) {
    const r = await get(item.url);
    if (r.status === 404 || r.status === 410) return { status: r.status };
    if (r.status === 200) text = mainText(r.text);
  }
  return {
    status: 200,
    job: {
      url: item.url,
      title: item.title,
      company: item.company,
      location: item.location,
      platform: name,
      apply_link: '',
      description: [...facts, text, `[From the ${name} feed${text ? ' and the vacancy page' : ''}.]`].filter(Boolean).join('\n\n'),
    },
  };
}

const delayMs = (name) => 1000 * ((config()[name] || {}).delay_s ?? 5);

module.exports = { config, readFeed, parseFeed, job, delayMs, htmlToText, CONFIG_FILE };

// Quick check: node scripts/feeds.js
if (require.main === module) {
  (async () => {
    const feeds = config();
    if (!Object.keys(feeds).length) console.log(`no feeds configured in ${P.rel(CONFIG_FILE)}`);
    for (const name of Object.keys(feeds)) {
      const r = await readFeed(name);
      console.log(`${name}: ${r.status === 200 ? `${r.items.length} item(s)` : `${r.status} ${r.error || ''}`}`);
      for (const it of r.items.slice(0, 5)) console.log(`    ${it.company || '?'} — ${it.title}  [${it.location || '?'}]`);
    }
  })();
}
