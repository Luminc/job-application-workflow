#!/usr/bin/env python3
"""
Score vacancies against your profile and review them one by one.

Intake, in one run:
  matches   state/matches.json, written by chrome-fetch.js (default source).
            Full vacancy texts; title rejections from its triage are recorded
            as "triaged" so they are not shown again (but stay revisable).
  ats       public boards listed in <profile>/search/ats_boards.json
            (Greenhouse, Lever, Workable, Recruitee, Ashby).
  --url / --urls-file
            hand-picked links, fetched with a generic page reader.

Every new vacancy is scored once by a cheap model with the profile's
prompts/scoring.md, then lands in the inbox (state/inbox.json). The review
shows the inbox best-first; only a real decision moves a vacancy into
state/seen.json, so nothing you haven't looked at gets consumed.

Usage:
    npm run score                      # matches + review
    npm run score -- --source ats      # ATS boards
    npm run score -- --source all
    npm run score -- --url https://...
    npm run review                     # only the inbox, no intake
    npm run score -- --dry-run         # writes nothing to state/
"""

import argparse
import json
import os
import re
import sys
import time
from datetime import date, timedelta
from pathlib import Path

# Windows' console defaults to cp1252; scoring reasons routinely contain
# characters it can't encode, which crashes a bare print() mid-review.
if sys.platform == "win32":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

import anthropic
import requests
from bs4 import BeautifulSoup
from dotenv import load_dotenv

SCRIPT_DIR = Path(__file__).parent
ROOT_DIR = SCRIPT_DIR.parent
sys.path.insert(0, str(ROOT_DIR))
sys.path.insert(0, str(SCRIPT_DIR))
from lib import profile as P  # noqa: E402
import ats_boards  # noqa: E402

load_dotenv(ROOT_DIR / ".env")

SEEN_FILE = P.state_path("seen.json")
INBOX_FILE = P.state_path("inbox.json")
MATCHES_FILE = P.state_path("matches.json")
ACTIVE_DIR = P.work_path("active")
SUBMITTED_DIR = P.work_path("submitted")

SCORING_MODEL = os.environ.get("SCORING_MODEL", "claude-haiku-4-5")
METADATA_MODEL = os.environ.get("METADATA_MODEL", "claude-haiku-4-5")

HOME = P.home()
HOME_LAT, HOME_LON = HOME.get("lat"), HOME.get("lon")
HOME_LABEL = HOME.get("label", "home")
HOME_COUNTRY = HOME.get("country", "")
# Straight-line km beyond which an on-site vacancy is dropped before scoring.
MAX_COMMUTE_KM = HOME.get("max_commute_km", 40)

DEFAULT_MIN_SCORE = 5
# Values of "source" in matches.json that name a separate intake channel.
CHANNELS = ("chrome", "manual", "linkedin-guest", "nvb")

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/130.0.0.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xhtml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en;q=0.9,*;q=0.5",
}

SCORING_SYSTEM_PROMPT = P.read_profile_file("prompts", "scoring.md", required=True)
METADATA_SYSTEM_PROMPT = P.read_profile_file("prompts", "metadata.md", required=True)


# ---------------------------------------------------------------------------
# Seen-vacancies persistence
# ---------------------------------------------------------------------------

def _load_json_state(path: Path) -> dict:
    """Read a state file. A corrupt file aborts the run instead of being
    treated as empty: the old fallback to {} meant the next save would
    silently overwrite the whole history."""
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        print(f"\n[error] {path.name} is not valid JSON ({exc}).")
        print("       Repair the file before continuing; nothing was overwritten.")
        sys.exit(1)


def load_seen() -> dict:
    return _load_json_state(SEEN_FILE)


def load_inbox() -> dict:
    """Scored vacancies still waiting for a yes/no decision.

    Kept apart from seen_vacancies.json so that skipping the rest of a
    review (s), deferring one (l) or an accidental Ctrl+C never consumes a
    vacancy you haven't actually looked at. Next run shows them again
    without rescoring."""
    return _load_json_state(INBOX_FILE)


_DRY_RUN = False
_dry_run_warned = False


def save_seen(seen: dict):
    """Since 2026-09-26 only decisions land here (see record_decision);
    scored-but-undecided vacancies live in inbox.json. --dry-run still
    turns every state write into a no-op for mechanics tests."""
    _write_state(SEEN_FILE, seen)


def save_inbox(inbox: dict):
    _write_state(INBOX_FILE, inbox)


def _write_state(path: Path, data: dict):
    global _dry_run_warned
    if _DRY_RUN:
        if not _dry_run_warned:
            print("\n  [--dry-run] state/seen.json and state/inbox.json are not written.")
            _dry_run_warned = True
        return
    # Write-then-replace, so a crash mid-write can't leave half a file.
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
    os.replace(tmp, path)


def record_decision(seen: dict, url: str, listing: dict, detail: dict,
                    score_info: dict | None, decision: str, note: str = "",
                    folder_created: bool = False):
    """Move a vacancy into seen_vacancies.json with the reason it left.

    decision is one of:
      yes        -- j: application folder created
      no         -- n: your call, optionally with a note ("n te junior")
      auto-skip  -- scored below the default threshold, never shown
      filtered   -- dropped before scoring (distance, US-only)
      triaged    -- dropped on title by the chrome-fetch triage; a soft
                    decision: if the vacancy comes back (own link,
                    chrome-fetch --retriage) it is scored after all

    Storing score + reason next to your own decision is what makes it
    possible to check later whether the Haiku score agrees with you."""
    score_info = score_info or {}
    entry = {
        "title": listing.get("title", ""),
        "company": (detail or {}).get("company") or listing.get("company", ""),
        "seen_at": str(date.today()),
        "source": listing_origin(listing),
        "folder_created": folder_created,
        "decision": decision,
    }
    if score_info.get("score") is not None:
        entry["score"] = score_info["score"]
    if score_info.get("reason"):
        entry["reason"] = score_info["reason"]
    if note:
        entry["note"] = note
    seen[url] = entry


SEEN_STALE_DAYS = 150  # ~5 months


def prune_stale_seen(seen: dict) -> tuple[dict, int]:
    """Drop seen entries older than SEEN_STALE_DAYS that never became an
    application folder, so a vacancy reposted or reopened under the same
    URL (some ATS boards reuse the job-ID slug) gets a second chance
    instead of being skipped forever. Entries that did become a folder are
    kept permanently -- we never want to re-surface something already
    applied to."""
    cutoff = date.today() - timedelta(days=SEEN_STALE_DAYS)
    pruned = {}
    dropped = 0
    for url, entry in seen.items():
        seen_at = entry.get("seen_at") if isinstance(entry, dict) else None
        folder_created = entry.get("folder_created", False) if isinstance(entry, dict) else False
        if not folder_created and seen_at:
            try:
                if date.fromisoformat(seen_at) < cutoff:
                    dropped += 1
                    continue
            except ValueError:
                pass
        pruned[url] = entry
    return pruned, dropped


