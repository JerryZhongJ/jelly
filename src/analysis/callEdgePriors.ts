/**
 * Call-edge priors (force_include / force_exclude) — kernel injection.
 *
 * `--call-edge-priors <file>` loads a JSON of rules keyed by stable locKeys
 * (relative-to-basedir file path + 1-based range, same format as annotator's
 * loc_key). At analysis time:
 *
 * - force_exclude is queried by the four interception points
 *   (`FragmentState.registerCallEdge`, `Operations.callFunctionTokenBound`,
 *   `readPropertyFromChain`'s getter callback, `writeProperty`'s setter callback).
 * - force_include is applied by `applyPendingForceIncludes`, called from
 *   `Operations.callFunction` and before each `solver.propagate` in analyzer.ts:
 *   it injects the target FunctionToken into the callsite's callee variable,
 *   which the existing CALL_FUNCTION listener picks up → full call modeling.
 *
 * locKeys are resolved lazily: the priors file holds locKey strings; the
 * Node/Function become available only as the AST is built, so `callLocIndex`
 * (FragmentState) and `funLocIndex` (GlobalState) are filled during analysis
 * and `applyPendingForceIncludes` retries until both ends resolve.
 */

import {Node} from "@babel/types";
import {relative} from "path";
import {Location} from "../misc/util";
import {options} from "../options";
import type {FragmentState} from "./fragmentstate";
import type Solver from "./solver";
import {FunctionToken} from "./tokens";

export type CallEdgeMode = "include" | "exclude";

export interface PriorRule {
    callee: string; // callee locKey
    mode: CallEdgeMode;
}

export interface Priors {
    /** callsite locKey -> include rules (force_include targets). */
    byCallsite: Map<string, Array<PriorRule>>;
    /** "callsiteLocKey\x00calleeLocKey" -> true (force_exclude, O(1) lookup). */
    exclude: Set<string>;
    /** include rules already injected (idempotency across propagate rounds). */
    applied: Set<string>;
    /** include rules whose callee never resolved by end of analysis (diagnostics). */
    unresolved: Set<string>;
}

const SEP = "\x00";

/**
 * Stable locKey for a location: "<relative file>:<startLine>:<startColumn(1-based)>:<endLine>:<endColumn(1-based)>".
 * Matches annotator's callgraph.loc_key format. Returns undefined if the location
 * has no module qualifier.
 */
export function locKeyFromLoc(loc: Location | null | undefined): string | undefined {
    if (!loc || !loc.module) return undefined;
    const file = relative(options.basedir, loc.module.getPath());
    return `${file}:${loc.start.line}:${loc.start.column + 1}:${loc.end.line}:${loc.end.column + 1}`;
}

/** locKey for an AST node (e.g. a call node or a Function AST). */
export function locKeyFromNode(node: Node | undefined | null): string | undefined {
    return locKeyFromLoc(node?.loc as Location | null);
}

export function emptyPriors(): Priors {
    return {
        byCallsite: new Map(),
        exclude: new Set(),
        applied: new Set(),
        unresolved: new Set(),
    };
}

/** Parse the --call-edge-priors JSON into a Priors structure (tolerant of bad rows). */
export function loadCallEdgePriors(json: unknown): Priors {
    const priors = emptyPriors();
    if (!json || typeof json !== "object") return priors;
    const rules = (json as {rules?: unknown}).rules;
    if (!Array.isArray(rules)) return priors;
    for (const r of rules) {
        if (!r || typeof r !== "object") continue;
        const callsite = (r as {callsite?: unknown}).callsite;
        const callee = (r as {callee?: unknown}).callee;
        const mode = (r as {mode?: unknown}).mode;
        if (typeof callsite !== "string" || typeof callee !== "string") continue;
        if (mode !== "include" && mode !== "exclude") continue;
        const key = callsite + SEP + callee;
        if (mode === "exclude") {
            priors.exclude.add(key);
        } else {
            let arr = priors.byCallsite.get(callsite);
            if (!arr) priors.byCallsite.set(callsite, (arr = []));
            arr.push({callee, mode: "include"});
            priors.unresolved.add(key); // cleared once applied
        }
    }
    return priors;
}

/**
 * True if the (callLocKey, calleeLocKey) pair is force-excluded. Callers compute
 * locKeys via locKeyFromNode (call node / Function AST) or locKeyFromLoc
 * (FunctionInfo.loc, which has no owning Node).
 */
export function isCallExcluded(
    priors: Priors | undefined,
    callLocKey: string | undefined,
    calleeLocKey: string | undefined,
): boolean {
    if (!priors || priors.exclude.size === 0 || !callLocKey || !calleeLocKey) return false;
    return priors.exclude.has(callLocKey + SEP + calleeLocKey);
}

/**
 * Inject FunctionTokens for every resolved force_include rule. Idempotent via
 * the `applied` set; called from Operations.callFunction and before each
 * solver.propagate in analyzer.ts so rules whose callee resolves late still fire.
 */
export function applyPendingForceIncludes(f: FragmentState, solver: Solver): void {
    const priors = f.callEdgePriors;
    if (!priors || priors.byCallsite.size === 0) return;
    for (const [callsiteLocKey, rules] of priors.byCallsite) {
        const callNode = f.callLocIndex.get(callsiteLocKey);
        if (!callNode) continue;
        const calleeVars = f.callToCalleeVars.get(callNode);
        if (!calleeVars || calleeVars.size === 0) continue;
        for (const rule of rules) {
            const key = callsiteLocKey + SEP + rule.callee;
            if (priors.applied.has(key)) continue;
            const fun = f.a.funLocIndex.get(rule.callee);
            if (!fun) continue; // callee not analyzed yet; retry next round
            const ft = f.a.canonicalizeToken(new FunctionToken(fun));
            for (const calleeVar of calleeVars)
                solver.addTokenConstraint(ft, calleeVar);
            priors.applied.add(key);
            priors.unresolved.delete(key);
        }
    }
}
