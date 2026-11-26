# Style guide — cover letters (example)

> Hard rules for `letter-input.md`. Goal: every letter sounds like you,
> whichever agent or session drafts it. Adapt the rules to your own voice and
> language; keep them concrete and checkable.

---

## File layout

```yaml
---
recipient:
  - Organisation name
  - Attn. First Last            # only when a name is known
salutation: Dear First          # informal when the posting is informal; otherwise Dear Mr/Ms Last
email: contact@organisation.example
subject: Application Digital Editor
cv_variant: content-editor
position: Digital Editor
company_slug: Organisation_Name
language: en
email_lead: <hook for the email, see below>
---

[Letter body. No salutation and no closing: the template adds both.
 Start with the first paragraph.]
```

**email_lead:** the email opens with a fixed line naming the position, then the
lead. Don't repeat the role. The lead is a hook: one or two short sentences with
a concrete image or tension from the organisation's work. A generic mission line
("I'd love to contribute to your mission") is not a hook. No colon (YAML).

---

## Length and structure

~250 words, three or four paragraphs, no headings, no bullets.

1. **Opening:** why this organisation. Something specific from their own text or work, not "I'm excited about your mission."
2. **What I do and how it fits:** concrete experience that maps onto the core tasks.
3. **Depth:** one concrete example that proves the posting was read. Name a gap honestly, briefly, without apology, and turn it to an adjacent skill.
4. **Closing:** always: *"I'd welcome the chance to explain my motivation in a conversation. My CV is attached."*

Never open with "I am writing to apply for…" or "With great interest…".

---

## Sentence level

- **Rhythm:** alternate long and short sentences. Let a short sentence land after a longer build-up.
- **Maximum ~20 words per sentence.**
- **Active voice, with an actor:** "I rebuilt the content model", not "the content model was rebuilt".
- **No nominalisations:** "migrating", not "the implementation of a migration".
- **No hyperbole or empty claims:** "team player", "passionate", "results-driven" say nothing; an example proves the trait implicitly.
- **Understatement beats persuasion.**

## The bridge between their work and yours

Not "I like your mission", but a specific line between what they do and what you
have done:

1. **Mirror:** recognise a structural feature of the role (two audiences, expert knowledge made accessible, system plus content) in your own work, and name it as the same pattern.
2. **Admit what is new:** name a missing skill briefly and link it to an adjacent one.

---

## Checklist before building

- [ ] Opens with something specific about this organisation
- [ ] No "I am writing to apply"
- [ ] No sentence over ~20 words; active voice; no nominalisations
- [ ] At least one concrete, checkable example from the evidence in PROFILE.md
- [ ] Gaps named honestly, without apology
- [ ] Ends with the fixed closing sentence
- [ ] ~250 words, no headings or bullets
- [ ] `salutation`, `email` and recipient match the posting
