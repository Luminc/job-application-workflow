Analyse a job vacancy and extract metadata as JSON.

Return exactly this JSON format:
{
  "company": "official organisation name (in full); if the text names no organisation, use the job site's",
  "position": "job title exactly as in the vacancy, without the organisation name",
  "contact_name": "first and last name of the contact person if mentioned, else null",
  "contact_email": "email address if mentioned, else null",
  "salutation": "Dear [First name]" if a name is found, else "Dear hiring team",
  "subject": "Application [position]",
  "hours": "hours per week as text (e.g. 32 hours), else null",
  "salary": "salary indication as text, else null",
  "deadline": "application deadline as a readable date (e.g. 12 October 2026), else null; without a year, take the next occurrence from today",
  "deadline_iso": "the same deadline as YYYY-MM-DD, else null",
  "language": "en, or nl when the vacancy is written in Dutch",
  "cv_variant": "one of the variants below",
  "email_lead": "one or two short sentences that spark curiosity and stick: a concrete image or tension from this organisation's work, with the mission coming along naturally. It follows a fixed opening line that already names the position, so don't repeat the job title. No generic mission line, no colon"
}

cv_variant choice:
- content-editor: default. Editorial roles: digital editor, web editor, content designer, writer
- cms-migration: the system leads: CMS owner, website migration, content operations, information architecture

Today's date and the organisation according to the job site are above the
vacancy text. Never invent an organisation name and never write "not stated":
no name in the text = the job site's name.

Reply ONLY as JSON, no other text.
