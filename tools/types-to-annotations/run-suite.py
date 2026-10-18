#!/usr/bin/env python3
"""
End-to-end pipeline: analyze every benchmark under a suites directory with
jelly (--types-json), then convert the reports to Static Hermes annotation
JSONs mirroring the suite layout.

  suites/jetstream/box2d/benchmark.js   ->  annotations-root/jetstream/box2d/benchmark.json

Entry discovery mirrors bench.py's _find_js_files: per suite directory,
`benchmark.js` files are preferred when present, otherwise every *.js file
counts as a benchmark. Root-level *.js files are included.

Usage:
    python3 run-suite.py <suites-dir> <annotations-root> [--jelly <main.js>]
"""

import argparse
import os
import shlex
import subprocess
import sys
from pathlib import Path

JELLY_DEFAULT = os.path.join(os.path.dirname(__file__), "..", "..", "lib", "main.js")


def find_entries(suites_dir: Path):
    """(relative path, absolute js path) for every benchmark, bench.py-style."""
    entries = []
    for js in sorted(p for p in suites_dir.iterdir() if p.is_file() and p.suffix == ".js"):
        entries.append((js.relative_to(suites_dir), js))
    for suite in sorted(p for p in suites_dir.iterdir() if p.is_dir()):
        js_files = sorted(suite.rglob("*.js"))
        benchmarks = sorted(suite.rglob("benchmark.js"))
        for js in (benchmarks if benchmarks else js_files):
            entries.append((js.relative_to(suites_dir), js))
    return entries


def main():
    ap = argparse.ArgumentParser(description="jelly types -> annotations for a whole suites dir")
    ap.add_argument("suites_dir")
    ap.add_argument("annotations_root")
    ap.add_argument("--jelly", default=JELLY_DEFAULT)
    ap.add_argument("--jelly-args", default="", help="extra arguments passed to jelly (quoted string)")
    ap.add_argument("--staging", default="/tmp/jelly-types-staging")
    ap.add_argument("--timeout", type=int, default=900, help="jelly timeout per benchmark (s)")
    args = ap.parse_args()

    suites_dir = Path(args.suites_dir).resolve()
    jelly = os.path.abspath(args.jelly)
    staging = Path(args.staging)
    entries = find_entries(suites_dir)
    print(f"{len(entries)} benchmarks discovered")

    failed = []
    for i, (rel, js) in enumerate(entries, 1):
        out_types = staging / (str(rel)[:-3] + ".types.json")
        out_types.parent.mkdir(parents=True, exist_ok=True)
        out_log = staging / (str(rel)[:-3] + ".log")
        cmd = ["node", jelly, "--types-json", str(out_types),
               "-b", str(js.parent), *shlex.split(args.jelly_args), str(js)]
        try:
            with open(out_log, "w") as log:
                subprocess.run(cmd, stdout=log, stderr=log,
                               timeout=args.timeout, check=True)
            n = len(__import__("json").load(open(out_types))["entries"])
            print(f"[{i}/{len(entries)}] {rel}: {n} entries", flush=True)
        except Exception as exc:  # noqa: BLE001 - keep going, report at the end
            failed.append((str(rel), str(exc)[:120]))
            print(f"[{i}/{len(entries)}] {rel}: FAILED {exc}", flush=True)

    print(f"\nanalysis done, {len(failed)} failed")
    for rel, err in failed:
        print(f"  {rel}: {err}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
