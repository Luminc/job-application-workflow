# Job application workflow — instructions for the agent

This repository runs one person's job search. The engine (scripts) is generic;
everything personal lives in the **workspace**: `$WORKSPACE_DIR` (usually a
separate private repo, set in `.env`), or this repo itself when unset. Paths
below like `active/` and `state/` are inside the workspace.

The **profile folder** is:

- `<workspace>/profile/` when it contains `profile.json`
- otherwise `examples/profile/` (a fictitious example)
- `$PROFILE_DIR` overrides both

Before writing, evaluating or advising, read the profile's `PROFILE.md` and
`STYLEGUIDE.md`. They are the standard, and they win over anything here for
their own domain (identity, evidence, claim limits, letter style).

## Layout

| Path | What |
|---|---|
| `<profile>/profile.json` | Name, contact details, home location, search area, default CV variant |
| `<profile>/PROFILE.md` | Identity, evidence, claim limits, what the search is for, lessons learned |
| `<profile>/STYLEGUIDE.md` | Hard rules for letters |
| `<profile>/warehouse.md` | Every experience block; the only source of claims |
| `<profile>/cv/*.md` | CV variants; `cv/README.md` says which one when |
| `<profile>/prompts/` | `scoring.md`, `triage.md`, `metadata.md`, `evaluate.md` |
| `<profile>/search/` | `queries.json`, `triage.json`, `ats_boards.json`, `portals.json` |
| `<profile>/templates/` | `letter.tex`, `cv.tex`, `document.tex`, `statement.tex` |
| `<profile>/memory/` | Status, strategy and lessons the agent keeps between sessions |
| `active/<Org>/` | One application: `vacancy.md`, `letter-input.md`, `outputs/` |
| `submitted/`, `archive/parked/` | Sent and abandoned applications |
| `state/` | Seen vacancies, inbox, search windows, caches (never edit by hand mid-run) |

## Pipeline

```
npm run chrome-search        find: Indeed/LinkedIn (+ community portals, optional NVB) -> title triage -> full texts -> state/matches.json
npm run portals -- "<term>"  check the configured community portals (scripts/portals.js)
npm run score                score every new vacancy, then review y/n/later -> active/<Org>/
npm run evaluate             deep fit check per active folder (deep_evaluation.md)
npm run pack <Org>           everything a chat needs to write the letter, on the clipboard
npm run build <Org>          letter + CV PDFs, one page each, layout checked
npm run submit <Org>         after sending: active/ -> submitted/pending/
npm run outcome <Org> invited|rejected|accepted|withdrawn
npm run outcome <Org> parked "reason"   decided not to apply
npm run rank | dashboard     what's urgent, what's waiting
```

## Rules

- Never invent experience, tools or numbers. Claims come from `warehouse.md` and `PROFILE.md`; respect the claim limits there.
- A draft letter is a draft: say so, and list open questions.
- Test the search and scoring code with `--dry-run` (scorer) or `--print-prompt` (chrome-fetch).
- Personal data never goes into the engine (scripts, `examples/`). It belongs in the workspace. Engine changes should be ones the user could send upstream as a pull request.
- The user decides what is sent. Never submit, email or apply on their behalf.
