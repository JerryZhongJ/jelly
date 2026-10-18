import {
    Expression,
    Function,
    Identifier,
    isBigIntLiteral,
    isBinaryExpression,
    isBooleanLiteral,
    isIdentifier,
    isJSXIdentifier,
    isNullLiteral,
    isNumericLiteral,
    isParenthesizedExpression,
    isStringLiteral,
    isUnaryExpression,
    isUpdateExpression,
    JSXIdentifier,
    JSXMemberExpression,
    JSXNamespacedName,
    Node
} from "@babel/types";
import {NodePath} from "@babel/traverse";
import {
    AccessorType,
    AncestorsVar,
    ArgumentsVar,
    ConstraintVar,
    FunctionReturnVar,
    IntermediateVar,
    NodeVar,
    ObjectPropertyVar,
    ObjectPropertyVarObj,
    ReadResultVar,
    ThisVar
} from "./constraintvars";
import {ArrayToken} from "./tokens";
import {GlobalState} from "./globalstate";
import Solver from "./solver";
import {ARRAY_ALL, ARRAY_UNKNOWN} from "../natives/ecmascript";
import {getEnclosingNonArrowFunction} from "../misc/asthelpers";
import {options} from "../options";
import {Location} from "../misc/util";
import {NodeRefinement} from "../cfg/refine";
import {DefUse} from "../cfg/defuse";
import {ModuleInfo} from "./infos";
import assert from "assert";

export class ConstraintVarProducer {

    constructor(
        private readonly s: Solver,
        private readonly a: GlobalState,
    ) {}

    /** The module of the most recent def-use lookup (identVar is hot, see defUseOf). */
    private lastModule: ModuleInfo | undefined = undefined;

    private lastDefUse: DefUse | undefined = undefined;

    /**
     * Finds the def-use information for the given module, memoizing the most recent lookup
     * (identifier accesses resolve their module's information once per module visit rather
     * than once per identifier). The result for a module never changes: the analyzer
     * computes the information before the module's AST is visited.
     */
    private defUseOf(m: ModuleInfo): DefUse | undefined {
        if (m !== this.lastModule) {
            this.lastModule = m;
            this.lastDefUse = this.a.defUse.get(m);
        }
        return this.lastDefUse;
    }

    /**
     * Finds the constraint variable for the given expression in the current module.
     * For parenthesized expressions, the inner expression is used.
     * If the expression definitely cannot evaluate to a function value, undefined is returned.
     * For Identifier expressions, the declaration node is used as constraint variable.
     * For other expressions, the expression itself is used.
     */
    expVar(exp: Expression | JSXIdentifier | JSXMemberExpression | JSXNamespacedName, path: NodePath): ConstraintVar | undefined {
        return this.expVar2(exp, path).v;
    }

    expVar2(exp: Expression | JSXIdentifier | JSXMemberExpression | JSXNamespacedName, path: NodePath): {
        v: ConstraintVar | undefined,
        unbound?: boolean
    } {
        while (isParenthesizedExpression(exp))
            exp = exp.expression; // for parenthesized expressions, use the inner expression
        if (isJSXIdentifier(exp) && exp.name[0] !== exp.name[0].toUpperCase()) // component names always start with capital letter
            return {v: undefined};
        if (isIdentifier(exp) || isJSXIdentifier(exp)) {
            if (exp.name === "undefined" && !path.scope.getBinding(exp.name)) // 'undefined' is non-writable and non-configurable
                return {v: undefined};
            return this.identVar2(exp, path);
        } else if (isNumericLiteral(exp) || isBigIntLiteral(exp) || isNullLiteral(exp) || isBooleanLiteral(exp) ||
            isStringLiteral(exp) || // note: currently skipping string literals
            isUnaryExpression(exp) || isBinaryExpression(exp) || isUpdateExpression(exp))
            return {v: undefined}; // those expressions never evaluate to functions or objects and can safely be skipped
        return {v: this.nodeVar(exp)};
    }

    /**
     * Finds the constraint variable for the given identifier in the current module.
     * With --no-def-use, the variable's declaration node is used (flow-insensitively: all
     * writes flow there). Otherwise, reads and writes of refinable bindings (see cfg/defuse.ts)
     * instead use the occurrence node itself; astvisitor connects those variables by
     * definition-to-use subset edges.
     */
    identVar(id: Identifier | JSXIdentifier, path: NodePath, access: "read" | "write" = "read"): ConstraintVar {
        return this.identVar2(id, path, access).v;
    }

