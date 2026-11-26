## Task: fetch vacancy texts

Visit every URL under **Mode** and copy the vacancy. The script has already
deduplicated and triaged: skip nothing, not even a marketing role.

Copy: title, company, location, the apply link, and the **full vacancy text
verbatim** — do not summarise, shorten or rephrase. Keep paragraphs as
`\n\n`; every line on the page (including a bullet line) becomes its own
paragraph.

*Indeed* — `javascript_tool` after loading:

```js
const wait = ms => new Promise(r => setTimeout(r, ms));
const t = s => (document.querySelector(s)?.innerText || '').trim();
// Strip query strings from links in the text: the tool blocks output that looks like one.
const clean = s => s.replace(/(https?:\/\/[^\s?#]+)[?#]\S*/g, '$1');
// Easy pace: Indeed pages opened in quick succession trigger a Cloudflare check.
await wait(2500 + Math.random() * 2000);
for (let i = 0; i < 12 && !t('#jobDescriptionText'); i++) await wait(500);
JSON.stringify({
  title: t('h1'),
  company: t('[data-testid="inlineHeader-companyName"]'),
  location: t('[data-testid="inlineHeader-companyLocation"]') || t('[data-testid="job-location"]'),
  header: t('#salaryInfoAndJobType'),
  external: /company site|website van werkgever|employer's website/i.test(document.body.innerText),
  text: clean(t('#jobDescriptionText'))
})
```

- Put `header` (employment type and salary, e.g. "Part-time, Permanent" and
  "€3,000 - €4,000 a month") as the first paragraph(s) before `text`.
- `external: true` → `apply_link` = `https://<the Indeed domain of the URL>/applystart?jk=<jk>`;
  otherwise (only "Easily apply") leave `apply_link` empty.
- If `text` is empty or shorter than 200 characters: read with
  `get_page_text`; the text sits between the "Full job description" heading
  and "Report job" (or their equivalents in the site's language).

*LinkedIn* — open `https://www.linkedin.com/jobs/view/<id>/`, then
`javascript_tool`:

```js
const wait = ms => new Promise(r => setTimeout(r, ms));
const t = s => (document.querySelector(s)?.innerText || '').trim();
// Strip query strings from links in the text: the tool blocks output that looks like one.
const clean = s => s.replace(/(https?:\/\/[^\s?#]+)[?#]\S*/g, '$1');
const TEXT = '#job-details, .jobs-description__content, [id^="JobDetails_AboutTheJob_"]';
for (let i = 0; i < 10 && !t(TEXT); i++) await wait(500);
document.querySelector('.jobs-description__footer-button, .show-more-less-html__button')?.click();
await wait(300);
JSON.stringify({
  path: location.pathname,
  title: t('.job-details-jobs-unified-top-card__job-title') || t('h1'),
  company: t('.job-details-jobs-unified-top-card__company-name'),
  location: t('.job-details-jobs-unified-top-card__primary-description-container').split('·')[0].trim(),
  easy_apply: /Easy Apply|Eenvoudig solliciteren/i.test(t('.jobs-apply-button--top-card, .jobs-s-apply')),
  text: clean(t(TEXT))
})
```

- If `text` is empty (LinkedIn does not render because the tab is in the
  background): scroll with `computer` (`action: "scroll"`,
  `scroll_direction: "down"`, `scroll_amount: 5`) in the middle of the page,
  wait 2 seconds and run the snippet again. Still empty: `get_page_text`, and
  leave out "About the company", applicant statistics and "similar jobs".
- `apply_link`: empty with `easy_apply`; otherwise the link behind "Apply"
  (external) without a query string, if you can see it, else empty.

Everywhere leave out: cookie/privacy blocks and navigation. End every
description with `[Full text fetched via Claude in Chrome.]`

If a vacancy has expired or been removed: do not include it, put the URL in
`expired`.

Use exactly the URL from the Mode list as `url`.

## Writing the output

Write the batch file under **Mode** in one go at the end (`Write` only;
correct mistakes by writing the whole file again):

```json
{
  "jobs": [
    {
      "url": "...", "title": "...", "company": "...", "location": "...",
      "platform": "Indeed|LinkedIn", "apply_link": "...", "description": "..."
    }
  ],
  "expired": [],
  "status": "ok|logged_out|captcha|blocked|error"
}
```

`status` is `ok` unless you hit a wall (see above). If nothing is left,
write the file anyway with empty lists.
