/**
 * Basic type inference on top of the points-to solution (may-types).
 *
 * The analysis abstract domain only models objects and functions (tokens); primitive
 * values produce no tokens and no constraint variables (see ConstraintVarProducer.expVar2).
 * This module adds a lightweight type-label layer for the basic types
 * number/string/boolean/undefined/null/bigint/symbol/object/function/array:
 *
 *  1. Injection: Operations.expVar creates a NodeVar for primitive-valued expressions with
 *     a syntactically known type (literals, typeof, void, etc.) and registers the label.
 *     Labels then flow through the *existing* subset edges (assignments, arguments,
 *     return values, property stores) - no changes to the solver.
 *  2. Propagation: after the fixpoint, labels are joined along subsetEdges with a small
 *     bitmask worklist fixpoint (union = may-type set).
 *  3. Object kinds: tokens in the solution are mapped to labels (FunctionToken -> function,
 *     ArrayToken -> array, ...) and merged with the propagated labels.
 *
 * The result is a may-approximation: flow-insensitive like the underlying analysis, and
 * an under-approximation when the analysis was truncated (timeout/indirection limits),
 * same as the dataflow reporter.
 */

import {Node} from "@babel/types";
import {relative} from "path";
import {
    AccessPathToken,
    AllocationSiteToken,
    FunctionToken,
    NativeObjectToken,
    PackageObjectToken,
    Token
} from "./tokens";
import {ConstraintVar, NodeVar} from "./constraintvars";
import {FragmentState, RepresentativeVar} from "./fragmentstate";
import {Location} from "../misc/util";
import {options} from "../options";
import logger from "../misc/logger";
import assert from "assert";

/**
 * Basic type labels (subset of the pattern-matching simple types).
 */
export const typeLabels = [
    "number", "string", "boolean", "undefined", "null", "bigint", "symbol",
    "object", "function", "array", "unknown"
] as const;

export type TypeLabel = typeof typeLabels[number];

export function typeLabelToBit(l: TypeLabel): number {
    return 1 << typeLabels.indexOf(l);
}

export function bitToTypeLabels(mask: number): Array<TypeLabel> {
    const res: Array<TypeLabel> = [];
    for (let i = 0; i < typeLabels.length; i++)
        if (mask & (1 << i))
            res.push(typeLabels[i]);
    return res;
}

/**
 * Maps an object token from the points-to solution to a basic type label.
 * Returns undefined for tokens with no useful basic type (access paths, unknown packages).
 */
export function tokenTypeLabel(t: Token): TypeLabel | undefined {
    if (t instanceof FunctionToken)
        return "function";
    if (t instanceof AllocationSiteToken)
        switch (t.kind) {
            case "Array":
                return "array";
            case "Object":
            case "Prototype":
            case "Map":
            case "Set":
            case "WeakMap":
            case "WeakSet":
            case "WeakRef":
            case "Iterator":
            case "Generator":
            case "RegExp":
            case "Date":
            case "Promise":
            case "PromiseResolve":
            case "PromiseReject":
            case "Error":
                return "object";
            default: // IteratorKind values
                return "object";
        }
    if (t instanceof NativeObjectToken || t instanceof PackageObjectToken)
        return "object"; // native/package objects are objects, but their values may be anything? no: the token itself is an object value
    if (t instanceof AccessPathToken)
        return "unknown"; // values modeled by access paths come from unanalyzed code: may be anything
    return undefined;
}

const PLUS_STRING = typeLabelToBit("string");
const PLUS_OBJECTISH = typeLabelToBit("object") | typeLabelToBit("function") | typeLabelToBit("array") | typeLabelToBit("symbol");

/**
 * Computes the result labels of L + R from operand label bits (0 = no information).
 * Per the JS spec, '+' only ever produces string, number or bigint.
 *
 * Operands are may-type sets, so the result is the union over all value pairs,
 * not a per-set decision: {number,string} + {number,string} can produce both
 * number (number+number) and string (string+x), and both labels must be kept.
 */