# ---------------------------------------------------------------------------
# Distance estimation
# ---------------------------------------------------------------------------
# Search engines' own radius filters leak: a 25 km search around one town has
# returned on-site vacancies 90-200 km away. This estimates straight-line
# distance independently with free geocoding (OpenStreetMap Nominatim), so an
# on-site vacancy far beyond a realistic commute is dropped before scoring.
# Straight-line is deliberate: routing needs a paid API, and "wrong side of
# the country" is the failure mode that matters.
GEOCODE_CACHE_FILE = P.state_path("geocode_cache.json")
# Location strings that name no place to travel to.
_GENERIC_LOCATION_MARKERS = tuple(m.lower() for m in HOME.get("generic_location_markers", [
    "remote", "anywhere", "worldwide", "nationwide", "work from home",
]))
_HYBRID_MARKERS = tuple(m.lower() for m in HOME.get("hybrid_markers", ["hybrid"]))

# Indeed prefixes locations with a commute estimate ("45 min.·Town") or
# "Hybrid work in Town"; both break geocoding.
_LOCATION_COMMUTE_PREFIX_RE = re.compile(r"^\s*\d+\+?\s*min\.?\s*[·.\-]\s*", re.IGNORECASE)
_LOCATION_HYBRID_PREFIX_RE = re.compile(r"^\s*(hybrid(e)?\s+(work|werken)\s+in)\s+", re.IGNORECASE)


def _clean_location_for_geocoding(location: str) -> str:
    loc = _LOCATION_COMMUTE_PREFIX_RE.sub("", location or "").strip()
    loc = _LOCATION_HYBRID_PREFIX_RE.sub("", loc).strip()
    return loc


def _location_is_hybrid_or_remote(location: str) -> bool:
    lower = (location or "").lower()
    return any(m in lower for m in _HYBRID_MARKERS) or any(m in lower for m in _GENERIC_LOCATION_MARKERS)


