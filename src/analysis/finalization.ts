import logger, {writeStdOutIfActive} from "../misc/logger";
import Timer, {nanoToMs} from "../misc/timer";
import assert from "assert";
import {FunctionToken} from "./tokens";
import {RepresentativeVar} from "./fragmentstate";
import {Node} from "@babel/types";
import {FunctionInfo, ModuleInfo} from "./infos";
import {mapGetArray, mapGetMap, mapGetSet} from "../misc/util";
import {ConstraintVar, isObjectPropertyVarObj, ObjectPropertyVar, ObjectPropertyVarObj} from "./constraintvars";
import Solver from "./solver";

/**
 * Collects final call edges.
 */
export function finalizeCallEdges(solver: Solver) {
    writeStdOutIfActive("Finalizing...");
    const finalTimer = new Timer;
    const f = solver.fragmentState;
    const a = solver.globalState;
    const d = solver.diagnostics;

    // ordinary call edges (aborted runs only)
    const t1 = new Timer;
    const aborted = d.aborted || d.timeout || d.waveLimitReached > 0 || d.indirectionsLimitReached > 0;
    if (aborted) {
        for (const n of f.callLocations) {
            const caller = f.callToContainingFunction.get(n);
            assert(caller);
            const vs = f.callToCalleeVars.get(n);
            if (vs)
                for (const v of vs) {
                    const vRep = f.getRepresentative(v);
                    for (const t of f.getTokens(vRep))
                        if (t instanceof FunctionToken)
                            f.registerCallEdge(n, caller, a.functionInfos.get(t.fun)!);
                }
        }
    }
    const elapsed1 = t1.elapsed();

    // build getter index
    const t2 = new Timer;
    const getterIndex = new Map<ObjectPropertyVarObj, Map<string, Array<FunctionInfo>>>();
    const getterProps = new Set<string>();
    let getterIndexEntries = 0;
    const collectGetters = (v: ConstraintVar) => {
        if (v instanceof ObjectPropertyVar && v.accessor === "get") {
            const funs: Array<FunctionInfo> = [];
            for (const t of f.getTokens(f.getRepresentative(v)))
                if (t instanceof FunctionToken && t.fun.params.length === 0)
                    funs.push(a.functionInfos.get(t.fun)!);
            if (funs.length > 0) {
                mapGetMap(getterIndex, v.obj).set(v.prop, funs);
                getterProps.add(v.prop);
                getterIndexEntries++;
            }
        }
    };
    for (const v of f.vars)
        collectGetters(v);
    for (const v of f.redirections.keys())
        collectGetters(v);
    const elapsed2 = t2.elapsed();

    // group property reads by representative base
    const t3 = new Timer;
    const pm = new Map<RepresentativeVar, Map<string, Array<[Node, FunctionInfo | ModuleInfo]>>>();
    let prsTotal = 0, prsKept = 0;
    for (const {base, prop, node, encl} of f.propertyReads) {
        prsTotal++;
        if (!getterProps.has(prop))
            continue;
        prsKept++;
        mapGetArray(mapGetMap(pm, f.getRepresentative(base)), prop).push([node, encl]);
    }
    const elapsed3 = t3.elapsed();

    // getter call edges
    const t4 = new Timer;
    const getterTokens: Set<ObjectPropertyVarObj> = new Set(getterIndex.keys());
    const ancestorsCache = new Map<ObjectPropertyVarObj, Array<ObjectPropertyVarObj>>();
    const getAncestors = (t1: ObjectPropertyVarObj): Array<ObjectPropertyVarObj> => {
        let r = ancestorsCache.get(t1);
        if (r)
            return r;
        r = [];
        for (const t2 of f.getTokens(f.getRepresentative(f.varProducer.ancestorsVar(t1))))
            if (isObjectPropertyVarObj(t2) && getterTokens.has(t2))
                r.push(t2);
        ancestorsCache.set(t1, r);
        return r;
    };
    const tm = new Map<ObjectPropertyVarObj, Set<Map<string, Array<[Node, FunctionInfo | ModuleInfo]>>>>();
    for (const [base, ms] of pm)
        for (const t1 of f.getTokens(base)) {
            if (isObjectPropertyVarObj(t1)) {
                if (getterTokens.has(t1))
                    mapGetSet(tm, t1).add(ms);
                for (const t2 of getAncestors(t1))
                    mapGetSet(tm, t2).add(ms);
            }
        }
    for (const [t, qs] of tm) {
        const gs = getterIndex.get(t)!; // tm entries are filtered to getterTokens, so always defined
        for (const ms of qs)
            for (const [prop, targets] of ms) {
                const funs = gs.get(prop);
                if (funs)
                    for (const [node, enclosing] of targets) {
                        f.registerCall(node, enclosing, undefined, {accessor: true});
                        for (const fi of funs)
                            f.registerCallEdge(node, enclosing, fi, {accessor: true});
                    }
            }
    }
    const elapsed4 = t4.elapsed();

    logger.debug(`finalizeCallEdges: ordinary=${nanoToMs(elapsed1)} (aborted=${aborted}), ` +
        `getter_index=${nanoToMs(elapsed2)} (${getterIndexEntries} entries, ${getterProps.size} props), ` +
        `group_property_reads=${nanoToMs(elapsed3)} (${prsKept}/${prsTotal} kept), ` +
        `getter_pass=${nanoToMs(elapsed4)} (|tm|=${tm.size}, ${ancestorsCache.size} ancestors cached)`);

    solver.diagnostics.finalizationTime = finalTimer.elapsed();
}