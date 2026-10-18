import {Binding, NodePath} from "@babel/traverse";
import {Identifier, JSXIdentifier, Node} from "@babel/types";
import {CfgEvent} from "./cfg";
import {getProperty, skipParenthesizedChildren} from "../misc/asthelpers";
import type {ObjectKind} from "../analysis/tokens";

/**
 * Condition-based narrowing.
 *
 * At forks whose condition matches a recognized pattern (see conditionRefinements), the CFG
 * builder emits RefinementEvents into the branch successor blocks; the reaching-definitions
 * fixpoint (defuse.ts) propagates, kills, and joins them like ordinary definitions and
 * aggregates them into NodeRefinements; the constraint analysis then interprets the filters
 * on the token domain (analysis/typefilters.ts) and wires filtered flow into the refinement
 * variables (analysis/astvisitor.ts).
 */

/**
 * The result of 'typeof', as far as the token domain can distinguish it: objects and functions
 * are the only values tokens represent, so every other result — "undefined", "string", and
 * also a string no 'typeof' ever yields — is one indistinguishable case, "primitive".
 */
export type TypeOfKind = "function" | "object" | "primitive";

/**
 * A runtime test on a value, used by refinement events.
 */
export type TypeTest =
    | {kind: "truthy"} // the value is truthy
    | {kind: "nullish"} // the value is null or undefined
    | {kind: "typeof", type: TypeOfKind} // typeof yields this kind of string
    | {kind: "isArray"} // Array.isArray yields true
    | {kind: "instanceof", className: InstanceofClassName}; // instance of the named builtin class

/**
 * The builtin classes recognized in 'x instanceof C' conditions: "Function" plus the class
 * names that are token kinds (tied to ObjectKind via Extract, so renaming a kind fails to
 * compile here instead of silently breaking the filter interpretation in
 * analysis/typefilters.ts).
 */
export type InstanceofClassName = "Function" | Extract<ObjectKind,
    "Array" | "Map" | "Set" | "WeakMap" | "WeakSet" | "WeakRef" | "RegExp" | "Date" | "Promise" | "Error">;

/**
 * The recognized classes as an array with fixed order: the dynamic trace validator uses the
 * indices in its value tags (see testing/instrument.ts).
 */
export const INSTANCEOF_BUILTIN_CLASSES = [
    "Array", "Function", "Map", "Set", "WeakMap", "WeakSet", "WeakRef", "RegExp", "Date", "Promise", "Error",
] as const satisfies readonly InstanceofClassName[];

const INSTANCEOF_BUILTINS: ReadonlySet<string> = new Set(INSTANCEOF_BUILTIN_CLASSES);

/** Type guard for the recognized builtin class names. */
function isInstanceofBuiltinClass(name: string): name is InstanceofClassName {
    return INSTANCEOF_BUILTINS.has(name);
}

/**
 * A type filter: the refined value satisfies the test (or its negation).
 */
export type TypeFilter = {test: TypeTest, negated: boolean};

/**
 * A refinement event: a pseudo-definition expressing that, on this control flow path, the
 * variable's value is known to satisfy the filter (condition-based narrowing).
 */
export class RefinementEvent extends CfgEvent {
    constructor(node: Identifier | JSXIdentifier, binding: Binding | undefined,
                readonly filter: TypeFilter) {
        super(node, "write", binding);
    }
}

/**
 * A refinement of an identifier recognized in a branch condition:
 * in the branch where it applies, the identifier's value satisfies the (possibly negated) test.
 */
export type Refinement = {id: NodePath<Identifier>, test: TypeTest, negated: boolean};

/**
 * The refinements that hold on the two branches of a nullish fork: at 'l ?? r', the right
 * operand is evaluated only when 'l' is nullish. Recognized only when the operand is a bare
 * identifier — which cannot contain writes, so forkCond's staleness rule is not needed.
 */
export function nullishForkRefinements(path: NodePath): {whenNullish: Array<Refinement>, whenNotNullish: Array<Refinement>} {
    const p = skipParenthesizedChildren(path);
    if (p.isIdentifier())
        return {whenNullish: [{id: p, test: {kind: "nullish"}, negated: false}],
            whenNotNullish: [{id: p, test: {kind: "nullish"}, negated: true}]};
    return {whenNullish: [], whenNotNullish: []};
}

/** The result of conditionRefinements; treated as immutable (results are memoized and shared). */
export type ConditionRefinements = {whenTrue: Array<Refinement>, whenFalse: Array<Refinement>};

const NO_REFINEMENTS: ConditionRefinements = {whenTrue: [], whenFalse: []};

/**
 * Memoization of conditionRefinements per (parenthesis-skipped) AST node: the CFG builder
 * queries both entire branch conditions and their nested '&&'/'||' operands (which fork
 * separately), so without memoization a shared subtree at depth d would be walked d times
 * (quadratically many walks on left-nested operator chains, common in minified code).
 * The result is a pure function of the subtree, and entries die with the AST.
 */
const conditionCache = new WeakMap<Node, ConditionRefinements>();

/**
 * The refinements that hold in the true and false branches of the given condition expression.
 * Recognized patterns: 'x', '!e', 'typeof x ===/==/!==/!= <string>', 'x ===/==/!==/!= null',
 * 'x ===/==/!==/!= undefined' (or 'void 0'), 'Array.isArray(x)', 'x instanceof <builtin>',
 * and '&&'/'||'/'??' compositions.
 * The returned object is shared and must not be modified.
 */