def _load_geocode_cache() -> dict:
    if GEOCODE_CACHE_FILE.exists():
        try:
            return json.loads(GEOCODE_CACHE_FILE.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            return {}
    return {}


def _save_geocode_cache(cache: dict):
    if _DRY_RUN:
        return
    GEOCODE_CACHE_FILE.write_text(json.dumps(cache, indent=2, ensure_ascii=False), encoding="utf-8")


_geocode_cache = _load_geocode_cache()


def _haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    from math import radians, sin, cos, asin, sqrt
    lat1, lon1, lat2, lon2 = map(radians, (lat1, lon1, lat2, lon2))
    dlat, dlon = lat2 - lat1, lon2 - lon1
    a = sin(dlat / 2) ** 2 + cos(lat1) * cos(lat2) * sin(dlon / 2) ** 2
    return 2 * 6371 * asin(sqrt(a))


def estimate_distance_km(location: str) -> float | None:
    """Straight-line km from the profile's home to a free-text location, or
    None if home is not configured, the string is empty or generic
    (remote/nationwide), or it didn't geocode. Cached per location string:
    Nominatim's usage policy allows about one request per second."""
    if HOME_LAT is None or HOME_LON is None:
        return None
    loc = _clean_location_for_geocoding(location)
    if not loc or any(m in loc.lower() for m in _GENERIC_LOCATION_MARKERS):
        return None

    cache_key = loc.lower()
    if cache_key in _geocode_cache:
        return _geocode_cache[cache_key].get("distance_km")

    try:
        query = f"{loc}, {HOME_COUNTRY}" if HOME_COUNTRY and HOME_COUNTRY.lower() not in loc.lower() else loc
        resp = requests.get(
            "https://nominatim.openstreetmap.org/search",
            params={"q": query, "format": "json", "limit": 1},
            headers={"User-Agent": "job-application-workflow/1.0 (personal job search tool)"},
            timeout=10,
        )
        time.sleep(1.0)  # Nominatim usage policy: max ~1 request/sec
        results = resp.json() if resp.status_code == 200 else []
        if not results:
            _geocode_cache[cache_key] = {"distance_km": None}
            _save_geocode_cache(_geocode_cache)
            return None
        lat, lon = float(results[0]["lat"]), float(results[0]["lon"])
        distance = round(_haversine_km(HOME_LAT, HOME_LON, lat, lon), 1)
        _geocode_cache[cache_key] = {"distance_km": distance}
        _save_geocode_cache(_geocode_cache)
        return distance
    except Exception:
        return None  # transient failure -- don't cache, retry next run


def load_matches_file(path: Path) -> tuple[list[dict], dict]:
    """Read a matches file: state/matches.json from chrome-fetch.js, or any
    export in the same shape (e.g. from a job-board connector). Listings arrive
    with their full text and need no detail fetch.

    Accepts either a bare list of jobs or {"loops": {...}, "jobs": [...]}.
    Returns (listings, loops) where loops maps search_id -> {label, cv_variant}.
    """
    data = json.loads(path.read_text(encoding="utf-8"))
    if isinstance(data, list):
        jobs, loops = data, {}
    else:
        jobs, loops = data.get("jobs", []), data.get("loops", {})

    listings = []
    for j in jobs:
        url = (j.get("url") or "").strip()
        if not url:
            continue
        search_id = j.get("search_id") or ""
        listings.append({
            "title": j.get("title") or j.get("job_title") or "Vacancy",
            "job_title": j.get("job_title") or j.get("title") or "",
            "url": url,
            "company": j.get("company", ""),
            "location": j.get("location", ""),
            "description": j.get("description", ""),
            "apply_link": j.get("apply_link") or "",
            "platform": j.get("platform") or "",
            "search_id": search_id,
            # An explicit per-search variant beats the metadata model's guess.
            "cv_variant": j.get("cv_variant") or loops.get(search_id, {}).get("cv_variant") or "",
            # "matches" picks the processing path (full text, no fetch); the
            # channel records where the vacancy actually came from.
            "source": "matches",
            "channel": j.get("source") if (j.get("source") in CHANNELS
                                           or str(j.get("source", "")).startswith("portal:")) else "",
        })
    print(f"  {len(listings)} vacancies in {path.name}")
    return listings, loops


def load_triaged_out(path: Path) -> list[dict]:
    """Vacancies the chrome-fetch triage dropped on title before opening them.

    Recorded as "triaged" (since 2026-10-08; before that "filtered") so they
    keep an audit trail and are not triaged again every search round, while
    chrome-fetch --retriage can still bring them back after a prompt change."""
    data = json.loads(path.read_text(encoding="utf-8"))
    if isinstance(data, list):
        return []
    out = []
    for t in data.get("triaged_out", []):
        url = (t.get("url") or "").strip()
        if not url:
            continue
        company, title = t.get("company", ""), t.get("title", "")
        out.append({
            "title": f"{company}: {title}" if company and title else (title or company or url),
            "url": url,
            "company": company,
            "location": t.get("location", ""),
            "source": "matches",
            "channel": "chrome",
            "reason": t.get("reason", ""),
            "rule": t.get("rule", ""),
        })
    return out


def listing_origin(listing: dict) -> str:
    """Where a vacancy came from, for seen/inbox and labels."""
    return listing.get("channel") or listing.get("source", "url")


def find_in_submitted(slug: str) -> str | None:
    """Return relative path if company folder already exists anywhere in submitted/."""
    if not SUBMITTED_DIR.exists():
        return None
    for path in SUBMITTED_DIR.rglob("*"):
        if path.is_dir() and path.name == slug:
            return P.rel(path)
    return None


# Same vacancy or same organisation as an existing application folder,
# across platforms: one vacancy on two job boards under two company names, or
# one public-sector role reposted by several recruitment agencies.
# Only a warning in the review; the decision stays with you.
#
# Two signals, measured on ~140 real application folders:
#   text  shared 6-word phrases in the vacancy text: real duplicates and
#         same-organisation boilerplate 107-654, unrelated pairs at most 25
#   name  one company name contains the other, or the folder's company is
#         named in the new text (an agency rewrite: 22 shared phrases, but
#         the employer's name in the agency's text)
DUP_SHARED_PHRASES = 60
DUP_PHRASE_WORDS = 6
ARCHIVE_DIR = P.work_path("archive")


def _job_text(md: str) -> str:
    m = re.search(r"^## Job Posting\s*\n(.*?)(?=^## (?!Job Posting)|\Z)", md, re.S | re.M)
    return m.group(1) if m else ""


def _phrases(text: str) -> set[str]:
    w = re.findall(r"[a-zà-ÿ0-9]+", text.lower())
    n = DUP_PHRASE_WORDS
    return {" ".join(w[i:i + n]) for i in range(len(w) - n + 1)}


def _norm_company(name: str) -> str:
    return " ".join(re.findall(r"[a-zà-ÿ0-9]+", (name or "").lower()))


def _contains_name(haystack: str, name: str) -> bool:
    return bool(name) and re.search(rf"\b{re.escape(name)}\b", haystack) is not None


def similar_applications(company: str, description: str, url: str = "") -> list[str]:
    """Existing application folders that look like the same vacancy or the
    same organisation, as printable lines (strongest first)."""
    roots = [ACTIVE_DIR, SUBMITTED_DIR, ARCHIVE_DIR / "parked"]
    new_company = _norm_company(company)
    new_text = _norm_company(description)
    new_phrases = _phrases(description)
    hits = []
    for base in roots:
        if not base.exists():
            continue
        for md_path in base.rglob("vacancy.md"):
            try:
                md = md_path.read_text(encoding="utf-8")
            except OSError:
                continue
            head = md[:3000]
            m_url = re.search(r"^url:\s*(\S+)", head, re.M)
            if url and m_url and m_url.group(1) == url:
                continue
            m_co = re.search(r"^company:\s*(.+)$", head, re.M)
            m_pos = re.search(r"^position:\s*(.+)$", head, re.M)
            folder_company = _norm_company(m_co.group(1) if m_co else md_path.parent.name.replace("_", " "))
            shared = len(new_phrases & _phrases(_job_text(md)))
            reasons = []
            if shared >= DUP_SHARED_PHRASES:
                reasons.append(f"{shared} shared phrases")
            if len(new_company) >= 4 and len(folder_company) >= 4 and (
                    _contains_name(new_company, folder_company) or _contains_name(folder_company, new_company)):
                reasons.append("same organisation")
            # Only a real company: field; a folder name can be a region
            # ("Zuid_holland" matched every text about Zuid-Holland).
            elif m_co and len(folder_company) >= 8 and " " in folder_company and _contains_name(new_text, folder_company):
                reasons.append(f"text names {m_co.group(1).strip()}")
            if not reasons:
                continue
            where = P.rel(md_path.parent)
            if not m_pos:
                letter = md_path.parent / "letter-input.md"
                if letter.exists():
                    m_pos = re.search(r"^position:\s*(.+)$", letter.read_text(encoding="utf-8")[:3000], re.M)
            position = (m_pos.group(1).strip().strip('"') if m_pos else "?")
            hits.append((shared, f"Looks like {where} ({position}): {', '.join(reasons)}"))
    return [line for _, line in sorted(hits, reverse=True)]


def vacancy_key(url: str) -> str:
    """The vacancy behind a URL, the same IDs as vacancyId() in
    chrome-fetch.js: different routes write one LinkedIn or
    Indeed vacancy with different tracking params. Other URLs compare as-is."""
    m = re.search(r"indeed\.com/.*[?&]jk=([0-9a-f]{16})", url, re.I)
    if m:
        return f"indeed:{m.group(1).lower()}"
    m = re.search(r"linkedin\.com/jobs/view/(?:[^/?]*-)?(\d{6,})", url, re.I)
    if m:
        return f"linkedin:{m.group(1)}"
    m = re.search(r"nationalevacaturebank\.nl/vacature/([0-9a-f-]{36})", url, re.I)
    if m:
        return f"nvb:{m.group(1).lower()}"
    return url.strip().rstrip("/")


def application_folders_by_url() -> dict[str, str]:
    """vacancy_key -> folder for every application in active/, submitted/
    and archive/parked/. Older folders only have a "- **URL:**" line."""
    index = {}
    for base in (ACTIVE_DIR, SUBMITTED_DIR, ARCHIVE_DIR / "parked"):
        if not base.exists():
            continue
        for md_path in base.rglob("vacancy.md"):
            try:
                md = md_path.read_text(encoding="utf-8")
            except OSError:
                continue
            m = (re.search(r"^url:\s*(\S+)", md[:3000], re.M)
                 or re.search(r"\*\*URL:\*\*\s*(\S+)", md))
            if m:
                where = P.rel(md_path.parent)
                index.setdefault(vacancy_key(m.group(1)), where)
    return index


# ---------------------------------------------------------------------------
# HTTP helpers
# ---------------------------------------------------------------------------

def get_soup(url: str, session, headers: dict | None = None,
             quiet: bool = False) -> BeautifulSoup | None:
    hdrs = headers if headers is not None else HEADERS
    try:
        resp = session.get(url, headers=hdrs, timeout=20)
        resp.raise_for_status()
        # Hand BeautifulSoup the raw bytes. resp.text would use requests'
        # guessed encoding, which falls back to ISO-8859-1 when the response
        # carries no charset -- that renders non-Latin pages as mojibake.
        return BeautifulSoup(resp.content, "html.parser")
    except Exception as exc:
        # Catches both requests.RequestException and curl_cffi exceptions
        if not quiet:
            status = getattr(exc, "code", None) or getattr(getattr(exc, "response", None), "status_code", "")
            label = f" (HTTP {status})" if status else ""
            print(f"  [error{label}] {url[:80]}: {type(exc).__name__}")
        return None



# ---------------------------------------------------------------------------
# Detail pages for hand-picked URLs (generic reader)
# ---------------------------------------------------------------------------

_HOURS_PATTERN = re.compile(
    r"(\d{2,3}[\s\-]*uur|\d{1,2}[\-–]\d{2}\s*uur|\d{2,3}\s*u(?:ur)?|\d{1,2}\s*à\s*\d{2}\s*uur)",
    re.I,
)
_SALARY_PATTERN = re.compile(
    r"(€\s*[\d\.,]+(?:\s*[-–]\s*[\d\.,]+)?(?:\s*/\s*\w+)?|schaal\s+\d+|cao[\s-]\w+)",
    re.I,
)
_DEADLINE_PATTERN = re.compile(
    r"\d{1,2}\s+(?:januari|februari|maart|april|mei|juni|juli|augustus|"
    r"september|oktober|november|december)\s+\d{4}"
    r"|\d{1,2}[-/]\d{1,2}[-/]\d{2,4}",
    re.I,
)


def _first_match(pattern: re.Pattern, text: str) -> str:
    m = pattern.search(text)
    return m.group(0).strip() if m else ""


def scrape_detail(url: str, session: requests.Session) -> dict:
    """Read a vacancy page with generic selectors. For pages that need a
    login or JavaScript, use chrome-fetch (npm run chrome-fetch)."""
    soup = get_soup(url, session)
    if soup is None:
        return {}

    # Title — prefer h1, fallback to h2.entry-title
    title = ""
    for sel in ["h1.entry-title", "h1", "h2.entry-title", ".page-title"]:
        el = soup.select_one(sel)
        if el and el.get_text(strip=True):
            title = el.get_text(strip=True)
            break

    # Company — try dedicated elements first
    company = ""
    for sel in [
        ".company-name", ".employer-name", ".organization", ".bedrijf",
        ".entry-meta .company", "span.company", ".job-company",
        "[class*='company']", "[class*='employer']", "[class*='organisatie']",
    ]:
        el = soup.select_one(sel)
        if el and el.get_text(strip=True):
            company = el.get_text(strip=True)
            break

    # Main content for description
    description = ""
    for sel in [".entry-content", ".job-description", ".vacancy-content",
                ".post-content", "article .content", "main article", "article"]:
        el = soup.select_one(sel)
        if el:
            description = el.get_text(separator="\n", strip=True)
            break

    if not description:
        # Broad fallback
        description = soup.get_text(separator="\n", strip=True)

    # Contact email
    email = ""
    mailto = soup.select_one('a[href^="mailto:"]')
    if mailto:
        email = mailto["href"].replace("mailto:", "").split("?")[0].strip()

    return {
        "title": title,
        "company": company,
        "description": description,
        "email": email,
        "hours": _first_match(_HOURS_PATTERN, description),
        "salary": _first_match(_SALARY_PATTERN, description),
        "deadline": _first_match(_DEADLINE_PATTERN, description),
    }


# ---------------------------------------------------------------------------
# Scoring — Claude API
# ---------------------------------------------------------------------------

def score_vacancy(title: str, company: str, description: str,
                  client: anthropic.Anthropic,
                  scoring_prompt: str = SCORING_SYSTEM_PROMPT) -> dict:
    """Return {score, reason, hours, salary, deadline} from the scoring model.

    On failure score is None, not a made-up number: the old fallback of 5
    sat exactly on the default --min-score, so a failed call looked like a
    lukewarm match. A None score keeps the vacancy out of seen and inbox,
    so the next run simply tries again."""
    # Full texts are often 4-8k chars; a 2500 cut dropped requirements and
    # conditions, which sit at the end of most posts.
    content = (
        f"Vacancy: {title}\n"
        f"Company: {company}\n\n"
        f"{description[:7000]}"
    )
    try:
        msg = client.messages.create(
            model=SCORING_MODEL,
            max_tokens=300,
            system=scoring_prompt,
            messages=[{"role": "user", "content": content}],
        )
        raw = msg.content[0].text.strip()
        # Extract JSON even if there's surrounding text
        json_match = re.search(r'\{[^{}]+\}', raw)
        result = json.loads(json_match.group(0) if json_match else raw)
    except Exception as exc:
        return {"score": None, "reason": f"Scoring failed: {exc}"}

    # A prompt written in another language may answer with its own keys
    # (e.g. Dutch reden/uren/salaris); normalise to one shape.
    for en, other in (("reason", "reden"), ("hours", "uren"), ("salary", "salaris")):
        if other in result and en not in result:
            result[en] = result.pop(other)
    try:
        result["score"] = int(round(float(result.get("score"))))
    except (TypeError, ValueError):
        return {"score": None, "reason": f"Unreadable score: {raw[:80]}"}
    return result


def extract_vacancy_metadata(
    listing_title: str,
    description: str,
    listing_url: str,
    client: anthropic.Anthropic,
    metadata_prompt: str = METADATA_SYSTEM_PROMPT,
    listing_company: str = "",
) -> dict:
    """Extract structured metadata from a vacancy with the profile's
    prompts/metadata.md.

    The site's company and today's date go along: without them a small model
    borrows a company name from the CV-variant list, writes "not stated" as
    the organisation, or dates a deadline without a year in the past."""
    content = (
        f"Today: {date.today().isoformat()}\n"
        + (f"Organisation according to the job site: {listing_company}\n" if listing_company else "")
        + f"Listing title: {listing_title}\n"
        f"URL: {listing_url}\n\n"
        f"{description[:9000]}"
    )
    try:
        msg = client.messages.create(
            model=METADATA_MODEL,
            max_tokens=600,
            system=metadata_prompt,
            messages=[{"role": "user", "content": content}],
        )
        raw = msg.content[0].text.strip()
        json_match = re.search(r"\{.*\}", raw, re.DOTALL)
        if json_match:
            return json.loads(json_match.group(0))
        return json.loads(raw)
    except Exception:
        # Graceful fallback: parse what we can from the listing title
        company, position = listing_title.split(": ", 1) if ": " in listing_title else (listing_title, listing_title)
        return {
            "company": company,
            "position": position,
            "contact_name": None,
            "contact_email": None,
            "salutation": None,
            "hours": None,
            "salary": None,
            "deadline": None,
            "cv_variant": P.default_cv_variant(),
            "email_lead": None,
        }


# ---------------------------------------------------------------------------
# Folder creation
# ---------------------------------------------------------------------------

def make_slug(name: str) -> str:
    """Convert a name to a folder-safe slug (e.g. 'Acme Museum' → 'Acme_Museum')."""
    slug = re.sub(r"[^\w\s\-]", "", name, flags=re.UNICODE)
    slug = re.sub(r"[\s\-]+", "_", slug.strip())
    return slug


def parse_company_and_title(listing: dict, detail: dict) -> tuple[str, str]:
    """
    Resolve company name and job title from listing + detail data.

    Some job boards use a "Company: Position" listing title,
    which is the most reliable source when the detail page doesn't expose
    a dedicated company element.
    """
    listing_title = listing.get("title", "")
    company = (detail.get("company") or "").strip()
    title = (detail.get("title") or "").strip()

    # Detail page title is sometimes garbage (navigation text injected into h1).
    # Treat it as unreliable if it's suspiciously long or matches the listing title.
    if len(title) > 120 or title == listing_title:
        title = ""

    # Primary fallback: split listing title on "Company: Position" (site convention)
    if ": " in listing_title:
        parts = listing_title.split(": ", 1)
        if not company:
            company = parts[0].strip()
        if not title:
            title = parts[1].strip()

    # Secondary fallback: dash separators in whatever title we have
    if not company:
        for sep in (" \u2014 ", " - "):
            combined = title or listing_title
            if sep in combined:
                left, right = combined.split(sep, 1)
                company, title = left.strip(), right.strip()
                break

    # Final fallback: use full listing title as job title, mark company unknown
    if not title:
        title = listing_title
    if not company:
        company = listing_title.split(":")[0].strip() or "Unknown"

    return company, title


def _source_label(source: str) -> str:
    """Human-readable source name for vacancy.md."""
    return {
        "indeed": "Indeed NL",
        "matches": "matches file",
        "ats": "ATS board",
        "url": "hand-picked URL",
        "chrome": "Claude in Chrome (Indeed / LinkedIn)",
        "linkedin-guest": "LinkedIn (public job page)",
        "nvb": "Nationale Vacaturebank",
        "manual": "Handmatig (Indeed / LinkedIn)",
    }.get(source, f"{source[7:]} (community portal)" if source.startswith("portal:") else source)


def _yaml_scalar(value) -> str:
    """Quote a frontmatter value only when plain YAML would misread it.

    A colon-space inside a plain scalar ("...comes together: content...")
    makes pandoc fail with 'mapping values are not allowed'. JSON string syntax is valid YAML double-quoted syntax."""
    text = "" if value is None else str(value)
    if (": " in text or " #" in text or text[:1] in "\"'&*!|>%@`[]{},-?#"
            or text != text.strip()):
        return json.dumps(text, ensure_ascii=False)
    return text


def _role_suffix(title: str) -> str:
    """First three words of a job title, folder-safe -- same shape as
    slugifyRole() in scripts/prior-applications.js."""
    words = re.sub(r"[^\w\s\-]", "", title.replace("&", "en"), flags=re.UNICODE).split()
    return "_".join(words[:3])


def _free_slug(company: str, title: str) -> str | None:
    """Folder name for a new application, or None if even the role-specific
    name is taken.

    The company name alone collides as soon as you apply to the same
    organisation twice (active/Acme next to submitted/rejected/Acme), and
    manage-outcome then refuses the move. So a second vacancy at a known
    organisation gets Company_Role, the same convention submit uses."""
    base = make_slug(company)
    if not (ACTIVE_DIR / base).exists() and not find_in_submitted(base):
        return base
    role = _role_suffix(title)
    if role:
        candidate = f"{base}_{role}"
        if not (ACTIVE_DIR / candidate).exists() and not find_in_submitted(candidate):
            return candidate
    return None


def create_application_folder(
    listing: dict, detail: dict, score_info: dict, metadata: dict
) -> str | None:
    """Create active/<Slug>/ with vacancy.md, letter-input.md, and outputs/.
    Returns the folder name, or None if nothing was created."""
    company = (metadata.get("company") or "").strip()
    title = (metadata.get("position") or "").strip()

    # Fallback to regex-parsed values if AI extraction failed
    if not company or not title:
        company_fb, title_fb = parse_company_and_title(listing, detail)
        company = company or company_fb
        title = title or title_fb

    # A company name that is neither in the text nor the site's own name was
    # made up; the site's name wins. An agency listing whose text names the
    # real employer keeps that employer, since it is in the text.
    site_company = (listing.get("company") or detail.get("company") or "").strip()
    norm, site_norm = _norm_company(company), _norm_company(site_company)
    if site_norm and norm and not (
            _contains_name(_norm_company(detail.get("description", "")), norm)
            or _contains_name(norm, site_norm) or _contains_name(site_norm, norm)):
        print(f"  [!] Organisation \"{company}\" is not in the text; using the job site's: {site_company}")
        company = site_company

    # company_slug in letter-input.md stays the bare organisation: that is
    # what prior-applications.js matches earlier applications on.
    company_slug = make_slug(company)
    # Checked again here: a second run can create the folder while this
    # review is open.
    existing = application_folders_by_url().get(vacancy_key(listing.get("url") or ""))
    if existing:
        print(f"  [!] This vacancy already has a folder: {existing} - skipped")
        return None
    slug = _free_slug(company, title)
    if slug is None:
        print(f"  [!] active/{company_slug}/ (also with role name) exists - skipped")
        return None
    folder = ACTIVE_DIR / slug

    (folder / "outputs").mkdir(parents=True)

    # Pull fields from AI metadata, fall back to regex-extracted detail values
    contact_name = metadata.get("contact_name")
    contact_email = metadata.get("contact_email") or detail.get("email") or ""
    salutation = metadata.get("salutation") or "[Dear Name]"
    cv_variant = metadata.get("cv_variant") or P.default_cv_variant()
    if cv_variant not in P.cv_variants():
        print(f"  [!] CV variant '{cv_variant}' does not exist; using {P.default_cv_variant()}")
        cv_variant = P.default_cv_variant()
    email_lead = metadata.get("email_lead") or "[A hook: one or two sentences; see STYLEGUIDE.md]"
    hours = metadata.get("hours") or detail.get("hours") or ""
    salary = metadata.get("salary") or detail.get("salary") or ""
    deadline = metadata.get("deadline") or detail.get("deadline") or ""
    deadline_iso = metadata.get("deadline_iso") or ""
    try:
        deadline_iso = date.fromisoformat(deadline_iso).isoformat() if deadline_iso else ""
    except ValueError:
        deadline_iso = ""
    # A deadline months before a vacancy found today is a guessed year (a
    # text without one): roll it to the next occurrence and say so.
    if deadline_iso and date.fromisoformat(deadline_iso) < date.today() - timedelta(days=60):
        d = date.fromisoformat(deadline_iso)
        while d < date.today():
            try:
                d = d.replace(year=d.year + 1)
            except ValueError:  # 29 February
                d = d.replace(year=d.year + 1, day=28)
        print(f"  [!] Deadline {deadline_iso} was in the past; assuming {d.isoformat()}")
        old_year = deadline_iso[:4]
        deadline_iso = d.isoformat()
        deadline = (deadline.replace(old_year, str(d.year)) if old_year in deadline else deadline) or d.isoformat()
        deadline = f"{deadline} (year assumed)"
    source = listing_origin(listing)
    source_label = _source_label(source)

    recipient_lines = [f"  - {company}"]
    if contact_name:
        recipient_lines.append(f"  - {_yaml_scalar(contact_name)}")
    else:
        recipient_lines.append('  - "[Contact name]"')

    meta_lines = []
    if hours:
        meta_lines.append(f"- **Hours:** {hours}")
    if salary:
        meta_lines.append(f"- **Salary:** {salary}")
    if deadline:
        meta_lines.append(f"- **Deadline:** {deadline}")
    if contact_email:
        meta_lines.append(f"- **Contact:** {contact_email}")
    if contact_name:
        meta_lines.append(f"- **Contact person:** {contact_name}")
    meta_block = "\n".join(meta_lines) if meta_lines else "(none found)"

    # Machine-readable header for rank / dashboard / pack. The markdown body
    # below keeps its old shape, so existing regex readers still work.
    front = {
        "company": company,
        "position": title,
        "url": listing["url"],
        "apply_link": listing.get("apply_link") or "",
        "source": source,
        "platform": listing.get("platform") or "",
        "location": listing.get("location") or "",
        "distance_km": score_info.get("distance_km"),
        "score": score_info.get("score"),
        "score_reason": score_info.get("reason", ""),
        "hours": hours,
        "salary": salary,
        "deadline": deadline,
        "deadline_iso": deadline_iso,
        "found_at": str(date.today()),
        "status": "active",
    }
    front_block = "\n".join(
        f"{k}: {_yaml_scalar(v)}" for k, v in front.items() if v not in (None, "")
    )

    vacancy_content = f"---\n{front_block}\n---\n\n" + f"""\
# {company}

## Job Posting

{detail.get('description', '(no description found)')}

## Company Info

- **Name:** {company}
- **URL:** {listing['url']}
- **Source:** {source_label}

## Extracted Details

{meta_block}

## Application Notes

- Position: {title}
- Score: {score_info.get('score', '?')}/10 - {score_info.get('reason', '')}
- Applied:
- Source: {source_label}
"""

    language = metadata.get("language") or P.profile().get("language", "en")
    # The metadata prompt writes the subject in the vacancy's language.
    subject = metadata.get("subject") or f"Application {title}"
    language_line = f"language: {language}\n"

    letter_content = f"""\
---
recipient:
{chr(10).join(recipient_lines)}
salutation: {_yaml_scalar(salutation)}
email: {contact_email}
subject: {_yaml_scalar(subject)}
cv_variant: {cv_variant}
position: {_yaml_scalar(title)}
company_slug: {company_slug}
{language_line}email_lead: {_yaml_scalar(email_lead)}
---
"""

    (folder / "vacancy.md").write_text(vacancy_content, encoding="utf-8")
    (folder / "letter-input.md").write_text(letter_content, encoding="utf-8")

    print(f"  [OK] created active/{slug}/")
    print(f"    -> {title}")
    print(f"    -> CV: {cv_variant} | contact: {contact_name or '(unknown)'} | email: {contact_email or '(unknown)'}")
    return slug


# ---------------------------------------------------------------------------
# Terminal output
# ---------------------------------------------------------------------------

def print_vacancy_card(listing: dict, detail: dict, score_info: dict,
                       scored_at: str | None = None):
    score = score_info.get("score", "?")
    reason = score_info.get("reason", "")
    title = detail.get("title") or listing["title"]
    company = detail.get("company") or ""
    source = listing_origin(listing)

    if isinstance(score, int):
        bar = "#" * score + "-" * (10 - score)
    else:
        bar = "?" * 10

    # Page-scraped fields first; otherwise what the scoring call read from
    # the text (the only source for matches, which have no detail page).
    hours = detail.get("hours") or score_info.get("uren")
    salary = detail.get("salary") or score_info.get("salaris")
    deadline = detail.get("deadline") or score_info.get("deadline")
    meta = []
    if hours:
        meta.append(str(hours))
    if salary:
        meta.append(str(salary)[:35])
    if deadline:
        meta.append(f"deadline {deadline}")
    location = listing.get("location", "")
    if location:
        # Cache hit only here (already computed once during scoring) --
        # no extra network call for a card that's just being reprinted.
        distance_km = estimate_distance_km(location)
        distance_tag = f", ~{distance_km:.0f}km" if distance_km is not None else ""
        meta.append(f"{location}{distance_tag}")
    meta.append(f"[{_source_label(source)}]")

    print(f"\n{'=' * 62}")
    header = f"[{score}/10]  {company + ' - ' if company else ''}{title}"
    print(header[:78])
    print(f"  {bar}")
    if meta:
        print(f"  {' | '.join(meta)}")
    print(f"  {reason}")
    if scored_at and scored_at != str(date.today()):
        print(f"  (in the inbox since {scored_at})")
    print(f"  {listing['url']}")



# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Score vacancies and create application folders.")
    parser.add_argument("--source", choices=["matches", "ats", "all"], default="matches",
                        help="matches = state/matches.json from chrome-fetch (default); ats = boards in "
                             "the profile's search/ats_boards.json; all = both")
    parser.add_argument("--matches-file", metavar="PATH", default=None,
                        help="Another file in the matches format (default: state/matches.json)")
    parser.add_argument("--url", help="Score one hand-picked vacancy URL")
    parser.add_argument("--urls-file", metavar="PATH", help="Score every URL in a file (one per line, # = comment)")
    parser.add_argument("--min-score", type=int, default=DEFAULT_MIN_SCORE,
                        help=f"Hide vacancies below this score in the review (default: {DEFAULT_MIN_SCORE})")
    parser.add_argument("--review", action="store_true", help="Only review the inbox; no intake")
    parser.add_argument("--dry-run", action="store_true", help="Write nothing to state/ (for testing)")
    return parser.parse_args()


def main():
    _run(parse_args())


def _distance_filter(listing: dict, seen: dict) -> tuple[bool, float | None]:
    """(drop, distance_km). Search engines leak results far outside the
    requested radius, so an on-site vacancy beyond MAX_COMMUTE_KM is dropped
    here and recorded as filtered."""
    loc_text = listing.get("location", "")
    distance_km = estimate_distance_km(loc_text)
    if (distance_km is not None and distance_km > MAX_COMMUTE_KM
            and not _location_is_hybrid_or_remote(loc_text)):
        note = f"{distance_km:.0f}km > {MAX_COMMUTE_KM}km, not hybrid/remote"
        print(f" [skip: {note}]")
        record_decision(seen, listing["url"], listing, {}, None, "filtered", note=note)
        return True, distance_km
    return False, distance_km


def _run(args):
    global _DRY_RUN
    _DRY_RUN = args.dry_run

    print("=" * 62)
    print("  Vacancy scorer" + ("  —  inbox review only" if args.review else f"  —  source: {args.source}"))
    print(f"  Profile: {P.rel(P.PROFILE_DIR)}")
    if _DRY_RUN:
        print("  [--dry-run] nothing is written to state/")
    print("=" * 62)

    ACTIVE_DIR.mkdir(exist_ok=True)

    seen = load_seen()
    seen, dropped_stale = prune_stale_seen(seen)
    if dropped_stale:
        save_seen(seen)
    print(f"\nKnown vacancies: {len(seen)}" + (f"  ({dropped_stale} stale entries dropped)" if dropped_stale else ""))

    inbox = load_inbox()
    if inbox:
        print(f"Inbox (scored, undecided): {len(inbox)}")

    if not os.environ.get("ANTHROPIC_API_KEY"):
        print("\n[error] ANTHROPIC_API_KEY not set (put it in .env).")
        sys.exit(1)
    claude = anthropic.Anthropic()
    session = requests.Session()

    # ---- Step 1: intake ----------------------------------------------------
    listings: list[dict] = []
    hand_picked = bool(args.url or args.urls_file)
    if args.review:
        pass
    elif hand_picked:
        raw_urls = [args.url] if args.url else []
        if args.urls_file:
            path = Path(args.urls_file)
            if not path.exists():
                print(f"\n[!] File not found: {path}")
                sys.exit(1)
            raw_urls += [line.strip() for line in path.read_text(encoding="utf-8").splitlines()
                         if line.strip() and not line.strip().startswith("#")]
        print(f"\n[URLs] {len(raw_urls)}")
        listings = [{"title": "Hand-picked URL", "url": u, "source": "url"} for u in raw_urls]
    else:
        if args.source in ("matches", "all"):
            path = Path(args.matches_file) if args.matches_file else MATCHES_FILE
            if not path.exists():
                print(f"\n[matches] {path.name} not found — run npm run chrome-search first.")
                if args.source == "matches":
                    sys.exit(1)
            else:
                print(f"\n[matches] {path}")
                found, _ = load_matches_file(path)
                listings += found
                triaged = [t for t in load_triaged_out(path) if t["url"] not in seen and t["url"] not in inbox]
                for t in triaged:
                    rule = f" [{t['rule']}]" if t["rule"] else ""
                    record_decision(seen, t["url"], t, {}, None, "triaged",
                                    note=f"chrome-triage{rule}: {t['reason']}" if t["reason"] else f"chrome-triage{rule}")
                if triaged:
                    print(f"    {len(triaged)} dropped on title by the triage -> seen (triaged, revisable)")
        if args.source in ("ats", "all"):
            print("\n[ATS boards]")
            listings += ats_boards.fetch_all()

    # Deduplicate on the vacancy behind the URL
    unique: dict[str, dict] = {}
    for item in listings:
        unique.setdefault(vacancy_key(item["url"]), item)
    listings = list(unique.values())

    if hand_picked:
        # Chosen deliberately: the seen-list must not silently swallow it.
        new_listings = listings
    elif not args.review:
        # A title rejection ("triaged") is not a decision on the vacancy itself:
        # when it comes back with its full text, it gets scored.
        new_listings = [item for item in listings
                        if (item["url"] not in seen or seen[item["url"]].get("decision") == "triaged")
                        and item["url"] not in inbox]
        in_inbox = sum(1 for item in listings if item["url"] in inbox)
        print(f"\nFound: {len(listings)}  |  new: {len(new_listings)}" + (f"  (+{in_inbox} already in the inbox)" if in_inbox else ""))
    else:
        new_listings = []

    # ---- Step 2: details & score ---------------------------------------------
    if new_listings:
        print(f"\nScoring {len(new_listings)} vacancies...\n")

    for i, listing in enumerate(new_listings, 1):
        label = listing["title"][:55]
        print(f"  [{i:2d}/{len(new_listings)}] {label}...", end="", flush=True)

        src = listing.get("source", "url")
        distance_km = None
        if src in ("matches", "ats"):
            # Full text already delivered: no fetch.
            drop, distance_km = _distance_filter(listing, seen)
            if drop:
                continue
            parts = [listing.get("description", "")]
            if listing.get("location"):
                parts.append(f"Location: {listing['location']}")
            if distance_km is not None:
                parts.append(f"Distance to {HOME_LABEL} (estimated, straight line): ~{distance_km:.0f} km")
            if listing.get("apply_link"):
                parts.append(f"Apply link: {listing['apply_link']}")
            detail = {
                "title": listing.get("job_title") or listing["title"],
                "company": listing.get("company", ""),
                "description": "\n\n".join(p for p in parts if p),
            }
        else:
            detail = scrape_detail(listing["url"], session)
            time.sleep(1.0)

        score_info = score_vacancy(
            detail.get("title") or listing["title"],
            detail.get("company", ""),
            detail.get("description", ""),
            claude,
        )
        score = score_info.get("score")
        if score is None:
            # Not seen, not in the inbox: the next run tries again.
            print(f" [scoring failed, retried next run]  {score_info.get('reason', '')[:60]}")
            continue
        print(f" {score}/10" + (f"  ~{distance_km:.0f}km" if distance_km is not None else ""))

        if distance_km is not None:
            score_info["distance_km"] = round(distance_km)
        inbox[listing["url"]] = {
            "listing": listing,
            "detail": detail,
            "score_info": score_info,
            "scored_at": str(date.today()),
            "source": listing_origin(listing),
        }
        # Per item, so an abort mid-scoring doesn't waste the calls made.
        save_inbox(inbox)

    save_seen(seen)  # filtered + triaged entries

    review_inbox(inbox, seen, args, claude, METADATA_SYSTEM_PROMPT,
                 only_urls={item["url"] for item in new_listings} if hand_picked else None)


def _open_in_browser(url: str):
    import webbrowser
    try:
        webbrowser.open(url)
    except Exception as exc:
        print(f"  [!] Could not open the browser: {exc}")


def review_inbox(inbox: dict, seen: dict, args, claude, metadata_prompt: str,
                 only_urls: set[str] | None = None):
    """Go through scored, undecided vacancies, best score first.

    Only a real decision moves a vacancy out of the inbox into seen:
      j  create the application folder        -> decision "yes"
      n  not interested ("n te junior" saves the reason as a note)
      l  later: stays in the inbox for the next run
      o  open the URL in your browser (then asks again)
      d  print the full description here (LinkedIn needs a login to open)
      s  stop reviewing: everything not yet decided stays in the inbox
    Ctrl+C behaves like s. Nothing you haven't seen gets consumed.

    Two thresholds:
      below DEFAULT_MIN_SCORE (or --min-score if lower): auto-skip, recorded
        in seen with its score so the scorer can still be audited;
      between that and a raised --min-score: hidden for this run only, left
        in the inbox -- so scrape-strict or a test with --min-score 100 can't
        burn real leads any more.
    """
    queue = [
        (url, entry) for url, entry in inbox.items()
        if only_urls is None or url in only_urls
    ]
    if not queue:
        print("\nThe inbox is empty — nothing to review.")
        return

    queue.sort(key=lambda kv: kv[1]["score_info"].get("score") or 0, reverse=True)

    # A vacancy that already has a folder was decided back then (a second
    # review of the same batch once made Org_Role next to Org). Recorded as
    # yes, never asked again.
    folders = application_folders_by_url()
    already = [(u, e, folders[vacancy_key(u)]) for u, e in queue if vacancy_key(u) in folders]
    for url, entry, where in already:
        record_decision(seen, url, entry["listing"], entry["detail"], entry["score_info"], "yes",
                        note=f"map bestond al: {where}", folder_created=True)
        del inbox[url]
    if already:
        save_seen(seen)
        save_inbox(inbox)
        queue = [(u, e) for u, e in queue if u in inbox]

    consume_below = min(args.min_score, DEFAULT_MIN_SCORE)

    auto_skipped = [(u, e) for u, e in queue if (e["score_info"].get("score") or 0) < consume_below]
    for url, entry in auto_skipped:
        record_decision(seen, url, entry["listing"], entry["detail"], entry["score_info"], "auto-skip")
        del inbox[url]
    if auto_skipped:
        save_seen(seen)
        save_inbox(inbox)

    hidden = [(u, e) for u, e in queue
              if consume_below <= (e["score_info"].get("score") or 0) < args.min_score]
    to_review = [(u, e) for u, e in queue
                 if (e["score_info"].get("score") or 0) >= args.min_score]

    print(f"\n\n{'=' * 62}")
    print(f"  {len(to_review)} vacancies to review - best score first")
    if already:
        print(f"  {len(already)} already have a folder, recorded as yes")
        for _, _, where in already:
            print(f"    {where}")
    if auto_skipped:
        print(f"  {len(auto_skipped)} auto-skipped (score < {consume_below}), recorded with their score")
        for _, e in auto_skipped:
            si, li = e["score_info"], e["listing"]
            name = (e["detail"].get("company") or li.get("company") or "")[:25]
            print(f"    {si.get('score')}/10  {name} - {(e['detail'].get('title') or li['title'])[:40]}")
    if hidden:
        print(f"  {len(hidden)} hidden (score < {args.min_score}), staying in the inbox")
    print("  y=create folder  n=no (n <reason>)  l=later  o=open  d=description  s=stop")
    print(f"{'=' * 62}")

    decided = later = 0
    for idx, (url, entry) in enumerate(to_review, 1):
        listing, detail, score_info = entry["listing"], entry["detail"], entry["score_info"]
        print_vacancy_card(listing, detail, score_info, scored_at=entry.get("scored_at"))

        company_preview, title_preview = parse_company_and_title(listing, detail)
        slug_preview = make_slug(company_preview)
        if slug_preview == "Handpicked_URL" and detail.get("company"):
            slug_preview = make_slug(detail["company"])
        existing = find_in_submitted(slug_preview)
        if existing:
            print(f"  [!] Applied to this organisation before: {existing}")
        for line in similar_applications(detail.get("company") or company_preview,
                                         detail.get("description") or "", url):
            if not (existing and line.startswith(f"Looks like {existing} ")):
                print(f"  [!] {line}")
        print(f"  -> active/{slug_preview}/  ({detail.get('title') or title_preview})")
        print()

        while True:
            try:
                raw = input(f"  [{idx}/{len(to_review)}] y/n/l/o/d/s:  ").strip()
            except (EOFError, KeyboardInterrupt):
                raw = "s"
                print()
            ans, _, note = raw.partition(" ")
            ans = ans.lower()

            if ans in ("y", "yes", "j", "ja"):
                print("  Extracting metadata...", end="", flush=True)
                metadata = extract_vacancy_metadata(
                    listing["title"],
                    detail.get("description", ""),
                    url,
                    claude,
                    metadata_prompt=metadata_prompt,
                    listing_company=listing.get("company") or detail.get("company") or "",
                )
                print(" done")
                # A search that declares its CV variant beats the model's guess.
                if listing.get("cv_variant"):
                    metadata["cv_variant"] = listing["cv_variant"]
                created = create_application_folder(listing, detail, score_info, metadata)
                record_decision(seen, url, listing, detail, score_info, "yes",
                                note=note.strip(), folder_created=bool(created))
                break
            elif ans in ("n", "no"):
                record_decision(seen, url, listing, detail, score_info, "no", note=note.strip())
                break
            elif ans in ("l", "later"):
                later += 1
                break
            elif ans in ("o", "open"):
                _open_in_browser(url)
            elif ans in ("d", "tekst"):
                print("\n" + (detail.get("description") or "(no text)") + "\n")
            elif ans in ("s", "stop", "q"):
                left = len(to_review) - idx + 1
                print(f"\n  Stopped. {left} vacancies stay in the inbox: npm run review")
                save_seen(seen)
                save_inbox(inbox)
                return
            else:
                print("  y (create folder), n (no, optionally: n <reason>), l (later), "
                      "o (open URL), d (toon tekst), s (stop)")

        if ans not in ("l", "later"):
            decided += 1
            del inbox[url]
        save_seen(seen)
        save_inbox(inbox)

    print(f"\n{'=' * 62}")
    print(f"  Done! {decided} decided" + (f", {later} deferred" if later else ""))
    if inbox:
        print(f"  Inbox: {len(inbox)} — npm run review")
    print(f"{'=' * 62}\n")


if __name__ == "__main__":
    main()

