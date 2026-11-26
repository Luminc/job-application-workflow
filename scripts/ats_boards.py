#!/usr/bin/env python3
"""
Fetch vacancies straight from applicant tracking systems.

Scraping career pages with CSS selectors is unworkable: the pages are
single-page apps, the URLs rot, and generic selectors pick up navigation as
job titles. Most employers publish the same vacancies through an ATS that
exposes clean public JSON: stable, no rendering, full description included.

The boards to follow live in the profile: search/ats_boards.json

    {
      "boards": [ {"name": "Example Museum", "provider": "greenhouse", "slug": "examplemuseum"} ],
      "local_hints": ["utrecht", "netherlands"],     # on-site roles kept when the location matches
      "remote_hints": ["netherlands", "europe", "emea"]   # remote roles kept when the location matches
    }

Find a board slug before adding it:

    python scripts/ats_boards.py --probe examplemuseum acme
    python scripts/ats_boards.py            # list what the configured boards have now
"""

from __future__ import annotations

import argparse
import json
import sys
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from lib import profile as P  # noqa: E402

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/130.0 Safari/537.36")

TIMEOUT = 15


def _config() -> dict:
    text = P.read_profile_file("search", "ats_boards.json")
    return json.loads(text) if text else {"boards": []}


# Location strings that state no country at all. Kept, because only the
# posting itself can tell where the role can be done from.
UNSCOPED_LOCATIONS = ("", "anywhere", "remote", "worldwide", "global")