export function plusJoin(l: number, r: number): number {
    if (l === 0 || r === 0)
        return 0; // no-information operand: produce nothing (under-approximation, never a wrong label)
    const unknown = typeLabelToBit("unknown");
    if ((l | r) & unknown)
        // may-unknown operand: per ES spec '+' only ever produces string, number or
        // bigint (other combinations throw) - return the full outcome range, which is
        // precise enough (closed under plusJoin) and never a singleton type guard
        return typeLabelToBit("string") | typeLabelToBit("number") | typeLabelToBit("bigint");
    let res = 0;
    if ((l | r) & PLUS_STRING)
        res |= typeLabelToBit("string"); // string + non-string concatenates
    if ((l | r) & PLUS_OBJECTISH)
        res |= typeLabelToBit("string") | typeLabelToBit("number"); // valueOf/toString decides
    const numeric = typeLabelToBit("number") | typeLabelToBit("boolean") | typeLabelToBit("null") | typeLabelToBit("undefined");
    if (l & numeric && r & numeric)
        res |= typeLabelToBit("number"); // numeric family pairs (number/boolean/null/undefined)
    const bigint = typeLabelToBit("bigint");
    if (l & bigint && r & bigint)
        res |= bigint;
    return res; // empty when every pair throws (e.g. bigint + number)
}

/**
 * Label bits of the operand families of the ToNumeric conversion: ToNumeric of a
 * number/boolean/null/undefined/string always yields a Number (NaN allowed), so
 * all of them belong to the "numeric" family for the non-'+' arithmetic operators.
 * (Symbol operands throw in every arithmetic operation.)
 */
const ARITH_NUMERIC = typeLabelToBit("number") | typeLabelToBit("boolean") | typeLabelToBit("null") |
    typeLabelToBit("undefined") | typeLabelToBit("string");
const ARITH_OBJECTISH = PLUS_OBJECTISH; // ToPrimitive may yield a Number or a BigInt

/**
 * Computes the result labels of L op R for the non-'+' arithmetic/bitwise/shift
 * operators ("-", "*", "/", "%", "**", "&", "|", "^", "<<", ">>", ">>>") from
 * operand label bits (0 = no information), following the ES spec ToNumeric /
 * ToInt32 / ToBigInt conversions:
 *  - bigint x bigint -> bigint (except '>>>', where BigInt throws)
 *  - numeric-family x numeric-family -> number
 *  - bigint x numeric-family -> TypeError (contributes nothing)
 *  - object operand -> ToPrimitive yields number or bigint ('>>>': number only)
 * Like plusJoin, the result is the union over all value pairs of the may-sets.
 */
export function arithJoin(op: string, l: number, r: number): number {
    assert(op !== "+");
    if (l === 0 || r === 0)
        return 0; // no-information operand: produce nothing (under-approximation, never a wrong label)
    const number = typeLabelToBit("number"), bigint = typeLabelToBit("bigint");
    const unsigned = op === ">>>"; // BigInt operands of '>>>' always throw
    if ((l | r) & typeLabelToBit("unknown"))
        return unsigned ? number : number | bigint; // may-unknown operand: full outcome range
    let res = 0;
    if (l & bigint && r & bigint && !unsigned)
        res |= bigint;
    if (l & ARITH_NUMERIC && r & ARITH_NUMERIC)
        res |= number;
    if ((l | r) & ARITH_OBJECTISH)
        res |= unsigned ? number : number | bigint; // valueOf/toString decides
    return res; // empty when every pair throws (e.g. bigint - number)
}

/**
 * Computes the result labels of the numeric unary operators ("-", "~", "++", "--")
 * from the operand label bits (0 = no information): ToNumeric/ToBigInt of the
 * operand decides between number and bigint (unary '+' is always ToNumber and
 * handled as a syntactic label, see getPrimitiveTypeLabel).
 */
export function unaryArithJoin(l: number): number {
    if (l === 0)
        return 0;
    const number = typeLabelToBit("number"), bigint = typeLabelToBit("bigint");
    if (l & typeLabelToBit("unknown"))
        return number | bigint;
    let res = 0;
    if (l & bigint)
        res |= bigint;
    if (l & ARITH_NUMERIC)
        res |= number;
    if (l & ARITH_OBJECTISH)
        res |= number | bigint;
    return res;
}

/**
 * Labels for primitive expressions, keyed by the expression AST node.
 * Filled by Operations.expVar during analysis (injection sites).
 */
