import {Binding} from "@babel/traverse";
import {Class, Function, Identifier, JSXIdentifier, Program} from "@babel/types";

/**
 * Control flow graphs (CFGs) that model the possible orders of identifier reads and writes.
 */

/**
 * The kind of an identifier access.
 */
export type AccessKind = "read" | "write";

/**
 * An identifier access event: an occurrence of an identifier read or write in the CFG.
 *
 * Events are unique objects: the same Identifier AST node may occur in multiple events, both
 * within one CFG (finally blocks are duplicated per exit path, and compound assignments and
 * update expressions produce a read event and a write event for the same node) and across
 * the ProgramCFG. Use ProgramCFG.occurrences to find all events for an Identifier.
 */
export class CfgEvent {

    constructor(
        /**
         * The identifier AST node being accessed.
         */
        readonly node: Identifier | JSXIdentifier,

        /**
         * Whether the access is a read or a write.
         */
        readonly kind: AccessKind,

        /**
         * The binding the identifier resolves to, or undefined if the identifier is global or
         * cannot be resolved. Babel's Binding objects are canonical (all references to the same
         * variable yield the identical object), so bindings can be used directly as map keys.
         *
         * Caution: if the enclosing FunctionCFG (or that of a lexically enclosing function) has
         * hasWith or hasDirectEval set, bindings in its scope cannot be fully trusted.
         */
        readonly binding: Binding | undefined
    ) {}
}

/**
 * A basic block in the control flow graph.
 */
export class BasicBlock {

    /**
     * The identifier access events of this block, in execution order.
     */
    readonly events: Array<CfgEvent> = [];

    /**
     * The successor for normal control flow (for branch blocks: the "truthy" branch).
     * Undefined for exit blocks and for blocks that always complete abruptly
     * (throw, return, break, continue).
     */
    succNormal?: BasicBlock;

    /**
     * The successor for the "falsy" branch at branch blocks
     * (if/loop/conditional tests, logical operators, optional chaining, and other
     * nondeterministic forks such as generator early termination at yield).
     * Undefined for non-branch blocks.
     */
    succFalse?: BasicBlock;

    /**
     * The successor for exception control flow: the innermost enclosing catch/finally
     * continuation, or the exception exit of the function.
     * Per the exception rule, control may transfer here after any prefix of this block's events.
     * Undefined only for blocks that represent no executable code (in particular exit blocks).
     */
    succException?: BasicBlock;

    constructor(succException?: BasicBlock) {
        this.succException = succException;
    }
}

/**
 * The control flow graph for the code belonging to one function (or the top-level code of a
 * program, or the constructor of a class).
 */
export class FunctionCFG {

    /**
     * The entry basic block.
     */
    entry: BasicBlock;

    /**
     * The normal (return/completion) exit basic block. Contains no events and has no successors.
     */
    readonly exit: BasicBlock = new BasicBlock();

    /**
     * The exception exit basic block, reached when an exception propagates out of the function.
     * Contains no events and has no successors.
     */
    readonly exitException: BasicBlock = new BasicBlock();

    /**
     * The bindings introduced by declarations lexically inside this function (excluding nested
     * functions): parameters, var/let/const, function and class declarations, imports, and
     * catch parameters. This is the candidate set of variables for def-use refinement,
     * and gives an O(1) test for whether an event's binding is local to this
     * function or belongs to an enclosing one.
     */
    readonly declares: Set<Binding> = new Set();

    /**
     * True if this function contains a 'with' statement, or is itself nested inside a 'with'
     * body. Bindings of events in this function are then unreliable: identifiers may actually
     * resolve to properties of the 'with' object. Event *orders* remain correct.
     */
    hasWith: boolean = false;

    /**
     * True if this function (or a function nested inside it) contains a direct call to 'eval'.
     * The evaluated code can read and write any binding in scope at the call — including this
     * function's — without corresponding events in the CFG, so all bindings of this function
     * must be treated conservatively. Event orders of the surrounding code remain correct.
     */
    hasDirectEval: boolean = false;

    /**
     * True if this function references the implicit 'arguments' object (directly, or via a
     * nested arrow function). In sloppy mode, the arguments object aliases simple parameters,
     * so parameters can then be read and written without corresponding events in the CFG and
     * must be treated conservatively (for CommonJS programs, this also concerns the artificial
     * module parameters). Event orders remain correct.
     */
    usesArguments: boolean = false;

    constructor() {
        this.entry = new BasicBlock();
    }
}

/**
 * The control flow graphs for a program.
 */
export class ProgramCFG {

    /**
     * The CFGs for the top-level program code and for all functions and classes.
     * For classes, the FunctionCFG represents the constructor, including instance field
     * initializers at their execution points (at entry for base classes, after super() calls
     * for derived classes); the constructor ClassMethod itself does not appear as a key.
     * Class definition-time computation (decorators, superclass expression, computed keys,
     * static field initializers and static blocks) belongs to the CFG of the function
     * containing the class definition.
     */
    readonly functions: Map<Program | Function | Class, FunctionCFG> = new Map();

    /**
     * All events for each Identifier AST node, across all functions.
     * (An identifier can have multiple events, see CfgEvent.)
     */
    readonly occurrences: Map<Identifier | JSXIdentifier, Array<CfgEvent>> = new Map();

    /**
     * Bindings that are exported as ES module live bindings ('export {x}', 'export let x = ...',
     * 'export function f ...', 'export default function f ...'). Importers observe such
     * variables over time (including reassignments after the export executed), which no single
     * read event can express, so these bindings are excluded from def-use refinement.
     */
    readonly exportedLiveBindings: Set<Binding> = new Set();

    /**
     * Bindings with writes the builder recognized but did not model precisely (currently:
     * Annex B function declarations in if-statement clauses, which are function-scoped in
     * sloppy mode yet not covered by the scope-entry hoisting of function declarations).
     * Such bindings are excluded from def-use refinement — the general fail-closed rule:
     * a construct that is not modeled precisely excludes its bindings rather than silently
     * dropping writes.
     */
    readonly unhandledBindings: Set<Binding> = new Set();
}