def _get_json(url: str):
    req = urllib.request.Request(url, headers={"User-Agent": UA,
                                               "Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as exc:
        raise RuntimeError(f"HTTP {exc.code}") from exc
    except Exception as exc:
        raise RuntimeError(type(exc).__name__) from exc


# ---------------------------------------------------------------------------
# Providers. Each returns a list of normalised dicts.
# ---------------------------------------------------------------------------

def fetch_workable(slug: str) -> list[dict]:
    data = _get_json(
        f"https://apply.workable.com/api/v1/widget/accounts/{slug}?details=true")
    out = []
    for j in data.get("jobs", []):
        city, country = j.get("city") or "", j.get("country") or ""
        out.append({
            "title": j.get("title", "").strip(),
            "url": j.get("url") or j.get("shortlink") or "",
            "location": ", ".join(p for p in (city, country) if p),
            "remote": bool(j.get("telecommuting")),
            "description": j.get("description", "") or "",
            "department": j.get("department") or "",
        })
    return out


def fetch_greenhouse(slug: str) -> list[dict]:
    data = _get_json(
        f"https://boards-api.greenhouse.io/v1/boards/{slug}/jobs?content=true")
    out = []
    for j in data.get("jobs", []):
        loc = (j.get("location") or {}).get("name", "")
        out.append({
            "title": j.get("title", "").strip(),
            "url": j.get("absolute_url", ""),
            "location": loc,
            "remote": "remote" in loc.lower(),
            "description": j.get("content", "") or "",
            "department": "",
        })
    return out


def fetch_lever(slug: str) -> list[dict]:
    data = _get_json(f"https://api.lever.co/v0/postings/{slug}?mode=json")
    out = []
    for j in data:
        loc = (j.get("categories") or {}).get("location", "") or ""
        out.append({
            "title": j.get("text", "").strip(),
            "url": j.get("hostedUrl", ""),
            "location": loc,
            "remote": "remote" in loc.lower(),
            "description": j.get("descriptionPlain", "") or "",
            "department": (j.get("categories") or {}).get("team", "") or "",
        })
    return out


def fetch_recruitee(slug: str) -> list[dict]:
    data = _get_json(f"https://{slug}.recruitee.com/api/offers/")
    out = []
    for j in data.get("offers", []):
        loc = ", ".join(p for p in (j.get("city") or "", j.get("country") or "") if p)
        out.append({
            "title": (j.get("title") or "").strip(),
            "url": j.get("careers_url") or "",
            "location": loc,
            "remote": bool(j.get("remote")),
            "description": "\n\n".join(p for p in (j.get("description"), j.get("requirements")) if p),
            "department": j.get("department") or "",
        })
    return out


def fetch_ashby(slug: str) -> list[dict]:
    data = _get_json(f"https://api.ashbyhq.com/posting-api/job-board/{slug}")
    out = []
    for j in data.get("jobs", []):
        out.append({
            "title": (j.get("title") or "").strip(),
            "url": j.get("jobUrl") or "",
            "location": j.get("location") or "",
            "remote": bool(j.get("isRemote")),
            "description": j.get("descriptionPlain") or "",
            "department": j.get("department") or "",
        })
    return out


PROVIDERS = {
    "workable": fetch_workable,
    "greenhouse": fetch_greenhouse,
    "lever": fetch_lever,
    "recruitee": fetch_recruitee,
    "ashby": fetch_ashby,
}


def is_relevant(job: dict, cfg: dict) -> bool:
    """On-site near home, or remote somewhere you can be employed.

    A remote role tied to another country usually needs work authorisation
    there, so remote is kept only for the profile's remote_hints or for
    postings that name no country."""
    loc = (job.get("location") or "").strip().lower()
    if any(h.lower() in loc for h in cfg.get("local_hints", [])):
        return True
    if not job.get("remote"):
        return False
    if loc in UNSCOPED_LOCATIONS:
        return True
    return any(h.lower() in loc for h in cfg.get("remote_hints", []))


def fetch_all(all_locations: bool = False, verbose: bool = True) -> list[dict]:
    """Every configured board, in the shape the scraper's pipeline expects."""
    cfg = _config()
    listings: list[dict] = []
    if verbose and not cfg.get("boards"):
        print("  no boards configured (profile: search/ats_boards.json)")
    for board in cfg.get("boards", []):
        name, provider, slug = board["name"], board["provider"], board["slug"]
        fetch = PROVIDERS.get(provider)
        if fetch is None:
            if verbose:
                print(f"  {name}... unknown provider '{provider}'")
            continue
        if verbose:
            print(f"  {name}...", end="", flush=True)
        try:
            jobs = fetch(slug)
        except RuntimeError as exc:
            if verbose:
                print(f" failed ({exc})")
            continue

        kept = jobs if all_locations else [j for j in jobs if is_relevant(j, cfg)]
        if verbose:
            extra = "" if all_locations else f" of {len(jobs)}"
            print(f" {len(kept)} vacancies{extra}")

        for j in kept:
            if not j["title"] or not j["url"]:
                continue
            listings.append({
                "title": f"{name}: {j['title']}",
                "url": j["url"],
                "source": "ats",
                "company": name,
                "location": j["location"],
                # Full text is already in the payload; no detail fetch needed.
                "description": j["description"],
            })
    return listings


def probe(slugs: list[str]) -> None:
    """Check which providers know a slug, before adding it to ats_boards.json."""
    cfg = _config()
    for slug in slugs:
        hits = []
        for provider, fetch in PROVIDERS.items():
            try:
                jobs = fetch(slug)
            except RuntimeError:
                continue
            near = sum(1 for j in jobs if is_relevant(j, cfg))
            hits.append(f"{provider} ({len(jobs)} jobs, {near} local/remote)")
        print(f"  {slug:<16} {'; '.join(hits) if hits else 'no board found'}")


def main() -> int:
    ap = argparse.ArgumentParser(description="Fetch vacancies from ATS boards.")
    ap.add_argument("--probe", nargs="+", metavar="SLUG",
                    help="Test slugs against every provider")
    ap.add_argument("--all-locations", action="store_true",
                    help="Do not filter on location")
    args = ap.parse_args()

    if args.probe:
        probe(args.probe)
        return 0

    listings = fetch_all(all_locations=args.all_locations)
    print(f"\n{len(listings)} vacancies")
    for l in listings:
        print(f"  {l['title'][:64]:<64} {l['location'][:26]}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
