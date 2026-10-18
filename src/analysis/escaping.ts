import {isClassMethod, isFunctionDeclaration, isFunctionExpression} from "@babel/types";
import {forEachPatternIdentifier} from "../misc/asthelpers";
import {ModuleInfo} from "./infos";
import {AccessPathToken, AllocationSiteToken, FunctionToken, NativeObjectToken, ObjectToken, Token} from "./tokens";
import {ConstraintVar, isObjectPropertyVarObj, ObjectPropertyVarObj} from "./constraintvars";
import logger from "../misc/logger";
import Solver from "./solver";
import {UnknownAccessPath} from "./accesspaths";
import {INTERNAL_PROTOTYPE, isInternalProperty} from "../natives/ecmascript";
import {options} from "../options";
import {locationToStringWithFileAndEnd, mapGetSet} from "../misc/util";
import {FragmentState} from "./fragmentstate";
import {TokenListener} from "./listeners";
import {visitExportedTokens} from "./exported";

/**
 * If true, skip injecting %UnknownAccessPath at property vars where the ReadResultVar for
 * the (token, property) pair already has a non-empty points-to set.
 */
const SKIP_RESOLVED_READS = true;

/**
 * Returns the set of FunctionTokens that should not receive a synthetic 'this',
 * because some other constructor in the program instantiates them via super(),
 * via the prototype chain, or because they appear as methods on a prototype object.
 */
function computeDummyThisExclusions(f: FragmentState): Set<FunctionToken> {
    const vp = f.varProducer;
    const excluded = new Set<FunctionToken>();
    const owners = new Map<ObjectPropertyVarObj, Set<FunctionToken>>();
    for (const ft of f.functionTokens) {
        if (isClassMethod(ft.fun, {kind: "constructor"})) {
            // ES6: <Child>.%[[Prototype]] === <Parent>
            for (const pt of f.getTokens(f.getRepresentative(vp.objPropVar(ft, INTERNAL_PROTOTYPE()))))
                if (pt instanceof FunctionToken)
                    excluded.add(pt);
        } else if (isFunctionDeclaration(ft.fun) || isFunctionExpression(ft.fun)) {
            // collect old-style prototype objects to drive the second pass
            for (const pt of f.getTokens(f.getRepresentative(vp.objPropVar(ft, "prototype"))))
                if (isObjectPropertyVarObj(pt))
                    mapGetSet(owners, pt).add(ft);
        }
    }
    for (const pt of owners.keys()) {
        // <Child>.prototype.%[[Prototype]] === <Parent>.prototype  ->  Parent is instantiated via chain
        for (const qt of f.getTokens(f.getRepresentative(vp.objPropVar(pt, INTERNAL_PROTOTYPE()))))
            if (isObjectPropertyVarObj(qt))
                for (const ft of owners.get(qt) ?? [])
                    excluded.add(ft);
        // function tokens stored as (non-constructor) methods on the prototype
        for (const prop of f.objectProperties.get(pt) ?? [])
            if (prop !== "constructor")
                for (const mt of f.getTokens(f.getRepresentative(vp.objPropVar(pt, prop))))
                    if (mt instanceof FunctionToken)
                        excluded.add(mt);
    }
    return excluded;
}

/** Functions that may legitimately be invoked as constructors. */
function isDummyThisCandidate(ft: FunctionToken): boolean {
    return isFunctionDeclaration(ft.fun) || isFunctionExpression(ft.fun) || isClassMethod(ft.fun, {kind: "constructor"});
}

/**
 * Finds the ObjectTokens that may be accessed from outside the fragment via exporting to or importing from other modules.
 * Adds UnknownAccessPath at parameters of escaping functions and properties of escaping objects.
 * For each escaping function whose `this` is otherwise empty and is structurally callable as a constructor,
 * also synthesizes a dummy instance object so that `this.x = ...` writes are traceable externally.
 * Note: objects that are assigned to 'exports' (or to properties of such objects) are not considered escaping
 * (unless also returned by an escaping function or passed as argument to an external function).
 */