export class TypeLabelRegistry {

    /**
     * Map from expression node to type label bits.
     */
    private readonly expLabels = new Map<Node, number>();

    /**
     * Map from expression node to its NodeVar (created by the injection).
     */
    readonly expVars = new Map<Node, NodeVar>();

    /**
     * Registers an initial label for the given expression node.
     */
    register(node: Node, label: TypeLabel) {
        this.expLabels.set(node, (this.expLabels.get(node) ?? 0) | typeLabelToBit(label));
    }

    getLabels(node: Node): number | undefined {
        return this.expLabels.get(node);
    }

    /**
     * Returns the registered expression nodes (for seeding the propagation).
     */
    entries(): Iterable<[Node, number]> {
        return this.expLabels.entries();
    }

    /**
     * Arithmetic rules: result labels computed from operand labels during propagation.
     * op "+" uses plusJoin; the other arithmetic/bitwise/shift operators use arithJoin;
     * a missing right operand marks a unary rule ("-"/"~"/"++"/"--", uses unaryArithJoin).
     */
    readonly arithRules: Array<{op: string, result: ConstraintVar, left: ConstraintVar | undefined, right: ConstraintVar | undefined}> = [];

    /**
     * Fixed labels for constraint variables (seeds), e.g. native call return types.
     */
    readonly varSeeds: Array<[ConstraintVar, TypeLabel]> = [];

    /**
     * Registers an arithmetic rule: the labels of L op R (or op L for unary rules)
     * flow to the result variable.
     */
    registerArith(op: string, result: ConstraintVar, left: ConstraintVar | undefined, right: ConstraintVar | undefined) {
        this.arithRules.push({op, result, left, right});
        if (result instanceof NodeVar)
            this.expVars.set(result.node, result); // make the result expression reportable
    }

    /**
     * Registers a fixed label for a constraint variable.
     */
    registerVarLabel(v: ConstraintVar, label: TypeLabel) {
        this.varSeeds.push([v, label]);
    }
}

/**
 * Result of the type propagation fixpoint.
 */
export class TypeLabels {

    /**
     * Joined label bits per representative constraint variable.
     */
    readonly labelBits = new Map<RepresentativeVar, number>();

    /**
     * Labels contributed by tokens (object kinds), per representative variable,
     * kept separately so queries can report the source of information.
     */
    readonly tokenBits = new Map<RepresentativeVar, number>();

    /**
     * Number of propagation steps performed (diagnostics).
     */
    steps = 0;

    getTypes(v: RepresentativeVar | undefined): Array<TypeLabel> {
        if (!v)
            return [];
        return bitToTypeLabels((this.labelBits.get(v) ?? 0) | (this.tokenBits.get(v) ?? 0));
    }
}

/**
 * Runs the type-label propagation fixpoint over the subset edges.
 *
 * @param f fragment state with the completed points-to solution
 */
