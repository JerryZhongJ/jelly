import {ConstraintVar, isObjectPropertyVarObj} from "./constraintvars";
import {AllocationSiteToken, FunctionToken, NativeObjectToken, Token} from "./tokens";
import {FragmentState} from "./fragmentstate";
import {isInternalProperty} from "../natives/ecmascript";
import {FunctionInfo} from "./infos";

/**
 * Visits each FunctionToken, AllocationSiteToken, and `%exports` token
 * reachable from `seeds`. The caller's `process(t, visitor)` runs once
 * per token; call `visitor(v)` to follow another constraint variable.
 */
export function visitExportedTokens(
    f: FragmentState,
    seeds: Iterable<ConstraintVar>,
    process: (t: Token, visitor: (v: ConstraintVar) => void) => void,
): void {
    const visited = new Set<Token>();
    const worklist: Array<Token> = [];

    const visitor = (v: ConstraintVar) => {
        for (const t of f.getTokens(f.getRepresentative(v)))
            if ((t instanceof AllocationSiteToken
                || t instanceof FunctionToken
                || (t instanceof NativeObjectToken && t.name === "exports")) && !visited.has(t)) {
                visited.add(t);
                worklist.push(t);
            }
    };

    for (const v of seeds)
        visitor(v);
    while (worklist.length > 0)
        process(worklist.pop()!, visitor);
}

/**
 * Returns the FunctionInfos reachable as values of `module.exports` (or
 * properties of values of `module.exports`) for entry modules.
 */
export function getExportedFunctions(f: FragmentState): Set<FunctionInfo> {
    const a = f.a;
    const res = new Set<FunctionInfo>();
    const seeds = Array.from(a.moduleInfos.values())
        .filter(m => m.isEntry)
        .map(m => f.varProducer.objPropVar(a.canonicalizeToken(new NativeObjectToken("module", m)), "exports"));
    visitExportedTokens(f, seeds, (t, visitor) => {
        if (t instanceof FunctionToken) {
            const fi = a.functionInfos.get(t.fun);
            if (fi)
                res.add(fi);
            visitor(f.varProducer.returnVar(t.fun));
        }
        if (isObjectPropertyVarObj(t)) {
            const vp = f.varProducer;
            for (const p of f.objectProperties.get(t) ?? [])
                if (!isInternalProperty(p))
                    visitor(vp.objPropVar(t, p));
        }
    });
    return res;
}
