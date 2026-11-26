## Task: collect result cards

Visit the search pages under **Mode** exactly as listed, in that order
(search term, region, radius and search window are already in the URL). You
open **no** detail pages and judge nothing: take every card, including
obviously irrelevant ones. The script deduplicates and triages afterwards.

Always read the cards **with the snippets below** — not from
`get_page_text`, which does not contain the vacancy IDs.

*Indeed* — `javascript_tool`:

```js
const S = v => String(v ?? '').replace(/[?&=;|]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 90);
// The account menu is only there when logged in; the label depends on the site's language.
const header = document.querySelector('header, #gnav-main-container')?.innerText || '';
const loggedIn = /Messages|Berichten|Nachrichten|Messages|Mensajes/i.test(header) && !/^\s*Sign in\s*$/im.test(header);
const cards = [...document.querySelectorAll('a[data-jk]')].map(a => {
  const c = a.closest('td.resultContent') || a.closest('li') || a.parentElement;
  return [a.dataset.jk, a.innerText, c.querySelector('[data-testid="company-name"]')?.innerText,
    c.querySelector('[data-testid="text-location"]')?.innerText].map(S).join(' | ');
});
`logged_in: ${loggedIn}\n` + cards.join('\n')
```

`logged_in: false` = `logged_out`. Zero cards: check with `get_page_text`
whether there is a "no results" message (`empty`) or a wall.

*LinkedIn (search page and Recommended)* — LinkedIn has two layouts and picks
one itself (a search URL may redirect to `/jobs/search-results/`). The
snippets recognise both.

1. `javascript_tool` — wait for the list, detect the layout and return the
   scroll position:

```js
const wait = ms => new Promise(r => setTimeout(r, ms));
const NEW = 'div[componentkey^="job-card-component-ref-"]', CLASSIC = 'li[data-occludable-job-id]';
for (let i = 0; i < 20 && !document.querySelector(`${NEW}, ${CLASSIC}`); i++) await wait(500);
const isNew = !!document.querySelector(NEW);
const lis = [...document.querySelectorAll(CLASSIC)];
let box = lis[0]?.parentElement;
while (box && !(box.scrollHeight > box.clientHeight + 10 && /(auto|scroll)/.test(getComputedStyle(box).overflowY))) box = box.parentElement;
const r = box?.getBoundingClientRect();
JSON.stringify({ path: location.pathname, layout: isNew ? 'new' : 'classic',
  total: isNew ? new Set([...document.querySelectorAll(NEW)].map(c => c.getAttribute('componentkey'))).size : lis.length,
  rendered: isNew ? null : lis.filter(li => li.querySelector('a[href*="/jobs/view/"]')).length,
  scrollpoint: !isNew && r ? [Math.round(r.left + r.width / 2), Math.round(r.top + Math.min(r.height, innerHeight - r.top) / 2)] : null })
```

   `path` containing `/login`, `/authwall` or `/checkpoint` = `logged_out`.
2. Only with `layout: "classic"`: scroll with `computer` (`action: "scroll"`,
   `scroll_direction: "down"`, `scroll_amount: 10`) at `scrollpoint`, two or
   three times, until `rendered` equals `total` (run step 1 again to count).
   The new layout renders all cards at once.
3. `javascript_tool` — read the cards (all text is sanitised; the tool blocks
   output that looks like a query string). Output: three header lines, then
   one line per card. Run it twice, with `PART = 0` and `PART = 1`, and
   combine both halves:

```js
const S = v => String(v ?? '').replace(/[?&=;|]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 90);
const fresh = [...document.querySelectorAll('div[componentkey^="job-card-component-ref-"]')];
const ids = new Set();
const cards = fresh.length
  ? fresh.map(c => {
      const id = c.getAttribute('componentkey').slice('job-card-component-ref-'.length);
      if (ids.has(id)) return null;
      ids.add(id);
      const l = (c.innerText || '').split('\n').map(x => x.trim()).filter(Boolean);
      return [id, S(l[0]), S(l[1]), S(l[2])];
    }).filter(Boolean)
  : [...document.querySelectorAll('li[data-occludable-job-id]')].map(li => [li.dataset.occludableJobId,
      S((li.querySelector('a[href*="/jobs/view/"]')?.innerText || '').split('\n')[0]),
      S(li.querySelector('.artdeco-entity-lockup__subtitle')?.innerText),
      S(li.querySelector('.artdeco-entity-lockup__caption')?.innerText)]);
// The new layout ignores the location in the URL and uses the location saved
// in the account; it is shown under "NN results".
const where = fresh.length ? S((document.body.innerText.match(/\n[^\n]*results?\n+([^\n]+)\n/) || [])[1]) : '';
// Per half: long output gets truncated. Run with PART = 0, then PART = 1.
const PART = 0;
const half = Math.ceil(cards.length / 2);
[`layout: ${fresh.length ? 'new' : 'classic'}`, `location: ${where}`, `part ${PART + 1}/2, cards ${cards.length}`,
  ...cards.slice(PART * half, (PART + 1) * half).map(k => k.join(' | '))].join('\n')
```

## Writing the output

Write the batch file under **Mode** in one go at the end (`Write` only).
Copy the card lines **verbatim** as the snippet returned them
(`id | title | company | location`, one string per card), grouped per search
page with the `nr` from the Mode list. Do not rewrite or translate anything;
the script splits the lines itself:

```json
{
  "pages": [
    { "nr": 1, "status": "ok", "layout": "classic", "location": "",
      "cards": ["4f2a... | Web editor | Example Foundation | Springfield"] },
    { "nr": 2, "status": "logged_out", "cards": [] }
  ]
}
```

- One entry per search page in the Mode list, also when you could not read it.
- `status`: `ok`, `empty` (loaded fine, no results), `logged_out`,
  `captcha`, `blocked` or `error`.
- Never invent or rewrite IDs; leave out a card without an ID.
- LinkedIn: copy `layout` and `location` from snippet 3 (Indeed: omit).