export function propagateTypeLabels(f: FragmentState): TypeLabels {
    const res = new TypeLabels();
    const reg = f.a.typeLabels;
    const worklist: Array<RepresentativeVar> = [];
    const inWorklist = new Set<RepresentativeVar>();

    const addToWorklist = (v: RepresentativeVar) => {
        if (!inWorklist.has(v)) {
            inWorklist.add(v);
            worklist.push(v);
        }
    };
    const setBits = (v: RepresentativeVar, bits: number): boolean => {
        const cur = res.labelBits.get(v) ?? 0;
        if ((cur | bits) === cur)
            return false;
        res.labelBits.set(v, cur | bits);
        addToWorklist(v);
        return true;
    };
    const fullBits = (v: ConstraintVar | undefined): number => {
        if (!v)
            return 0;
        const rep = f.getRepresentative(v);
        return (res.labelBits.get(rep) ?? 0) | (res.tokenBits.get(rep) ?? 0);
    };

    // object-kind labels from the token solution (computed first: arithmetic rules read them)
    for (const v of f.a.vars)
        if (f.isRepresentative(v)) {
            let bits = 0;
            for (const t of f.getTokens(v as RepresentativeVar)) {
                const l = tokenTypeLabel(t);
                if (l !== undefined)
                    bits |= typeLabelToBit(l);
            }
            if (bits)
                res.tokenBits.set(v as RepresentativeVar, bits);
        }

    // seed: injected primitive expression labels and fixed variable labels
    for (const [node, bits] of reg.entries()) {
        const nv = reg.expVars.get(node);
        if (nv)
            setBits(f.getRepresentative(nv), bits);
    }
    for (const [v, label] of reg.varSeeds)
        setBits(f.getRepresentative(v), typeLabelToBit(label));

    // propagate along subset edges (union join), interleaved with the arithmetic
    // rules until joint fixpoint
    let rulesChanged = true;
    while (rulesChanged) {
        while (worklist.length) {
            res.steps++;
            const v = worklist.pop()!;
            inWorklist.delete(v);
            const bits = res.labelBits.get(v)!;
            const succs = f.subsetEdges.getSet(v);
            if (!succs)
                continue;
            for (const w of succs)
                setBits(w, bits);
        }
        rulesChanged = false;
        for (const rule of reg.arithRules) {
            const out = rule.op === "+"
                ? plusJoin(fullBits(rule.left), fullBits(rule.right))
                : rule.right === undefined
                    ? unaryArithJoin(fullBits(rule.left))
                    : arithJoin(rule.op, fullBits(rule.left), fullBits(rule.right));
            if (out && setBits(f.getRepresentative(rule.result), out))
                rulesChanged = true;
        }
    }

    return res;
}

/**
 * Resolves an expression location string (file:line:col or full range file:sl:sc:el:ec,
 * 1-based) to the representative constraint variable and returns its inferred may-types.
 */
export function inferTypeAtLocation(
    f: FragmentState,
    labels: TypeLabels,
    locStr: string,
): {resolved: boolean, types: Array<TypeLabel>, fromTokens: Array<TypeLabel>, propagated: Array<TypeLabel>, node?: Node, var?: string} {
    const rangeMatch = /^(.*):(\d+):(\d+):(\d+):(\d+)$/.exec(locStr);
    let entry: {node: Node, v: ConstraintVar | undefined} | undefined;
    if (rangeMatch) {
        entry = f.a.expLocationIndex.get(locStr);
    } else {
        const m = /^(.*):(\d+):(\d+)$/.exec(locStr);
        if (!m)
            return {resolved: false, types: [], fromTokens: [], propagated: []};
        // start-only key: scan for the first entry starting at this position
        const prefix = `${m[1]}:${m[2]}:${m[3]}:`;
        for (const [k, e] of f.a.expLocationIndex)
            if (k.startsWith(prefix)) {
                entry = e;
                break;
            }
    }
    if (!entry || !entry.v)
        return {resolved: false, types: [], fromTokens: [], propagated: [], node: entry?.node};

    const rep = f.getRepresentative(entry.v);
    const propagated = bitToTypeLabels(labels.labelBits.get(rep) ?? 0);
    const fromTokens = bitToTypeLabels(labels.tokenBits.get(rep) ?? 0);
    const merged = bitToTypeLabels((labels.labelBits.get(rep) ?? 0) | (labels.tokenBits.get(rep) ?? 0));
    return {resolved: true, types: merged, fromTokens, propagated, node: entry.node, var: rep.toString()};
}

/**
 * Reports the inferred types of all expressions that have labels (debug output).
 */
export function reportTypeLabels(f: FragmentState, labels: TypeLabels) {
    const lines: Array<string> = [];
    for (const [node] of f.a.typeLabels.entries()) {
        const nv = f.a.typeLabels.expVars.get(node);
        if (!nv)
            continue;
        const rep = f.getRepresentative(nv);
        const merged = labels.getTypes(rep);
        const loc = (node as any).loc as Location | null;
        const locStr = loc && loc.module
            ? `${relative(options.basedir, loc.module.getPath())}:${loc.start.line}:${loc.start.column + 1}`
            : "??";
        lines.push(`${locStr}: ${merged.join("|") || "?"}  (${(node as any).type})`);
    }
    lines.sort();
    logger.info(`Type labels for ${lines.length} expressions (propagation steps: ${labels.steps}):`);
    for (const l of lines)
        logger.info(`  ${l}`);
}