export function findEscapingObjects(ms: ModuleInfo | Array<ModuleInfo>, solver: Solver): Set<ObjectToken> {
    const a = solver.globalState;
    const f = solver.fragmentState; // (don't use in callbacks)
    const vp = f.varProducer;

    const worklist: Array<ObjectPropertyVarObj> = [];
    const visited = new Set<Token>();
    const escaping = new Set<ObjectToken>();
    const theUnknownAccessPathToken = a.canonicalizeToken(new AccessPathToken(UnknownAccessPath.instance));
    const dummyExcluded = computeDummyThisExclusions(f);

    /**
     * Adds the tokens of the given constraint variable to the worklist if not already visited.
     * Note: PackageObjectTokens, AccessPathTokens and (most) NativeObjectTokens are ignored.
     */
    function addToWorklist(v: Token | ConstraintVar) {
        for (const t of v instanceof Token ? [v] : f.getTokens(f.getRepresentative(v)))
            if ((t instanceof AllocationSiteToken || t instanceof FunctionToken || (t instanceof NativeObjectToken && t.name === "exports")) && !visited.has(t)) {
                worklist.push(t);
                visited.add(t);
            }
    }

    // First round: find every FunctionToken reachable from module.exports via
    // property reads; queue them in w2 for round 2.
    const w2: Array<ObjectPropertyVarObj> = [];
    const seeds: Array<ConstraintVar> = [];
    for (const m of Array.isArray(ms) ? ms : [ms])
        if (m.packageInfo.isEntry && (m.getPath().includes("node_modules") || options.library)) // only consider escaping objects for entry packages in libraries
            if (!m.packageInfo.exports || m.packageInfo.exports.test(m.relativePath)) // only consider escaping objects from modules that are exported
                seeds.push(vp.objPropVar(a.canonicalizeToken(new NativeObjectToken("module", m)), "exports"));
    visitExportedTokens(f, seeds, (t, visitor) => {
        if (t instanceof FunctionToken)
            w2.push(t);
        else if (t instanceof ObjectToken || (t instanceof NativeObjectToken && t.name === "exports"))
            for (const p of f.objectProperties.get(t) ?? [])
                if (!isInternalProperty(p))
                    visitor(vp.objPropVar(t, p));
    });
    for (const t of w2) {
        visited.add(t);
        worklist.push(t);
    }
    // add expressions collected during AST traversal
    for (const v of f.maybeEscaping)
        addToWorklist(v);
    f.maybeEscaping.clear(); // no longer needed

    // FIXME: arguments to (non-modeled) native functions should also be considered escaped?

    // second round, find objects that are accessible externally via functions and expressions found in first round
    while (worklist.length !== 0) {
        const t = worklist.pop()!;
        if (t instanceof ObjectToken) {
            if (logger.isDebugEnabled())
                logger.debug(`Escaping object: ${t}`);
            escaping.add(t);
        }
        if (t instanceof FunctionToken) {

            // values returned from escaping functions are escaping
            addToWorklist(vp.returnVar(t.fun));

            // add UnknownAccessPath at parameter identifiers
            for (const param of t.fun.params)
                forEachPatternIdentifier(param, id =>
                    solver.addToken(theUnknownAccessPathToken, f.getRepresentative(vp.nodeVar(id))));
            const tv = f.getRepresentative(vp.thisVar(t.fun));
            const thisWasEmpty = f.isEmpty(tv);
            solver.addToken(theUnknownAccessPathToken, tv);

            // synthesize a dummy instance for `this` when external code may invoke this function as a constructor;
            // properties added later (after the next propagation cycle) are handled via the listener below
            if (thisWasEmpty && !dummyExcluded.has(t) && isDummyThisCandidate(t)
                && (f.subsetEdges.has(tv) || f.tokenListeners.has(tv) || f.tokenListeners2.has(tv))) {
                if (logger.isDebugEnabled())
                    logger.debug(`Synthesizing dummy 'this' for ${locationToStringWithFileAndEnd(t.fun.loc)}`);
                const q = a.canonicalizeToken(new ObjectToken(t.fun));
                solver.addTokenConstraint(q, vp.thisVar(t.fun));
                solver.addInherits(q, vp.objPropVar(t, "prototype"));
                escaping.add(q);
                solver.addForAllObjectPropertiesConstraint(q, TokenListener.PATCH_ESCAPING_DUMMY_THIS, t.fun, p => {
                    if (!isInternalProperty(p))
                        solver.addToken(theUnknownAccessPathToken, solver.fragmentState.getRepresentative(solver.fragmentState.varProducer.objPropVar(q, p)));
                });
            }

            // TODO: also consider inheritance, ClassExtendsVar?
        }

        // properties of escaping objects are escaping
        for (const p of f.objectProperties.get(t) ?? [])
            if (!isInternalProperty(p)) {
                const w = vp.objPropVar(t, p);
                addToWorklist(w);
                // Skip injection if the property read already resolved to concrete values
                if (SKIP_RESOLVED_READS) {
                    const readResult = vp.readResultVar(t, p);
                    if (f.processedReadResultVars.has(readResult) &&
                        f.getTokensSize(f.getRepresentative(readResult))[0] > 0)
                        continue;
                }
                solver.addToken(theUnknownAccessPathToken, f.getRepresentative(w));
            }
    }

    if (logger.isVerboseEnabled()) {
        const objecttokens = new Set<ObjectToken>();
        for (const [, ts] of f.getAllVarsAndTokens())
            for (const t of ts)
                if (t instanceof ObjectToken)
                    objecttokens.add(t);
        logger.verbose(`Escaping objects: ${escaping.size}/${objecttokens.size}`);
    }

    return escaping;
}
