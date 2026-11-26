# Job application workflow

Job applications run as a repository: finding vacancies, judging them, writing
letters, building CVs and documents, tracking outcomes. Operated together with
an AI agent (built for [Claude Code](https://claude.com/claude-code)).

Most job tools optimise for volume: more sources, more matches, more
applications sent automatically. This kit does the opposite. It finds fewer
vacancies, judges them against **your own written rules**, and helps you write
letters that are true and specific enough to send. You make every decision; the
agent does the reading, sorting, drafting and typesetting.

It grew out of a year of one person's real search. The engine is generic. What
made it work was the profile: written-down evidence, claim limits, decision
rules and a style guide that every letter is held to.

## What it does

```
find        chrome-search   Indeed + LinkedIn through your own logged-in browser
                            (Claude in Chrome), LinkedIn's public pages, optional
                            Nationale Vacaturebank (NL), public ATS boards
sieve       triage          one cheap model call per 40 job cards: reject only on
                            explicit rules, calibrated by what you chose before
score       score           full text vs. your scoring prompt, home distance
                            check, duplicate check against earlier applications
review      y / n / later   nothing you haven't seen is ever consumed
evaluate    evaluate        a deeper fit analysis per vacancy
write       pack / draft    vacancy + research + CV + style rules + earlier letters
                            that led to interviews, for a chat or the API
build       build           letter and CV PDFs with your own LaTeX templates,
                            one page enforced, typography checked
track       submit/outcome  pending -> invited / rejected / withdrawn, or parked
```

## Why search through your own browser

Keyword matching across aggregated feeds misses roles that don't have a clean
title. A hybrid role is a "web editor" at one employer and a "digital
coordinator" at the next. The search here uses your own search terms on the
platforms themselves, reads the full text and judges it against your rules.
It covers far fewer sources than an aggregator. For one person's search, the
results can be better.

## Quick start

Requirements: Node 18+, Python 3.10+, [pandoc](https://pandoc.org) and a LaTeX
distribution with LuaLaTeX (TeX Live or MiKTeX), poppler-utils (`pdftotext`,
`pdfinfo`). For the browser search: Claude Code with the Claude in Chrome
extension.

```sh
git clone <this repo> && cd job-application-workflow
npm install
python -m venv venv && venv/bin/pip install -r requirements.txt   # Windows: venv\Scripts\pip
cp .env.example .env            # add your Anthropic API key

# Try it with the fictitious example profile:
mkdir -p active && cp -r examples/application/Example_Library active/
npm run build Example_Library   # -> active/Example_Library/outputs/*.pdf
```

Then make it yours. Keep everything personal in a **workspace** next to this
repo, so the two never mix:

```sh
mkdir ../my-applications
cp -r examples/profile ../my-applications/profile
echo "WORKSPACE_DIR=../my-applications" >> .env
cd ../my-applications && git init   # private: never push this anywhere public
```

```
job-application-workflow/     the engine: public, pull updates, send pull requests
my-applications/              yours: private repo
  profile/                    who you are, your rules, CVs, prompts, templates
  active/  submitted/  archive/   your applications and their history
  state/  output/             search state and built CVs (gitignore these)
```

Edit the profile in this order: `profile.json`, `PROFILE.md`, `warehouse.md`,
a CV variant in `cv/`, `STYLEGUIDE.md`, the prompts in `prompts/`, the search
terms in `search/queries.json`, and finally the templates (your look).

Without `WORKSPACE_DIR` it all lives inside this repo instead, gitignored. That
works, but the workspace is easier to back up and keeps your clone clean.

## A day with it

```sh
npm run chrome-search           # search round (costs a few browser sessions)
npm run score                   # score new finds, review them: y / n <reason> / l / o / d / s
npm run evaluate                # deep check of what you said yes to
npm run pack Example_Org        # paste into a chat, or: npm run draft Example_Org
npm run build Example_Org       # PDFs
npm run submit Example_Org      # after sending
npm run rank                    # deadlines first
```

Or simply ask the agent: "run a search round and show me what's worth reading".
`CLAUDE.md` tells it how the repository works.

## The profile

| File | Purpose |
|---|---|
| `PROFILE.md` | Who you are, the evidence, what you may and may not claim, what the search is for |
| `STYLEGUIDE.md` | Checkable rules for letters: structure, sentence length, banned phrases, fixed closing |
| `warehouse.md` | Every experience block in detail. Letters and CVs may only use what is here |
| `cv/` | CV variants, each one page, picked per vacancy |
| `prompts/scoring.md` | How a vacancy is scored, with calibration examples |
| `prompts/triage.md` | When a job card may be rejected on its title alone (rule codes) |
| `prompts/metadata.md` | Which CV variant fits which role; how to write the email hook |
| `search/queries.json` | Search terms per platform; quick, full and deep presets |
| `templates/` | Your letter, CV and document design |
| `memory/` | What the agent should remember between sessions |

The scoring, triage and metadata prompts are where your judgement lives. Write
down every time the model gets it wrong, and why. A year of those notes is what
makes the scoring good.

## Costs

Scoring and triage use a small model (fractions of a cent per vacancy). Browser
sessions for Indeed cost more; `state/chrome_cost.log` records every session, so
you can tune batch sizes and models on real numbers. LinkedIn keyword searches,
LinkedIn job pages and Nationale Vacaturebank need no browser.

## Limits

- The browser search is tested on Indeed NL and LinkedIn. Indeed's page structure
  differs a little per country; the snippets in `scripts/prompts/` may need a tweak.
- Respect each platform's terms. Everything here reads pages you can open
  yourself, at a human pace, in your own session; nothing applies on your behalf.
- No email sending: you send applications yourself.

## Make it your own

Fork it, change it, build your own version: that's the point. A search in
another country, another profession or another language needs other search
sources, prompts and templates, and the engine is meant to be bent that way.

Because everything personal lives in your workspace, your fork holds only code.
That keeps two things easy:

- **Taking updates:** `git pull upstream main` never touches your profile or
  applications.
- **Giving back:** a fix or a new source in the engine can go straight into a
  pull request, with nothing private to untangle.

Contributions that are especially welcome:

- Search sources for other countries and job boards
- Example profiles for other professions (fictitious people only)
- Templates: other letter and CV designs
- Fixes when a platform changes its pages

Before opening a pull request, check the diff for anything personal: names,
addresses, real employers from your own search. Personal data belongs in the
workspace, never in the engine or `examples/`.

## License

MIT. Use it, change it, share it, sell it. Just keep the license file in your
copy.
