"""The Python side of lib/profile.js: where the workspace, profile and state live.

The workspace ($WORKSPACE_DIR, or this repo when unset) holds profile/,
active/, submitted/, archive/, state/ and output/. See lib/profile.js.

Resolution order for the profile folder:
  1. $PROFILE_DIR
  2. <workspace>/profile/
  3. examples/profile/   the fictitious example, so a fresh clone runs
"""

from __future__ import annotations

import json
import os
from functools import lru_cache
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def _setting(name: str) -> str | None:
    """A setting from the environment, else from this repo's .env."""
    if os.environ.get(name):
        return os.environ[name]
    env_file = ROOT / ".env"
    if env_file.exists():
        for line in env_file.read_text(encoding="utf-8").splitlines():
            key, sep, value = line.partition("=")
            if sep and key.strip() == name and value.strip():
                return value.strip().strip("\"'")
    return None


WORKSPACE = (ROOT / _setting("WORKSPACE_DIR")).resolve() if _setting("WORKSPACE_DIR") else ROOT


def _resolve_profile_dir() -> Path:
    env = _setting("PROFILE_DIR")
    if env:
        return (ROOT / env).resolve()
    own = WORKSPACE / "profile"
    if (own / "profile.json").exists():
        return own
    return ROOT / "examples" / "profile"


PROFILE_DIR = _resolve_profile_dir()
STATE_DIR = WORKSPACE / "state"
IS_EXAMPLE = PROFILE_DIR == ROOT / "examples" / "profile"


def work_path(*parts: str) -> Path:
    """Absolute path inside the workspace, e.g. work_path("active", "Acme")."""
    return WORKSPACE.joinpath(*parts)


def rel(p: Path) -> str:
    """A path for display: relative to the workspace or this repo, else absolute."""
    for base in (WORKSPACE, ROOT):
        try:
            return str(Path(p).relative_to(base)).replace("\\", "/")
        except ValueError:
            continue
    return str(p)


def profile_path(*parts: str) -> Path:
    return PROFILE_DIR.joinpath(*parts)


def state_path(*parts: str) -> Path:
    STATE_DIR.mkdir(exist_ok=True)
    return STATE_DIR.joinpath(*parts)


@lru_cache(maxsize=1)
def profile() -> dict:
    file = profile_path("profile.json")
    if not file.exists():
        raise SystemExit(f"No profile.json in {PROFILE_DIR}. Copy examples/profile to profile/ and edit it.")
    return json.loads(file.read_text(encoding="utf-8"))


def read_profile_file(*parts: str, required: bool = False) -> str | None:
    file = profile_path(*parts)
    if file.exists():
        return file.read_text(encoding="utf-8")
    if required:
        raise SystemExit(f"Missing profile file: {file}")
    return None


def cv_dirs() -> list[Path]:
    base = profile_path("cv")
    return [base, base / "company"]


def cv_variants() -> list[str]:
    names = []
    for d in cv_dirs():
        if d.exists():
            names += [p.stem for p in sorted(d.glob("*.md")) if p.stem.lower() != "readme"]
    return names


def home() -> dict:
    """{label, lat, lon, country, max_commute_km}; empty when not configured."""
    return profile().get("home") or {}


def default_cv_variant() -> str:
    return (profile().get("cv") or {}).get("default_variant") or (cv_variants() or ["default"])[0]
