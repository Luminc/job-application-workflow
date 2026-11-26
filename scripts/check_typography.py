#!/usr/bin/env python3
"""
Layout guard for generated CV PDFs: page overflow, orphan lines, split words.

An orphan here is a wrapped block whose final line carries only a word or two.
It wastes a line and reads badly. There are two ways to fix one, and this tool
tells you which is cheaper for each case:

    shorten  - cut roughly N characters so the block loses a whole line
    expand   - add roughly N characters so the last line carries its weight

Findings are mapped back to the source .md and reported with a line number,
so each one is a specific edit rather than a general warning.

Split words (a line ending in "communi-" and continuing "catie") are flagged
too. They are correct typography, but in a one-page CV they read as a slip and
usually mean the block is one word away from a cleaner break. Fix by rewording
so the word lands whole on one line. Opt out with --allow-hyphens.

Exit status is 1 when anything is found, so the check can act as a guard.

Usage:
    venv/bin/python scripts/check_typography.py                  # all CVs in output/cv
    venv/bin/python scripts/check_typography.py --active         # live application PDFs
    venv/bin/python scripts/check_typography.py path/to.pdf ...
    venv/bin/python scripts/check_typography.py --max-words 3    # stricter
    venv/bin/python scripts/check_typography.py --allow-hyphens  # orphans only
"""

import argparse
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(ROOT))
from lib import profile as P  # noqa: E402

DEFAULT_MAX_WIDOW_WORDS = 2
MIN_BLOCK_LINES = 2
# A real wrapped paragraph runs close to the measure; stacked short lines
# (name, title, an address) are deliberate and never orphans.
MIN_MEASURE_CHARS = 60
# The line before an orphan must itself be nearly full, or the break was meant.
FULL_LINE_RATIO = 0.85


def find_source(pdf: Path) -> Path | None:
    """
    Map a PDF back to its CV variant source in the profile.

    output/cv PDFs are named CV_<Name>_<year>_<variant>.pdf;
    active/<Company>/outputs PDFs carry no variant name, so the variant comes
    from the .cv_variant stamp the builder leaves beside them.
    """
    stamp = pdf.parent / ".cv_variant"
    if pdf.parent.name == "outputs" and stamp.exists():
        variant = stamp.read_text(encoding="utf-8").strip()
    else:
        variant = re.sub(r"^CV_[^_]+_\d{4}_", "", pdf.stem)
    for folder in P.cv_dirs():
        md = folder / f"{variant}.md"
        if md.exists():
            return md
    return None


def body_column(raw: list[str]) -> int:
    """
    Character column where the right-hand (prose) column starts.

    The CV template puts section labels and dates in a left column and all
    wrappable prose in the right one. pdftotext -layout prints them on the
    same line, which breaks source matching. Continuation lines have an empty
    left column, so the shallowest deep indent is the body column.
    """
    indents = [len(l) - len(l.lstrip()) for l in raw if l.strip()]
    deep = [i for i in indents if i >= 12]
    return min(deep) if deep else 0


def pdf_lines(pdf: Path) -> list[str]:
    out = subprocess.run(["pdftotext", "-layout", "-enc", "UTF-8", str(pdf), "-"],
                         capture_output=True, text=True, check=True,
                         encoding="utf-8")
    raw = out.stdout.splitlines()
    col = body_column(raw)
    return [l[col:] if len(l) > col else "" for l in raw]


def match_units(rendered: list[str], units: list[tuple[int, str]]) -> list[dict]:
    """
    Align each source unit to the rendered lines it produced.

    pdftotext -layout emits a blank line between every rendered line (the
    template's leading is nearly twice the font size), so blank lines carry no
    structural meaning and blocks cannot be inferred from them. Matching the
    known source text against the line stream is reliable instead, and yields
    the source line number for free.
    """
    lines = [l.strip() for l in rendered if l.strip()]
    spans: list[dict] = []
    pos = 0
    for lineno, raw in units:
        want = normalise(raw)
        if not want:
            continue
        for start in range(pos, len(lines)):
            acc = normalise(dehyphenate(lines[start]))
            if not acc or not want.startswith(acc[:min(len(acc), 25)]):
                continue
            end = start
            while end < len(lines):
                joined = normalise(dehyphenate(" ".join(lines[start:end + 1])))
                if joined == want:
                    spans.append({"lines": lines[start:end + 1],
                                  "src_line": lineno, "src_text": raw})
                    pos = end + 1
                    break
                if not want.startswith(joined):
                    break
                end += 1
            else:
                continue
            if spans and spans[-1]["src_line"] == lineno:
                break
    return spans


def dehyphenate(text: str) -> str:
    """Rejoin words split across lines so source matching works."""
    return re.sub(r"(\w)-\s+(\w)", r"\1\2", text)


def source_units(md: Path) -> list[tuple[int, str]]:
    """(line_number, text) for every block of prose the template can wrap."""
    units: list[tuple[int, str]] = []
    if not md.exists():
        return units
    lines = md.read_text(encoding="utf-8").splitlines()
    in_summary = False
    summary_start, summary_parts = 0, []
    for i, line in enumerate(lines, 1):
        if line.startswith("summary:"):
            in_summary, summary_start, summary_parts = True, i, []
            continue
        if in_summary:
            if line.startswith("---") or re.match(r"^\w+:", line):
                in_summary = False
                units.append((summary_start, " ".join(summary_parts)))
            else:
                summary_parts.append(line.strip())
                continue
        for m in re.finditer(r"\\cvdesc\{(.+?)\}\s*$", line):
            units.append((i, m.group(1)))
        m = re.match(r"\s*\\cvskill\{(.+?)\}\{(.+?)\}\s*$", line)
        if m:
            units.append((i, m.group(2)))
    return units


