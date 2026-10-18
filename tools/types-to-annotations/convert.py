#!/usr/bin/env python3
"""
Convert jelly --types-json output into Static Hermes annotation JSON.

Usage:
    python3 convert.py <types.json> <output.json>
    python3 convert.py --batch <dir-with-*.types.json> <output-dir>

jelly side:  jelly --types-json x.types.json <files...>   (generic type report)
this script: x.types.json  ->  annotation JSON ("static shapes" / "shape bindings"
             "shape guards" / "type guards" / "uncovered_reasons")

Mapping rules (may-types are only annotated when unambiguous):
  singleton number/string/boolean -> type guard with the same type
  singleton function + exactly 1 closure target -> closure guard with target function
  singleton object/array          -> skipped (object type guards carry no useful
                                    speculation info for Static Hermes and are
                                    removed by rule; not recorded as uncovered)
  singleton null/undefined        -> uncovered (unsupported in the annotation vocabulary)

Shape property rules:
  singleton number/string/boolean -> same type
  singleton object/array          -> "any"
  {null, undefined} union         -> kept as ["null", "undefined"] (union type list)
  singleton function + 1 target   -> closure with target function
  unions / multi closure targets  -> uncovered (reason records the candidate types)

Location conventions: jelly locKeys ("fidx:sl:sc:el:ec") use 1-based lines,
1-based start columns and exclusive 1-based end columns - identical to the
annotation convention (hermes AnnotationLoader.h: "1-based, end column EXCLUSIVE").
"""

import argparse
import json
import os

# annotation type vocabulary (observed in groundtruth files)
SUPPORTED = {"number", "string", "boolean", "object", "closure"}


def parse_loc(loc: str, files):
    """'fidx:sl:sc:el:ec' -> annotation range."""
    fidx, sl, sc, el, ec = loc.split(":")
    return parse_key(files[int(fidx)], f"{sl}:{sc}:{el}:{ec}")


def parse_key(rel: str, rest: str):
    """'<rel>:<sl>:<sc>:<el>:<ec>' locKey -> annotation range.

    jelly locKeys use 1-based lines, 1-based start column and 1-based
    exclusive end column - which matches the annotation convention exactly
    (see hermes AnnotationLoader.h: "1-based, end column EXCLUSIVE").
    """
    sl, sc, el, ec = rest.split(":")
    return {
        "file": rel,
        "start": {"line": int(sl), "column": int(sc)},
        "end": {"line": int(el), "column": int(ec)},
    }


def property_type(p: dict):
    """Shape property -> annotation property entry fields, or None if untypable."""
    types = p.get("types", [])
    if set(types) == {"null", "undefined"}:
        return {"type": ["null", "undefined"]}  # keep this union (annotation "type" may be a list)
    if len(types) != 1:
        return None
    t = types[0]
    if t in ("number", "string", "boolean"):
        return {"type": t}
    if t in ("object", "array"):
        return {"type": "any"}  # object-ish property types carry no useful info: declare any
    if t == "function":
        closures = p.get("closures", [])
        if len(closures) == 1:
            rel, rest = closures[0].split(":", 1)
            return {"type": "closure", "target function": parse_key(rel, rest)}
    return None  # null/undefined/other unions/multi-target closures: leave untyped


