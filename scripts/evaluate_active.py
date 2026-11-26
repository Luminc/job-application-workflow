#!/usr/bin/env python3
"""
Evaluate the vacancies in the active/ directory using a stronger model (Sonnet)
with the full profile as context.
"""

import os
import argparse
import sys
from pathlib import Path
import anthropic
from dotenv import load_dotenv

if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

SCRIPT_DIR = Path(__file__).parent
ROOT_DIR = SCRIPT_DIR.parent

load_dotenv(ROOT_DIR / ".env")

sys.path.insert(0, str(ROOT_DIR))
from lib import profile as P  # noqa: E402

ACTIVE_DIR = P.work_path("active")


def build_deep_eval_prompt() -> str:
    """The profile (PROFILE.md) plus what this search looks for (prompts/evaluate.md)."""
    me = P.profile().get("name", "the candidate")
    profile_md = P.read_profile_file("PROFILE.md") or "Profile not found."
    criteria = P.read_profile_file("prompts", "evaluate.md") or ""
    return f"""You are an expert career consultant evaluating a job vacancy for {me}, to determine whether it is a genuinely good match for this specific profile.

--- PROFILE ---
{profile_md}
---------------

--- WHAT THIS SEARCH IS LOOKING FOR ---
{criteria}
---------------------------------------

Judge the core activity of the role against demonstrable experience; an attractive sector alone is not enough.

Read the vacancy carefully and give a deep, honest evaluation:
1. **Fit analysis:** why does this fit or not fit this profile? Will it bore or challenge?
2. **Red flags / concerns:** purely operational, too junior, misaligned, restrictive.
3. **Green flags:** responsibilities that match demonstrable experience.
4. **Overall recommendation:** "Highly Recommended", "Worth Applying", "Maybe - Ask Questions" or "Avoid".
"""

def evaluate_folder(folder_path: Path, client: anthropic.Anthropic, system_prompt: str, model_id: str):
    vacancy_file = folder_path / "vacancy.md"
    deep_eval_file = folder_path / "deep_evaluation.md"

    if not vacancy_file.exists():
        return

    # Skip if already evaluated
    if deep_eval_file.exists():
        return

    print(f"\n{'-'*60}")
    print(f"Evaluating: {folder_path.name}...")
    print(f"{'-'*60}")
    
    content = vacancy_file.read_text(encoding="utf-8")
    
    try:
        msg = client.messages.create(
            model=model_id,
            max_tokens=3000,  # headroom for Sonnet 5's default adaptive thinking + full response
            system=system_prompt,
            messages=[{"role": "user", "content": f"Here is the vacancy content:\n\n{content}"}],
        )
        report = next(b.text for b in msg.content if b.type == "text").strip()
        deep_eval_file.write_text(report, encoding="utf-8")
        print(f"\n[CLI Feedback Start]\n{report}\n[CLI Feedback End]\n")
        print(f"  [OK] Saved to {deep_eval_file.name}")
    except Exception as exc:
        print(f"  [ERROR] Failed to evaluate {folder_path.name}: {exc}")

def main():
    parser = argparse.ArgumentParser(description="Evaluate active vacancies.")
    parser.add_argument("--model", choices=["sonnet", "haiku"], default="sonnet",
                        help="Select AI model (sonnet or haiku)")
    parser.add_argument("--prompt-only", action="store_true",
                        help="Generate a single prompt file for Web UI usage instead of calling API")
    args = parser.parse_args()

    model_mapping = {
        "sonnet": "claude-sonnet-5-5",
        "haiku": "claude-haiku-4-5"
    }
    selected_model = model_mapping[args.model]

    if not args.prompt_only:
        api_key = os.environ.get("ANTHROPIC_API_KEY")
        if not api_key:
            print("[Error] ANTHROPIC_API_KEY missing from environment.")
            sys.exit(1)
        client = anthropic.Anthropic(api_key=api_key)
    else:
        client = None

    if not ACTIVE_DIR.exists():
        print(f"Active directory not found: {ACTIVE_DIR}")
        sys.exit(0)

    folders = [f for f in ACTIVE_DIR.iterdir() if f.is_dir()]
    if not folders:
        print("No active folders found.")
        return

    prompt = build_deep_eval_prompt()

    if args.prompt_only:
        print("Generating Web UI evaluation prompt...")
        vacancies_text = []
        for folder in folders:
            vacancy_file = folder / "vacancy.md"
            if vacancy_file.exists():
                text = vacancy_file.read_text(encoding="utf-8")
                vacancies_text.append(f"### COMPANY: {folder.name}\n\n{text}\n")
        
        if not vacancies_text:
            print("No vacancy.md files found.")
            return
            
        combined_vacancies = "\n".join(vacancies_text)
        
        final_prompt = f"""\
{prompt}

# VACANCIES TO EVALUATE:
{combined_vacancies}
"""
        prompt_path = ACTIVE_DIR / "web_evaluation_prompt.txt"
        prompt_path.write_text(final_prompt, encoding="utf-8")
        print(f"\n[OK] Generated prompt for Web UI usage: {prompt_path}")
        print("You can copy this file completely and paste it into Claude Web UI.")
        return

    print(f"Starting deep evaluation for {len(folders)} active folders using {selected_model}...\n")
    for folder in folders:
        evaluate_folder(folder, client, prompt, selected_model)
        
    print("\nIndividual evaluations complete. Gathering results for aggregate overview...")
    
    # Generate overview
    evaluations = []
    for folder in folders:
        eval_file = folder / "deep_evaluation.md"
        if eval_file.exists():
            evaluations.append(f"### Company: {folder.name}\n{eval_file.read_text(encoding='utf-8')}\n")
    
    if evaluations:
        combine_text = "\n".join(evaluations)
        overview_prompt = f"""\
You are an expert career strategist. We have already run a deep evaluation on several job vacancies for {P.profile().get("name", "the candidate")}.
Below are the individual deep evaluation reports for each active vacancy.

Please read through all of them and provide a synthesized OVERVIEW and PRIORITY RANKING.
Your response should:
1. Provide a ranked list of the opportunities from "Must Apply Immediately" down to "Avoid".
2. Very briefly summarize WHY each is ranked where it is, based on the reports.
3. Be concise, direct, and actionable.

Here are the reports:
{combine_text}
"""
        try:
            print(f"\nGenerating comprehensive priority overview using {selected_model}...")
            msg = client.messages.create(
                model=selected_model,
                max_tokens=3000,  # headroom for Sonnet 5's default adaptive thinking + full response
                messages=[{"role": "user", "content": overview_prompt}],
            )
            overview_report = next(b.text for b in msg.content if b.type == "text").strip()
            
            overview_file = ACTIVE_DIR / "evaluation_overview.md"
            overview_file.write_text(overview_report, encoding="utf-8")
            print(f"\n{'-'*60}\nFINAL PRIORITY OVERVIEW\n{'-'*60}\n{overview_report}\n{'-'*60}\n")
            print(f"Saved total overview to {overview_file.name}")
        except Exception as exc:
            print(f"\n[ERROR] Failed to generate aggregate overview: {exc}")

    print("\nProcess finished.")

if __name__ == "__main__":
    main()