def normalise(s: str) -> str:
    s = re.sub(r"\\[a-zA-Z]+\s*", " ", s)      # strip latex commands
    s = s.replace("\\&", "&").replace("~", " ")
    s = re.sub(r"[^\w&]+", " ", s, flags=re.UNICODE)
    return " ".join(s.split()).lower()




def split_word(block: list[str], i: int) -> str:
    """The word broken across lines i and i+1, e.g. 'communi-catie'."""
    head = block[i].rstrip("-").split()[-1]
    tail = block[i + 1].split()[0] if block[i + 1].split() else ""
    return f"{head}-{tail}"


def check_pdf(pdf: Path, md: Path | None, max_words: int,
              hyphens: bool = True) -> list[dict]:
    findings: list[dict] = []
    units = source_units(md) if md else []
    if not units:
        return findings

    for span in match_units(pdf_lines(pdf), units):
        block = span["lines"]
        if len(block) < MIN_BLOCK_LINES:
            continue

        tail_is_split = False
        if hyphens:
            for i, line in enumerate(block[:-1]):
                if re.search(r"\w-$", line):
                    tail_is_split = tail_is_split or i == len(block) - 2
                    findings.append({
                        "kind": "split",
                        "word": split_word(block, i),
                        "lines": len(block),
                        "src_line": span["src_line"],
                        "src_text": span["src_text"],
                    })

        # The tail of a split word is already reported as the split itself.
        if tail_is_split:
            continue
        measure = max(len(l) for l in block)
        if measure < MIN_MEASURE_CHARS:
            continue
        last = block[-1]
        words = last.split()
        if not words or len(words) > max_words:
            continue

        # Cheaper fix: drop a line's worth of text, or fill the last line out.
        shorten_by = len(last) + 1
        expand_by = max(1, int(measure * 0.45) - len(last))
        advice = ("shorten", shorten_by) if shorten_by <= expand_by else ("expand", expand_by)

        findings.append({
            "kind": "orphan",
            "orphan": last,
            "lines": len(block),
            "advice": advice,
            "src_line": span["src_line"],
            "src_text": span["src_text"],
        })
    return findings


def allowed_pages(md: Path | None) -> int:
    """Page limit from the variant's frontmatter (max_pages), default 1."""
    if md and md.exists():
        m = re.search(r"^max_pages:\s*(\d+)", md.read_text(encoding="utf-8"), re.M)
        if m:
            return int(m.group(1))
    return 1


def main() -> int:
    # Windows consoles default to cp1252 and choke on accented source text.
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser(description="Flag orphan lines in generated PDFs.")
    ap.add_argument("pdfs", nargs="*")
    ap.add_argument("--active", action="store_true",
                    help="Check active/*/outputs instead of output/cv")
    ap.add_argument("--max-words", type=int, default=DEFAULT_MAX_WIDOW_WORDS,
                    help=f"Orphan threshold in words (default: {DEFAULT_MAX_WIDOW_WORDS})")
    ap.add_argument("--allow-hyphens", action="store_true",
                    help="Do not flag words split across lines")
    ap.add_argument("--brief", action="store_true",
                    help="Print nothing when everything is clean (for build hooks)")
    args = ap.parse_args()

    if args.pdfs:
        targets = [Path(p) for p in args.pdfs]
    elif args.active:
        targets = sorted(P.work_path("active").glob("*/outputs/*.pdf"))
    else:
        targets = sorted(P.work_path("output", "cv").glob("*.pdf"))

    if not targets:
        print("No PDFs found."); return 1

    total, clean = 0, 0
    for pdf in targets:
        md = find_source(pdf)
        stem = md.stem if md else pdf.stem
        try:
            findings = check_pdf(pdf, md, args.max_words, not args.allow_hyphens)
        except (subprocess.CalledProcessError, FileNotFoundError) as e:
            print(f"  [!] {pdf.name}: {e}"); continue

        pages = subprocess.run(["pdfinfo", str(pdf)], capture_output=True, text=True).stdout
        npages = re.search(r"^Pages:\s+(\d+)", pages, re.M)
        npages = int(npages.group(1)) if npages else 1

        max_pages = allowed_pages(md)
        if not findings and npages <= max_pages:
            clean += 1; continue

        total += len(findings)
        flag = f"  [{npages} pages, limit {max_pages}]" if npages > max_pages else ""
        print(f"\n{stem}{flag}")
        for f in findings:
            loc = f"{md.name}:{f['src_line']}" if f["src_line"] else "(unmatched)"
            if f["kind"] == "split":
                print(f"   split word \"{f['word']}\"  in a {f['lines']}-line block")
                print(f"      reword so it breaks elsewhere   {loc}")
            else:
                how, n = f["advice"]
                print(f"   orphan \"{f['orphan']}\"  after {f['lines']} lines")
                print(f"      {how} by ~{n} chars   {loc}")
            print(f"      {f['src_text'][:88]}")

    if args.brief and not total and clean == len(targets):
        return 0
    print(f"\n{'-'*70}")
    print(f"{len(targets)} file(s): {clean} clean, {total} finding(s)")
    return 1 if total or clean < len(targets) else 0


if __name__ == "__main__":
    sys.exit(main())
