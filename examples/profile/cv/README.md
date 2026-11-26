# CV variants

Each `.md` file here is one complete CV variant: YAML frontmatter (`title`,
`summary`, optional `photo`, `max_pages`, `language`) followed by a body that
uses the macros defined in `templates/cv.tex`:

```
\cvsection{Experience}
\cventry{2019 — 2024}{Digital Editor}{Harbourline Archive}
\cvdesc{...}
\cveducation{2015 — 2017}{MA Cultural Heritage}
\cvskill{Label}{Skills}
```

Name and contact details come from `profile.json` (`sender`). The master source
for all experience blocks is `warehouse.md`; variants are hand-picked
selections from it.

## Which variant when

| Variant | When |
|---|---|
| `content-editor` | Default. Editorial roles: digital editor, web editor, content designer |
| `cms-migration` | The system leads: CMS owner, website migration, content operations |

Keep this table current: `prompts/metadata.md` must offer the same variants,
because it picks the `cv_variant` for every new application folder.

Organisation-specific variants go in `company/`. They are not built by
`npm run build-cv`, but work as a `cv_variant`.

## Rules

- One page, unless `max_pages: 2` in the frontmatter. Both builders report an overflow as an error.
- `&` in a macro must be `\&`.
- No blank line directly after the opening `---`.
- Quote a value that contains `: `.
- Keep a photo small: it is printed at ~35 mm, so 800 px is plenty.
