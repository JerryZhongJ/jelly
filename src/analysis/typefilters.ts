import {AccessPathToken, AllocationSiteToken, ArrayToken, FunctionToken, PackageObjectToken, Token} from "./tokens";
import {TypeFilter} from "../cfg/refine";

/**
 * Interpretation of refinement type filters (see cfg/refine.ts) on the token domain.
 * Tokens represent objects and functions, except AccessPathTokens, which stand for unknown
 * external values (possibly primitive, falsy, or nullish) and therefore pass every filter:
 * - all other tokens are truthy (ignoring the legacy 'document.all' exotic object) and
 *   non-nullish;
 * - FunctionTokens have typeof "function" and AllocationSiteTokens have typeof "object",
 *   except the callable PromiseResolve/PromiseReject kinds, which have typeof "function"
 *   (mirroring getNativeType in natives/ecmascript.ts);
 * - NativeObjectToken and PackageObjectToken represent values of unknown typeof and
 *   conservatively pass both "function" and "object" filters;
 * - only ArrayTokens are arrays (Array.isArray checks the internal slot, so this is exact);
 * - for 'instanceof' with a builtin class, an AllocationSiteToken of the corresponding kind is
 *   an instance, tokens of kind Object or Prototype may be instances of subclasses, and tokens
 *   of other kinds (and functions, except for 'instanceof Function') are not.
 */

/**
 * The typeof string of the values a token represents, or undefined if unknown.
 */
function tokenTypeof(t: Token): "function" | "object" | undefined {
    if (t instanceof FunctionToken)
        return "function";
    if (t instanceof AllocationSiteToken)
        switch (t.kind) {
            case "PromiseResolve":
            case "PromiseReject":
                return "function"; // callable natives, dispatched as calls (see analysis/operations.ts)
            case "Object":
            case "Array":
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
            case "Error":
            case "Prototype":
            case "ArrayKeys":
            case "ArrayValues":
            case "ArrayEntries":
            case "SetValues":
            case "SetEntries":
            case "MapKeys":
            case "MapValues":
            case "MapEntries":
                return "object";
            default: {
                // a new ObjectKind must be classified here deliberately
                const missing: never = t.kind;
                return missing;
            }
        }
    return undefined;
}

/** True if the token is an AllocationSiteToken representing a callable value. */
function isCallableAllocation(t: Token): boolean {
    return t instanceof AllocationSiteToken && (t.kind === "PromiseResolve" || t.kind === "PromiseReject");
}

/**
 * Checks whether values represented by the token may satisfy the filter.
 */
export function tokenMaySatisfy(t: Token, filter: TypeFilter): boolean {
    if (t instanceof AccessPathToken)
        return true; // unknown external value: no filter can refute it
    switch (filter.test.kind) {
        case "truthy":
            return !filter.negated;
        case "nullish":
            return filter.negated;
        case "typeof": {
            const type = filter.test.type;
            if (type === "primitive")
                return filter.negated; // objects and functions never have primitive typeof
            const to = tokenTypeof(t);
            if (to === undefined)
                return true;
            return (to === type) !== filter.negated;
        }
        case "isArray": {
            if (t instanceof ArrayToken)
                return !filter.negated;
            if (t instanceof FunctionToken || t instanceof AllocationSiteToken)
                return filter.negated; // definitely not an array
            if (t instanceof PackageObjectToken && t.kind !== "Object") // (kind Object is the broad abstraction)
                return (t.kind === "Array") !== filter.negated;
            return true; // unknown
        }
        case "instanceof": {
            if (filter.negated)
                return true; // (not emitted by the builder; conservatively the identity)
            const c = filter.test.className;
            if (t instanceof FunctionToken || isCallableAllocation(t))
                return c === "Function";
            const k = t instanceof AllocationSiteToken ? t.kind :
                t instanceof PackageObjectToken && t.kind !== "Object" ? t.kind : undefined;
            if (k === undefined)
                return true; // unknown
            if (k === "Object" || k === "Prototype")
                return true; // may be a subclass instance
            switch (c) { // exhaustive over InstanceofClassName: a new class must be classified here deliberately
                case "Function":
                    return false; // callable tokens were handled above
                case "Array":
                case "Map":
                case "Set":
                case "WeakMap":
                case "WeakSet":
                case "WeakRef":
                case "RegExp":
                case "Date":
                case "Promise":
                case "Error":
                    return k === c; // the class names are the token kinds
                default: {
                    const missing: never = c;
                    return missing;
                }
            }
        }
    }
}

/**
 * True if every token satisfies the filter (the refinement is the identity on tokens),
 * so plain subset edges suffice.
 * (There is no dual "no token satisfies the filter": AccessPathTokens pass every filter.)
 */
export function filterAcceptsAllTokens(filter: TypeFilter): boolean {
    switch (filter.test.kind) {
        case "truthy":
            return !filter.negated;
        case "nullish":
            return filter.negated;
        case "typeof":
            return filter.negated && filter.test.type === "primitive";
        case "isArray":
            return false;
        case "instanceof":
            return filter.negated; // (not emitted by the builder)
    }
}