    /**
     * Like identVar, but also reports whether the identifier is unbound (a global).
     */
    identVar2(id: Identifier | JSXIdentifier, path: NodePath, access: "read" | "write" = "read"): {
        v: ConstraintVar,
        unbound?: boolean
    } {
        const binding = path.scope.getBinding(id.name);
        if (binding) {
            if (options.defUse) {
                // flow-sensitive treatment: use the occurrence node for refinable bindings
                // (refinability guarantees def-use information for every access)
                const du = this.defUseOf((id.loc as Location).module!);
                if (du && du.refinable.has(binding)) {
                    assert(access === "read" ? du.nodeDefs.has(id) : du.writeNodes.has(id),
                        "access of refinable binding without def-use information");
                    // reads with the same definition set share their representative's variable
                    return {v: this.nodeVar(access === "read" ? du.rep(id) : id)};
                }
            }
            return {v: this.nodeVar(binding.identifier)};
        } else if (id.name === "arguments")
            return {v: this.argumentsVar(getEnclosingNonArrowFunction(path) ?? (id.loc as Location).module!)};
        else
            return {v: this.objPropVar(this.a.globalSpecialNatives!["globalThis"], id.name), unbound: true};
    }

    /**
     * Finds the constraint variable for a definition from the def-use information
     * (with options.defUse): for an ordinary definition, the write-site identifier node;
     * for a refinement pseudo-definition, a variable that receives the values of the
     * definitions flowing into the refinement that satisfy its filter
     * (see the constraints added in astvisitor).
     */
    defVar(d: Identifier | JSXIdentifier | NodeRefinement): ConstraintVar {
        return d instanceof NodeRefinement
            ? this.intermediateVar(d.node, d.filter.negated ? "refine-negative" : "refine-positive")
            : this.nodeVar(d);
    }

    /**
     * Finds the constraint variable for a named object property.
     * The (obj, prop) pair is registered on the provided solver instance and listener calls may be enqueued.
     */
    objPropVar(obj: ObjectPropertyVarObj, prop: string, accessor: AccessorType = "normal"): ObjectPropertyVar {
        return this.a.canonicalizeVar(ObjectPropertyVar.make(this.s, obj, prop, accessor));
    }

    /**
     * Finds the constraint variable for the array's unknown entries.
     */
    arrayUnknownVar(arr: ArrayToken): ObjectPropertyVar {
        return this.objPropVar(arr, ARRAY_UNKNOWN);
    }

    /**
     * Finds the summary constraint variable for the array.
     * This variable contains the union of tokens in the array's known and unknown entries.
     */
    arrayAllVar(arr: ArrayToken): ObjectPropertyVar {
        return this.objPropVar(arr, ARRAY_ALL);
    }

    /**
     * Finds the constraint variable representing the return values of the given function.
     */
    returnVar(fun: Function): FunctionReturnVar {
        return this.a.canonicalizeVar(new FunctionReturnVar(fun));
    }

    /**
     * Finds the constraint variable representing 'this' for the given function.
     */
    thisVar(fun: Function): ThisVar {
        return this.a.canonicalizeVar(new ThisVar(fun));
    }

    /**
     * Finds the constraint variable representing 'arguments' for the given function.
     */
    argumentsVar(fun: Function | ModuleInfo): ArgumentsVar {
        return this.a.canonicalizeVar(new ArgumentsVar(fun));
    }

    /**
     * Finds the constraint variable representing the given intermediate result.
     */
    intermediateVar(n: Node, label: string): IntermediateVar {
        return this.a.canonicalizeVar(new IntermediateVar(n, label));
    }

    /**
     * Finds the constraint variable representing the given AST node (or undefined).
     */
    nodeVar(n: Node): NodeVar
    nodeVar(n: Node | undefined): NodeVar | undefined {
        return n !== undefined ? this.a.canonicalizeVar(new NodeVar(n)) : undefined;
    }

    ancestorsVar(t: ObjectPropertyVarObj): AncestorsVar {
        return this.a.canonicalizeVar(new AncestorsVar(t));
    }

    readResultVar(t: ObjectPropertyVarObj, prop: string): ReadResultVar {
        return this.a.canonicalizeVar(new ReadResultVar(t, prop));
    }
}