export function conditionRefinements(path: NodePath): ConditionRefinements {
    const p = skipParenthesizedChildren(path);
    let r = conditionCache.get(p.node);
    if (!r) {
        r = computeConditionRefinements(p);
        conditionCache.set(p.node, r);
    }
    return r;
}

function computeConditionRefinements(p: NodePath): ConditionRefinements {
    const none = NO_REFINEMENTS;
    if (p.isIdentifier())
        return {whenTrue: [{id: p, test: {kind: "truthy"}, negated: false}],
            whenFalse: [{id: p, test: {kind: "truthy"}, negated: true}]};
    if (p.isUnaryExpression() && p.node.operator === "!") {
        const r = conditionRefinements(p.get("argument"));
        return {whenTrue: r.whenFalse, whenFalse: r.whenTrue};
    }
    if (p.isLogicalExpression()) {
        const l = conditionRefinements(p.get("left"));
        const r = conditionRefinements(p.get("right"));
        switch (p.node.operator) {
            case "&&": // true: both operands were truthy; false: unknown which failed
                return {whenTrue: [...l.whenTrue, ...r.whenTrue], whenFalse: []};
            case "||": // false: both operands were falsy; true: unknown which held
                return {whenTrue: [], whenFalse: [...l.whenFalse, ...r.whenFalse]};
            case "??":
                return none;
        }
    }
    if (p.isCallExpression()) {
        // Array.isArray(x)
        const callee = skipParenthesizedChildren(p.get("callee") as NodePath);
        if (callee.isMemberExpression() && getProperty(callee.node) === "isArray" &&
            p.node.arguments.length === 1) {
            const obj = skipParenthesizedChildren(callee.get("object"));
            if (obj.isIdentifier({name: "Array"}) && !obj.scope.getBinding("Array")) {
                const arg = skipParenthesizedChildren(p.get("arguments")[0] as NodePath);
                if (arg.isIdentifier())
                    return {whenTrue: [{id: arg, test: {kind: "isArray"}, negated: false}],
                        whenFalse: [{id: arg, test: {kind: "isArray"}, negated: true}]};
            }
        }
        return none;
    }
    if (p.isBinaryExpression()) {
        const op = p.node.operator;
        if (op === "instanceof") {
            // x instanceof <builtin>: in the true branch, x is an instance of the builtin class
            // (no refinement in the false branch: a token of the corresponding kind may fail the
            // test after prototype changes, so it cannot soundly be excluded there)
            const left = skipParenthesizedChildren(p.get("left") as NodePath);
            const right = skipParenthesizedChildren(p.get("right") as NodePath);
            if (left.isIdentifier() && right.isIdentifier() &&
                isInstanceofBuiltinClass(right.node.name) && !right.scope.getBinding(right.node.name))
                return {whenTrue: [{id: left, test: {kind: "instanceof", className: right.node.name}, negated: false}],
                    whenFalse: []};
            return none;
        }
        if (op !== "===" && op !== "!==" && op !== "==" && op !== "!=")
            return none;
        const strict = op === "===" || op === "!==";
        const negated = op === "!==" || op === "!=";
        const sides = [skipParenthesizedChildren(p.get("left") as NodePath), skipParenthesizedChildren(p.get("right") as NodePath)];
        for (const [a, b] of [[sides[0], sides[1]], [sides[1], sides[0]]]) {
            // typeof x <op> "T"
            if (a.isUnaryExpression() && a.node.operator === "typeof" && b.isStringLiteral()) {
                const arg = skipParenthesizedChildren(a.get("argument"));
                if (arg.isIdentifier()) {
                    const s = b.node.value;
                    const type: TypeOfKind = s === "function" || s === "object" ? s : "primitive";
                    const eq: Refinement = {id: arg, test: {kind: "typeof", type}, negated: false};
                    const ne: Refinement = {id: arg, test: {kind: "typeof", type}, negated: true};
                    return negated ? {whenTrue: [ne], whenFalse: [eq]} : {whenTrue: [eq], whenFalse: [ne]};
                }
            }
            // x <op> null / undefined / void 0
            const isNullish = b.isNullLiteral() ||
                (b.isIdentifier({name: "undefined"}) && !b.scope.getBinding("undefined")) ||
                (b.isUnaryExpression() && b.node.operator === "void");
            if (isNullish && a.isIdentifier()) {
                const eq: Refinement = {id: a, test: {kind: "nullish"}, negated: false};
                const ne: Refinement = {id: a, test: {kind: "nullish"}, negated: true};
                // with ===, the equal branch implies nullish (weakened for '=== null'/'=== undefined',
                // which is sound), but the other branch implies nothing; with ==, both branches are exact
                return negated
                    ? {whenTrue: strict ? [] : [ne], whenFalse: [eq]}
                    : {whenTrue: [eq], whenFalse: strict ? [] : [ne]};
            }
        }
    }
    return none;
}

/**
 * Node-level aggregation of the refinement events for one anchor and polarity
 * (see RefinementEvent in cfg.ts): a pseudo-definition whose value is any of the definitions in
 * `sources` that satisfies the filter. Refinement events in duplicated code (finally blocks)
 * with the same anchor and polarity are merged, like the other node-level views.
 */
export class NodeRefinement {

    /**
     * The definitions flowing into the refinement: write-site identifier nodes, other
     * refinements, and null for possibly-uninitialized. (May contain the refinement itself
     * for refinements in loop conditions.)
     */
    readonly sources = new Set<Identifier | JSXIdentifier | NodeRefinement | null>();

    constructor(
        /** The tested identifier occurrence in the branch condition. */
        readonly node: Identifier | JSXIdentifier,

        /** The filter that the refined value satisfies. */
        readonly filter: TypeFilter
    ) {}
}