def convert(report: dict) -> dict:
    files = report["files"]
    guards, uncovered = [], []

    # Shapes at expression completion. Store-completion observations cannot be
    # attached to the receiver expression, which evaluates before the store.
    static_shapes = {}
    for s in report.get("shapes", []):
        props = []
        for p in s["properties"]:  # ordered: creation order
            entry = {"name": p["name"]}
            flags_off = [flag for flag in ("writable", "enumerable", "configurable")
                         if p.get(flag) is False]
            if p.get("implicitConstructor") and "enumerable" not in flags_off:
                flags_off.append("enumerable")
            if flags_off:
                entry["flags off"] = flags_off
            if not p.get("implicitConstructor"):
                entry.update(property_type(p) or {})
            props.append(entry)
        static_shapes[s["name"]] = {"properties": props}
    shape_bindings = [
        {"target range": parse_key(*split_loc(b["location"])), "shape": b["shape"]}
        for b in report.get("shapeBindings", [])
        if b.get("phase", "after-expression") == "after-expression"
    ]
    shape_guards = []
    for g in report.get("shapeGuards", []):
        entry = {"target range": parse_key(*split_loc(g["location"])), "shape": g["shape"]}
        if g.get("prototypeShape"):
            entry["prototype shape"] = g["prototypeShape"]
        shape_guards.append(entry)

    for e in report.get("entries", []):
        rng = parse_loc(e["location"], files)
        types = e.get("types", [])
        loc_str = f"{rng['start']['line']}:{rng['start']['column']}"

        if len(types) != 1:
            uncovered.append({
                "location": loc_str,
                "kind": "type",
                "reason": "mixed-type",
                "types": types,
            })
            continue

        t = types[0]
        if t in ("number", "string", "boolean"):
            guards.append({"target range": rng, "type": t})
        elif t in ("object", "array"):
            continue  # object type guards removed by rule (see module docstring)
        elif t == "function":
            closures = e.get("closures", [])
            if len(closures) == 1:
                rel, rest = closures[0].split(":", 1)
                guards.append({
                    "target range": rng,
                    "type": "closure",
                    "target function": parse_key(rel, rest),
                })
            else:
                uncovered.append({
                    "location": loc_str,
                    "kind": "type",
                    "reason": "closure-targets" if closures else "no-closure-target",
                    "types": types,
                })
        else:  # null / undefined / ...
            uncovered.append({
                "location": loc_str,
                "kind": "type",
                "reason": f"unsupported-{t}",
                "types": types,
            })

    return {
        "static shapes": static_shapes,
        "shape bindings": shape_bindings,
        "shape guards": shape_guards,
        "type guards": guards,
        "uncovered_reasons": uncovered,
    }


def split_loc(loc: str):
    """'rel:sl:sc:el:ec' locKey -> (rel, 'sl:sc:el:ec')."""
    rel, rest = loc.split(":", 1)
    return rel, rest


def main():
    ap = argparse.ArgumentParser(description="Convert jelly --types-json output to annotation JSON")
    ap.add_argument("input", help="types.json file, or directory with *.types.json when --batch")
    ap.add_argument("output", help="output annotation JSON file, or directory when --batch")
    ap.add_argument("--batch", action="store_true", help="convert every *.types.json in input dir")
    args = ap.parse_args()

    if not args.batch:
        report = json.load(open(args.input))
        out = convert(report)
        os.makedirs(os.path.dirname(os.path.abspath(args.output)), exist_ok=True)
        json.dump(out, open(args.output, "w"), indent=2)
        print(f"{args.output}: {len(out['type guards'])} type guards, "
              f"{len(out['static shapes'])} shapes, {len(out['shape bindings'])} bindings, "
              f"{len(out['shape guards'])} shape guards, {len(out['uncovered_reasons'])} uncovered")
        return

    os.makedirs(args.output, exist_ok=True)
    for root, _, names in os.walk(args.input):
        for name in sorted(names):
            if not name.endswith(".types.json"):
                continue
            report = json.load(open(os.path.join(root, name)))
            out = convert(report)
            base = name[: -len(".types.json")]
            rel_dir = os.path.relpath(root, args.input)
            out_dir = (args.output if rel_dir == "." else os.path.join(args.output, rel_dir))
            os.makedirs(out_dir, exist_ok=True)
            path = os.path.join(out_dir, base + ".json")
            json.dump(out, open(path, "w"), indent=2)
            rel_out = os.path.relpath(path, args.output)
            print(f"{rel_out}: {len(out['type guards'])} guards, "
                  f"{len(out['uncovered_reasons'])} uncovered")


if __name__ == "__main__":
    main()
