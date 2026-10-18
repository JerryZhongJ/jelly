import traverse, {Binding, NodePath} from "@babel/traverse";
import {
    CallExpression,
    Class,
    ClassAccessorProperty,
    ClassPrivateProperty,
    ClassProperty,
    Expression,
    File,
    getBindingIdentifiers,
    Function,
    Identifier,
    JSXElement,
    JSXFragment,
    JSXIdentifier,
    LVal,
    NewExpression,
    Node,
    ObjectExpression,
    OptionalCallExpression,
    OptionalMemberExpression,
    Program,
    Statement,
    TemplateLiteral,
    VariableDeclaration,
    YieldExpression,
} from "@babel/types";
import assert from "assert";
import {AccessKind, BasicBlock, CfgEvent, FunctionCFG, ProgramCFG} from "./cfg";
import {conditionRefinements, nullishForkRefinements, Refinement, RefinementEvent} from "./refine";
import {getOrSet, locationToString, mapGetArray} from "../misc/util";
import {findConstructor, getDecoratorExpressions, getEnclosingNonArrowFunction, hasNode, hoistedFunctionDeclarations, isStrictCode, skipParenthesizedChildren} from "../misc/asthelpers";

/**
 * Thrown if CFG construction encounters an AST node it cannot handle soundly.
 */
export class CFGBuildError extends Error {}

/**
 * A lazily materialized basic block, used as continuation target.
 * Laziness matters for finally blocks: a finally copy for a given exit path
 * (fallthrough, exception, return, each break/continue target) is only built
 * if some path actually uses it.
 */
type Thunk = () => BasicBlock;

function lazy(f: () => BasicBlock): Thunk {
    let b: BasicBlock | undefined;
    return () => (b ??= f());
}

/**
 * Context for the recursive descent: the continuations of the code currently being visited.
 * Immutable; constructs that change control flow (loops, labels, try) extend it.
 */
type Ctx = {

    /** Where an exception thrown here goes (innermost handler continuation, or the exception exit). */
    readonly exc: Thunk;

    /** Where 'return' goes (through the copies of enclosing finally blocks, to the exit). */
    readonly ret: Thunk;

    /** Resolves 'break'/'continue' targets (through the copies of enclosing finally blocks). */
    readonly jump: (kind: "break" | "continue", label?: string) => Thunk | undefined;
};

/**
 * Builds the control flow graphs for a program.
 * The AST is expected to be desugared (see parsing/parser.ts); in particular, the parser
 * gives every class an explicit constructor (parsing/extras.ts). Should a base class
 * nevertheless lack one, a conservative fallback builds its field initializers only;
 * for a derived class the constructor is required (its field initializers run during
 * super() calls, which only the constructor can contain), enforced by an assertion.
 * Throws CFGBuildError on AST nodes that cannot be handled soundly.
 * @param ast the AST of the program
 * @param refinements whether to emit refinement pseudo-definitions at branch conditions
 * (condition-based narrowing, see RefinementEvent); they are sound to ignore, but consumers
 * that do not use them get simpler def-use information without them
 */
export function buildProgramCFG(ast: File, refinements: boolean = true): ProgramCFG {
    return new CFGBuilder(refinements).buildProgram(ast);
}

class CFGBuilder {

    constructor(
        /** Whether to emit refinement pseudo-definitions (see emitRefinements). */
        private readonly refinements: boolean
    ) {}

    readonly pcfg = new ProgramCFG();

    /**
     * The FunctionCFG for each Program/Function/Class node; constructor ClassMethods map to
     * their class's FunctionCFG. Used for binding home lookup and eval/with flag propagation.
     */
    private readonly cfgOf = new Map<Node, FunctionCFG>();

    /** Memoized binding home lookup, see homeCfg. */
    private readonly homes = new Map<Binding, FunctionCFG | undefined>();

    /** The Program node (for attributing top-level 'arguments' references). */
    private programNode!: Program;

    /**
     * The bindings written so far, in event emission order; forkCond records its length
     * around building a branch condition to detect writes inside the condition.
     * Only populated when refinements are enabled (its sole consumer).
     */
    private readonly writeLog: Array<Binding> = [];

    /** The FunctionDeclaration nodes whose bindings are initialized by hoistFunctionDeclarations. */
    private readonly hoistedDeclarations = new Set<Node>();

    /** The CFG currently being built. */
    private fcfg!: FunctionCFG;

    /**
     * The node whose scope holds function-level declarations of the CFG currently being built
     * (the Program, Function, or constructor ClassMethod node).
     */
    private scopeRoot!: Node;

    /**
     * Instance field initializers to splice in after 'super()' calls, when building the
     * constructor of a derived class (or an arrow function lexically inside one).
     */
    private fields: Array<NodePath<ClassProperty | ClassPrivateProperty | ClassAccessorProperty>> = [];

    buildProgram(ast: File): ProgramCFG {
        // phase 1: register a FunctionCFG for the program and every function and class
        const roots: Array<NodePath<Program | Function | Class>> = [];
        const reg = (path: NodePath<Program | Function | Class>) => {
            const f = new FunctionCFG();
            this.pcfg.functions.set(path.node, f);
            this.cfgOf.set(path.node, f);
            roots.push(path);
            return f;
        };
        traverse(ast, {
            Program: path => {
                this.programNode = path.node;
                reg(path);
            },
            Function(path) {
                if (path.isClassMethod() && path.node.kind === "constructor")
                    return; // built as part of its class
                reg(path);
            },
            Class(path) {
                reg(path);
            },
        });
        // map each explicit constructor ClassMethod to its class's CFG (see cfgOf)
        for (const path of roots)
            if (path.isClass()) {
                const ctor = findConstructor(path);
                if (ctor)
                    this.cfgOf.set(ctor.node, this.cfgOf.get(path.node)!);
            }
        // phase 2: build each CFG
        for (const path of roots)
            this.buildRoot(path);
        return this.pcfg;
    }

    private static instanceFields(path: NodePath<Class>): Array<NodePath<ClassProperty | ClassPrivateProperty | ClassAccessorProperty>> {
        return path.get("body").get("body").filter((e): e is NodePath<ClassProperty | ClassPrivateProperty | ClassAccessorProperty> =>
            (e.isClassProperty() || e.isClassPrivateProperty() || e.isClassAccessorProperty()) &&
            !e.node.static && e.node.value != null);
    }

    /**
     * Builds the FunctionCFG for a program, function, or class (constructor).
     */
    private buildRoot(path: NodePath<Program | Function | Class>): void {
        const f = this.cfgOf.get(path.node)!;
        this.fcfg = f;
        this.fields = [];
        f.entry.succException = f.exitException;
        const excT = () => f.exitException, retT = () => f.exit;
        const ctx: Ctx = {exc: excT, ret: retT, jump: () => undefined};
        let b = f.entry;
        if (path.isProgram()) {
            this.scopeRoot = path.node;
            // module import bindings and function declarations are initialized before the statements execute
            b = this.hoistImports(path, b);
            b = this.hoistFunctionDeclarations(path.get("body"), b);
            b = this.stmtSeq(path.get("body"), b, ctx);
        } else if (path.isClass()) {
            const ctor = findConstructor(path);
            const fields = CFGBuilder.instanceFields(path);
            this.scopeRoot = ctor ? ctor.node : path.node;
            if (path.node.superClass) {
                // the parser guarantees a constructor (see the class documentation above);
                // without one, the field initializers below would never be built
                assert(ctor, "derived class without constructor");
                this.fields = fields; // initialized during super() calls, see the CallExpression case
            } else
                // base class: instance fields are initialized before parameter binding
                // ([[Construct]] runs InitializeInstanceElements before evaluating the body)
                for (const fp of fields)
                    b = this.expr(fp.get("value") as NodePath<Expression>, b, ctx);
            if (ctor)
                b = this.functionEntry(ctor, b, ctx);
        } else {
            const fp = path as NodePath<Function>;
            this.scopeRoot = fp.node;
            // an arrow function lexically inside a derived-class constructor shares its
            // 'super' binding, so super() calls in it also trigger instance field initialization
            this.fields = CFGBuilder.superCallFields(fp);
            b = this.functionEntry(fp, b, ctx);
        }
        this.link(b, f.exit);
        this.removeEmptyBlocks(f);
    }

    /**
     * Finds the instance field initializers relevant for super() calls inside the given function:
     * nonempty only for arrow functions whose nearest non-arrow enclosing function is the
     * constructor of a derived class.
     */
    private static superCallFields(path: NodePath<Function>): Array<NodePath<ClassProperty | ClassPrivateProperty | ClassAccessorProperty>> {
        let p: NodePath | null = path;
        while (p && p.isArrowFunctionExpression()) {
            p = p.findParent(q => q.isFunction()) as NodePath | null;
            if (!p)
                return [];
            if (p.isClassMethod() && p.node.kind === "constructor") {
                const cls = p.parentPath.parentPath;
                if (cls && cls.isClass() && cls.node.superClass)
                    return CFGBuilder.instanceFields(cls);
                return [];
            }
        }
        return [];
    }

    /**
     * Builds parameter bindings and the body of a function (or constructor).
     */
    private functionEntry(path: NodePath<Function>, b: BasicBlock, ctx: Ctx): BasicBlock {
        for (const p of path.get("params"))
            b = this.pattern(p, b, ctx);
        const body = path.get("body");
        if (body.isBlockStatement()) {
            const stmts = body.get("body");
            // function declarations in the body are initialized after parameter binding
            b = this.hoistFunctionDeclarations(stmts, b);
            b = this.stmtSeq(stmts, b, ctx);
        } else {
            assert(body.isExpression());
            b = this.expr(body, b, ctx);
        }
        return b;
    }

    /**
     * Emits write events for module import bindings (initialized before module code runs).
     */
    private hoistImports(path: NodePath<Program>, b: BasicBlock): BasicBlock {
        for (const s of path.get("body"))
            if (s.isImportDeclaration())
                for (const spec of s.get("specifiers"))
                    this.emit(b, spec.get("local"), "write");
        return b;
    }

    /**
     * Emits write events for the function declarations directly among the given statements
     * (they are initialized when the enclosing scope is entered, before the statements execute).
     */
    private hoistFunctionDeclarations(stmts: Array<NodePath<Statement>>, b: BasicBlock): BasicBlock {
        for (const d of hoistedFunctionDeclarations(stmts)) {
            this.hoistedDeclarations.add(d.node);
            this.emit(b, d.get("id") as NodePath<Identifier>, "write");
        }
        return b;
    }

    /*
     * Statements
     */

    private stmtSeq(paths: Array<NodePath<Statement>>, b: BasicBlock, ctx: Ctx): BasicBlock {
        for (const p of paths)
            b = this.stmt(p, b, ctx);
        return b;
    }

    /**
     * Visits a statement. Events are appended starting at block b; the returned block is where
     * normal fall-through control flow continues (a fresh unreachable block if the statement
     * always completes abruptly).
     * @param path the statement
     * @param b the basic block where the statement's events start
     * @param ctx the current context
     * @param labels the labels attached to this statement (from enclosing LabeledStatements)
     */
    private stmt(path: NodePath<Statement>, b: BasicBlock, ctx: Ctx, labels: Array<string> = []): BasicBlock {
        if (path.isLabeledStatement())
            return this.stmt(path.get("body"), b, ctx, [...labels, path.node.label.name]);
        if (labels.length > 0 && !path.isLoop() && !path.isSwitchStatement()) {
            // labeled non-loop statement: 'break label' jumps past it
            const after = this.newBlock(ctx);
            const afterT = () => after;
            const lctx: Ctx = {...ctx, jump: (kind, label) =>
                kind === "break" && label !== undefined && labels.includes(label) ? afterT : ctx.jump(kind, label)};
            this.link(this.stmtDispatch(path, b, lctx, []), after);
            return after;
        }
        return this.stmtDispatch(path, b, ctx, labels);
    }

    private stmtDispatch(path: NodePath<Statement>, b: BasicBlock, ctx: Ctx, labels: Array<string>): BasicBlock {
        const node = path.node;
        switch (node.type) {

            case "ExpressionStatement":
                return this.expr((path as NodePath<typeof node>).get("expression"), b, ctx);

            case "BlockStatement": {
                const stmts = (path as NodePath<typeof node>).get("body");
                // block-scoped function declarations are initialized at block entry
                b = this.hoistFunctionDeclarations(stmts, b);
                return this.stmtSeq(stmts, b, ctx);
            }

            case "EmptyStatement":
            case "DebuggerStatement":
                return b;

            case "VariableDeclaration":
                return this.variableDeclaration(path as NodePath<typeof node>, b, ctx);

            case "FunctionDeclaration": {
                if (node.declare)
                    return b;
                // The binding is initialized at scope entry (see hoistFunctionDeclarations).
                // In sloppy mode, Annex B additionally assigns block-level function bindings to a
                // function-scoped variable when the declaration is evaluated; model that as an
                // optional write (the copy is a no-op if the block binding is unchanged).
                const id = (path as NodePath<typeof node>).get("id");
                if (hasNode(id)) {
                    const binding = path.scope.getBinding(id.node.name);
                    if (binding) {
                        if (!this.hoistedDeclarations.has(node))
                            // not initialized by any scope-entry hoisting (Annex B function
                            // declarations in if-statement clauses): the writes are not
                            // modeled, so the binding is excluded from def-use refinement
                            this.pcfg.unhandledBindings.add(binding);
                        if (binding.scope.block !== this.scopeRoot && !isStrictCode(path)) {
                            const [w, skip] = this.fork(b, ctx);
                            this.emit(w, id, "write");
                            return this.join(ctx, w, skip);
                        }
                    }
                }
                return b;
            }

            case "ClassDeclaration":
                if (node.declare)
                    return b;
                return this.classDefinition(path as NodePath<typeof node>, b, ctx);

            case "IfStatement": {
                const p = path as NodePath<typeof node>;
                const [t, f] = this.forkCond(p.get("test"), b, ctx);
                const alt = p.get("alternate");
                return this.join(ctx, this.stmt(p.get("consequent"), t, ctx), hasNode(alt) ? this.stmt(alt, f, ctx) : f);
            }

            case "SwitchStatement": {
                const p = path as NodePath<typeof node>;
                b = this.expr(p.get("discriminant"), b, ctx);
                const cases = p.get("cases");
                // block-scoped function declarations in the case bodies are initialized at case-block entry
                b = this.hoistFunctionDeclarations(cases.flatMap(c => c.get("consequent")), b);
                const after = this.newBlock(ctx);
                const afterT = () => after;
                const sctx: Ctx = {...ctx, jump: (kind, label) =>
                    kind === "break" && (label === undefined || labels.includes(label)) ? afterT : ctx.jump(kind, label)};
                // case bodies, with fallthrough
                const entries = cases.map(() => this.newBlock(sctx));
                for (let i = 0; i < cases.length; i++)
                    this.link(this.stmtSeq(cases[i].get("consequent"), entries[i], sctx), entries[i + 1] ?? after);
                // case tests, evaluated in source order (the default case is skipped during testing)
                let cur = b, defaultIndex = -1;
                for (let i = 0; i < cases.length; i++) {
                    const test = cases[i].get("test");
                    if (!hasNode(test)) {
                        defaultIndex = i;
                        continue;
                    }
                    cur = this.expr(test, cur, ctx);
                    const [match, next] = this.fork(cur, ctx);
                    this.link(match, entries[i]);
                    cur = next;
                }
                this.link(cur, defaultIndex >= 0 ? entries[defaultIndex] : after);
                return after;
            }

            case "WhileStatement": {
                const p = path as NodePath<typeof node>;
                const header = this.newBlock(ctx);
                const headerT = () => header;
                this.link(b, header);
                const [body, exit] = this.forkCond(p.get("test"), header, ctx);
                // 'after' is separate from 'exit' so that break paths bypass the exit refinements
                const after = this.linkNew(exit, ctx);
                const afterT = () => after;
                this.link(this.stmt(p.get("body"), body, this.loopCtx(ctx, labels, afterT, headerT)), header);
                return after;
            }

            case "DoWhileStatement": {
                const p = path as NodePath<typeof node>;
                const bodyEntry = this.newBlock(ctx);
                this.link(b, bodyEntry);
                const test = this.newBlock(ctx); // 'continue' target
                const after = this.newBlock(ctx);
                const out = this.stmt(p.get("body"), bodyEntry, this.loopCtx(ctx, labels, () => after, () => test));
                this.link(out, test);
                // refinements in 'done' apply only to the loop-condition exit;
                // break paths go directly to 'after'
                const [again, done] = this.forkCond(p.get("test"), test, ctx);
                this.link(again, bodyEntry);
                this.link(done, after);
                return after;
            }

            case "ForStatement": {
                const p = path as NodePath<typeof node>;
                const init = p.get("init");
                if (hasNode(init))
                    b = init.isVariableDeclaration() ? this.variableDeclaration(init, b, ctx) : this.expr(init as NodePath<Expression>, b, ctx);
                const header = this.newBlock(ctx);
                this.link(b, header);
                const after = this.newBlock(ctx);
                const test = p.get("test");
                let bodyEntry: BasicBlock;
                if (hasNode(test)) {
                    // refinements in 'f' apply only to the test exit;
                    // break paths go directly to 'after'
                    const [t, f] = this.forkCond(test, header, ctx);
                    bodyEntry = t;
                    this.link(f, after);
                } else
                    bodyEntry = header; // no test: 'after' is only reachable via break
                const update = this.newBlock(ctx); // 'continue' target
                const out = this.stmt(p.get("body"),
                    bodyEntry === header ? this.linkNew(header, ctx) : bodyEntry,
                    this.loopCtx(ctx, labels, () => after, () => update));
                this.link(out, update);
                const upd = p.get("update");
                this.link(hasNode(upd) ? this.expr(upd, update, ctx) : update, header);
                return after;
            }

            case "ForInStatement":
            case "ForOfStatement": {
                const p = path as NodePath<typeof node>;
                b = this.expr(p.get("right") as NodePath<Expression>, b, ctx);
                const header = this.newBlock(ctx); // one nondeterministic fork per iteration: another round or done
                const headerT = () => header;
                this.link(b, header);
                const [iter, after] = this.fork(header, ctx);
                const left = p.get("left");
                let ib = iter;
                if (left.isVariableDeclaration())
                    ib = this.pattern(left.get("declarations")[0].get("id"), ib, ctx);
                else
                    ib = this.pattern(left as NodePath<LVal>, ib, ctx);
                const out = this.stmt(p.get("body"), ib, this.loopCtx(ctx, labels, () => after, headerT));
                this.link(out, header);
                return after;
            }

            case "BreakStatement":
            case "ContinueStatement": {
                const kind = node.type === "BreakStatement" ? "break" : "continue";
                const t = ctx.jump(kind, node.label?.name);
                if (!t)
                    throw new CFGBuildError(`No target for ${kind}${node.label ? ` ${node.label.name}` : ""} at ${locationToString(node.loc, true, true)}`);
                this.link(b, t());
                return this.newBlock(ctx); // unreachable
            }

            case "ReturnStatement": {
                const arg = (path as NodePath<typeof node>).get("argument");
                if (hasNode(arg))
                    b = this.expr(arg, b, ctx);
                this.link(b, ctx.ret());
                return this.newBlock(ctx); // unreachable
            }

            case "ThrowStatement":
                b = this.expr((path as NodePath<typeof node>).get("argument"), b, ctx);
                // no normal successor; the exception edge (set at block creation) carries the flow
                return this.newBlock(ctx); // unreachable

            case "TryStatement":
                return this.tryStatement(path as NodePath<typeof node>, b, ctx);

            case "WithStatement": {
                const p = path as NodePath<typeof node>;
                // control flow of 'with' is ordinary; only binding resolution is unreliable,
                // in this function and in all functions nested in the 'with' body
                this.fcfg.hasWith = true;
                const cfgOf = this.cfgOf;
                p.traverse({
                    "Function|Class"(q) {
                        const c = cfgOf.get(q.node);
                        if (c)
                            c.hasWith = true;
                    },
                });
                b = this.expr(p.get("object"), b, ctx);
                return this.stmt(p.get("body"), b, ctx);
            }

            case "ImportDeclaration": // bindings are initialized at module entry, see hoistImports
            case "ExportAllDeclaration":
                return b;

            case "ExportNamedDeclaration": {
                const p = path as NodePath<typeof node>;
                const d = p.get("declaration");
                if (hasNode(d)) {
                    // declaration-form export: the declared bindings are live exports
                    for (const name of Object.keys(getBindingIdentifiers(d.node))) {
                        const binding = p.scope.getBinding(name);
                        if (binding)
                            this.pcfg.exportedLiveBindings.add(binding);
                    }
                    return this.stmt(d, b, ctx);
                }
                if (!p.node.source) // (re-exports have no local bindings)
                    for (const spec of p.node.specifiers)
                        if (spec.type === "ExportSpecifier") {
                            const binding = p.scope.getBinding(spec.local.name);
                            if (binding)
                                this.pcfg.exportedLiveBindings.add(binding);
                        }
                return b; // export specifiers produce no events
            }

            case "ExportDefaultDeclaration": {
                const d = (path as NodePath<typeof node>).get("declaration");
                if ((d.isFunctionDeclaration() || d.isClassDeclaration()) && d.node.id) {
                    // the default export of a named declaration is a live binding
                    const binding = d.scope.getBinding(d.node.id.name);
                    if (binding)
                        this.pcfg.exportedLiveBindings.add(binding);
                }
                if (d.isFunctionDeclaration())
                    return b; // hoisted, see hoistFunctionDeclarations
                if (d.isClassDeclaration())
                    return this.classDefinition(d, b, ctx);
                if (d.isExpression())
                    return this.expr(d, b, ctx);
                return b; // TSDeclareFunction etc.
            }

            // type-only TypeScript statements that may remain after desugaring
            case "TSTypeAliasDeclaration":
            case "TSInterfaceDeclaration":
            case "TSDeclareFunction":
            case "TSNamespaceExportDeclaration": // 'export as namespace' (declaration files)
            case "TSImportEqualsDeclaration": // replaced by desugaring when it has runtime semantics
                return b;

            case "TSExportAssignment": // replaced by desugaring; kept for robustness
                return this.expr((path as NodePath<typeof node>).get("expression"), b, ctx);

            default:
                throw new CFGBuildError(`Unexpected statement type ${node.type} at ${locationToString(node.loc, true, true)}`);
        }
    }

    private variableDeclaration(path: NodePath<VariableDeclaration>, b: BasicBlock, ctx: Ctx): BasicBlock {
        if (path.node.declare)
            return b;
        for (const d of path.get("declarations")) {
            const init = d.get("init");
            if (hasNode(init)) {
                b = this.expr(init, b, ctx);
                b = this.pattern(d.get("id"), b, ctx);
            } else if (path.node.kind !== "var")
                // let/const without initializer: the binding is initialized (to undefined) here;
                // var bindings are initialized at function entry and produce no event
                b = this.pattern(d.get("id"), b, ctx);
        }
        return b;
    }

    private loopCtx(ctx: Ctx, labels: Array<string>, brk: Thunk, cnt: Thunk): Ctx {
        return {...ctx, jump: (kind, label) =>
            (label === undefined || labels.includes(label)) ? (kind === "break" ? brk : cnt) : ctx.jump(kind, label)};
    }

    /**
     * Builds a try statement.
     * A finally block is duplicated per exit path of the protected code: every continuation
     * (normal fallthrough, exception, return, each break/continue target) is wrapped in a
     * lazily built copy of the finalizer that continues to the original target. This makes
     * event orders exact and lets a finalizer that itself completes abruptly override the
     * pending completion naturally.
     */
    private tryStatement(path: NodePath<Node & {type: "TryStatement"}>, b: BasicBlock, ctx: Ctx): BasicBlock {
        const finalizer = path.get("finalizer");
        const handler = path.get("handler");
        const after = this.newBlock(ctx);

        // continuation transformer for the finalizer (identity if there is none);
        // memoized so each distinct continuation gets exactly one finalizer copy
        let wrap: (k: Thunk) => Thunk;
        if (hasNode(finalizer)) {
            const memo = new Map<Thunk, Thunk>();
            wrap = (k: Thunk) => getOrSet(memo, k, () => lazy(() => {
                // the finalizer copy runs outside the try: exceptions in it go to the outer handler
                const entry = this.newBlock(ctx);
                this.link(this.stmt(finalizer, entry, ctx), k());
                return entry;
            }));
        } else
            wrap = k => k;

        const afterT = wrap(() => after);

        // context for code protected by the finalizer but not by the catch handler (i.e., the handler itself)
        const protCtx: Ctx = {
            exc: wrap(ctx.exc),
            ret: wrap(ctx.ret),
            jump: (kind, label) => {
                const t = ctx.jump(kind, label);
                return t && wrap(t);
            },
        };

        // exception continuation for the protected block
        const excT: Thunk = hasNode(handler)
            ? lazy(() => {
                const entry = this.newBlock(protCtx);
                let cb = entry;
                const param = handler.get("param");
                if (hasNode(param))
                    cb = this.pattern(param, cb, protCtx);
                this.link(this.stmt(handler.get("body"), cb, protCtx), afterT());
                return entry;
            })
            : protCtx.exc;

        const tryCtx: Ctx = {...protCtx, exc: excT};
        const tb = this.newBlock(tryCtx);
        this.link(b, tb);
        this.link(this.stmt(path.get("block"), tb, tryCtx), afterT());
        return after;
    }

    /*
     * Patterns (binding and assignment targets)
     */

    /**
     * Visits a binding or assignment target, emitting write events for the bound identifiers
     * (and read events for computed keys, default value expressions, and member target objects).
     */
    private pattern(path: NodePath, b: BasicBlock, ctx: Ctx): BasicBlock {
        path = skipParenthesizedChildren(path);
        const node = path.node;
        switch (node.type) {

            case "Identifier":
                this.emit(b, path as NodePath<Identifier>, "write");
                return b;

            case "AssignmentPattern": {
                // the default value expression is evaluated only if the incoming value is undefined
                const p = path as NodePath<typeof node>;
                const [dflt, skip] = this.fork(b, ctx);
                const dOut = this.expr(p.get("right"), dflt, ctx);
                return this.pattern(p.get("left"), this.join(ctx, dOut, skip), ctx);
            }

            case "ObjectPattern": {
                const p = path as NodePath<typeof node>;
                for (const prop of p.get("properties")) {
                    if (prop.isObjectProperty()) {
                        if (prop.node.computed)
                            b = this.expr(prop.get("key") as NodePath<Expression>, b, ctx);
                        b = this.pattern(prop.get("value"), b, ctx);
                    } else {
                        assert(prop.isRestElement());
                        b = this.pattern(prop.get("argument"), b, ctx);
                    }
                }
                return b;
            }

            case "ArrayPattern": {
                const p = path as NodePath<typeof node>;
                for (const el of p.get("elements"))
                    if (hasNode(el))
                        b = this.pattern(el, b, ctx);
                return b;
            }

            case "RestElement":
                return this.pattern((path as NodePath<typeof node>).get("argument"), b, ctx);

            case "MemberExpression": // assignment target like [o.p] = ...
                return this.memberTarget(path as NodePath<typeof node>, b, ctx);

            case "TSParameterProperty":
                return this.pattern((path as NodePath<typeof node>).get("parameter"), b, ctx);

            case "TSAsExpression":
            case "TSSatisfiesExpression":
            case "TSNonNullExpression":
            case "TSTypeAssertion":
                return this.pattern((path as NodePath<Node & {expression: Expression}>).get("expression") as NodePath, b, ctx);

            default:
                throw new CFGBuildError(`Unexpected pattern type ${node.type} at ${locationToString(node.loc, true, true)}`);
        }
    }

    /**
     * Visits the identifier accesses of a member expression (reads the object and computed key)
     * — used both as assignment target and as rvalue, since the property load/store itself is
     * not an identifier access.
     */
    private memberTarget(path: NodePath<Node & {type: "MemberExpression"}>, b: BasicBlock, ctx: Ctx): BasicBlock {
        const obj = path.get("object") as NodePath;
        if (!obj.isSuper())
            b = this.expr(obj as NodePath<Expression>, b, ctx);
        if (path.node.computed)
            b = this.expr(path.get("property") as NodePath<Expression>, b, ctx);
        return b;
    }

    /**
     * Visits the arguments of a call or new expression, in order.
     */
    private args(args: Array<NodePath>, b: BasicBlock, ctx: Ctx): BasicBlock {
        for (const a of args) {
            if (a.isSpreadElement())
                b = this.expr(a.get("argument"), b, ctx);
            else if (a.isExpression())
                b = this.expr(a, b, ctx);
        }
        return b;
    }

    /*
     * Expressions
     */

    /**
     * Visits an expression as rvalue, emitting its identifier access events in evaluation order.
     */
    private expr(path: NodePath<Expression>, b: BasicBlock, ctx: Ctx): BasicBlock {
        const node = path.node;
        switch (node.type) {

            case "Identifier":
                // note: this includes 'typeof x' and (sloppy-mode) 'delete x', where we define
                // evaluation of the identifier reference to count as a read
                this.emit(b, path as NodePath<Identifier>, "read");
                return b;

            // no identifier accesses
            case "ThisExpression":
            case "Super":
            case "Import":
            case "MetaProperty":
            case "StringLiteral":
            case "NumericLiteral":
            case "BooleanLiteral":
            case "NullLiteral":
            case "RegExpLiteral":
            case "BigIntLiteral":
            case "DecimalLiteral":
            case "FunctionExpression": // nested functions have their own CFGs
            case "ArrowFunctionExpression":
                return b;

            case "ParenthesizedExpression":
                return this.expr((path as NodePath<typeof node>).get("expression"), b, ctx);

            case "SequenceExpression": {
                for (const e of (path as NodePath<typeof node>).get("expressions"))
                    b = this.expr(e, b, ctx);
                return b;
            }

            case "TemplateLiteral": {
                for (const e of (path as NodePath<TemplateLiteral>).get("expressions"))
                    if (e.isExpression())
                        b = this.expr(e, b, ctx);
                return b;
            }

            case "TaggedTemplateExpression": {
                const p = path as NodePath<typeof node>;
                b = this.expr(p.get("tag"), b, ctx);
                return this.expr(p.get("quasi"), b, ctx);
            }

            case "ArrayExpression": {
                for (const el of (path as NodePath<typeof node>).get("elements")) {
                    if (!hasNode(el))
                        continue;
                    b = el.isSpreadElement() ? this.expr(el.get("argument"), b, ctx) : this.expr(el as NodePath<Expression>, b, ctx);
                }
                return b;
            }

            case "ObjectExpression": {
                for (const prop of (path as NodePath<ObjectExpression>).get("properties")) {
                    if (prop.isObjectProperty()) {
                        if (prop.node.computed)
                            b = this.expr(prop.get("key") as NodePath<Expression>, b, ctx);
                        b = this.expr(prop.get("value") as NodePath<Expression>, b, ctx);
                    } else if (prop.isObjectMethod()) {
                        if (prop.node.computed)
                            b = this.expr(prop.get("key") as NodePath<Expression>, b, ctx);
                    } else {
                        assert(prop.isSpreadElement());
                        b = this.expr(prop.get("argument"), b, ctx);
                    }
                }
                return b;
            }

            case "ClassExpression":
                return this.classDefinition(path as NodePath<typeof node>, b, ctx);

            case "UnaryExpression":
                return this.expr((path as NodePath<typeof node>).get("argument"), b, ctx);

            case "UpdateExpression": {
                const arg = skipParenthesizedChildren((path as NodePath<typeof node>).get("argument"));
                if (arg.isIdentifier()) {
                    this.emit(b, arg, "read");
                    this.emit(b, arg, "write");
                    return b;
                }
                assert(arg.isMemberExpression());
                return this.memberTarget(arg, b, ctx);
            }

            case "BinaryExpression": {
                const p = path as NodePath<typeof node>;
                const left = p.get("left");
                if (left.isExpression()) // 'left' may be a PrivateName (private-in)
                    b = this.expr(left, b, ctx);
                return this.expr(p.get("right"), b, ctx);
            }

            case "LogicalExpression": {
                // &&, ||, ??: the right operand is evaluated only on one branch
                const p = path as NodePath<typeof node>;
                let evalRight: BasicBlock, skip: BasicBlock;
                if (p.node.operator === "??") {
                    // the right operand is evaluated when the left is nullish
                    b = this.expr(p.get("left"), b, ctx);
                    [evalRight, skip] = this.fork(b, ctx);
                    if (this.refinements) {
                        const r = nullishForkRefinements(p.get("left"));
                        this.emitRefinements(r.whenNullish, evalRight);
                        this.emitRefinements(r.whenNotNullish, skip);
                    }
                } else {
                    // '&&' evaluates the right operand when the left is truthy, '||' when falsy
                    const [t, f] = this.forkCond(p.get("left"), b, ctx);
                    [evalRight, skip] = p.node.operator === "&&" ? [t, f] : [f, t];
                }
                return this.join(ctx, this.expr(p.get("right"), evalRight, ctx), skip);
            }

            case "ConditionalExpression": {
                const p = path as NodePath<typeof node>;
                const [t, f] = this.forkCond(p.get("test"), b, ctx);
                return this.join(ctx, this.expr(p.get("consequent"), t, ctx), this.expr(p.get("alternate"), f, ctx));
            }

            case "AssignmentExpression":
                return this.assignment(path as NodePath<typeof node>, b, ctx);

            case "CallExpression":
            case "NewExpression": {
                const p = path as NodePath<CallExpression | NewExpression>;
                const callee = p.get("callee");
                // '(eval)(x)' is also direct eval (the parser preserves parentheses)
                if (skipParenthesizedChildren(callee as NodePath).isIdentifier({name: "eval"}) && !p.scope.getBinding("eval"))
                    this.markDirectEval(p); // direct eval: can access all bindings in scope without events
                if (callee.isExpression())
                    b = this.expr(callee, b, ctx);
                b = this.args(p.get("arguments"), b, ctx);
                if (callee.isSuper())
                    // instance field initializers run during super()
                    for (const fp of this.fields)
                        b = this.expr(fp.get("value") as NodePath<Expression>, b, ctx);
                return b;
            }

            case "MemberExpression":
                return this.memberTarget(path as NodePath<typeof node>, b, ctx);

            case "OptionalMemberExpression":
            case "OptionalCallExpression": {
                // optional chaining: at each '?.', the rest of the chain may be skipped
                const p = path as NodePath<OptionalMemberExpression | OptionalCallExpression>;
                const join = this.newBlock(ctx);
                this.link(this.chainStep(p, b, ctx, join), join);
                return join;
            }

            case "YieldExpression": {
                const p = path as NodePath<YieldExpression>;
                const a = p.get("argument");
                if (hasNode(a))
                    b = this.expr(a, b, ctx);
                // At a yield, the generator may never be resumed: generator.return() runs the
                // enclosing finalizers and completes the function, hence the edge to ctx.ret().
                // generator.throw() raises an exception here, covered by succException.
                const [resume, terminated] = this.fork(b, ctx);
                this.link(terminated, ctx.ret());
                return resume;
            }

            case "AwaitExpression":
                // a rejection is an exception at this point, covered by succException
                return this.expr((path as NodePath<typeof node>).get("argument"), b, ctx);

            case "JSXElement":
            case "JSXFragment":
                return this.jsx(path as NodePath<JSXElement | JSXFragment>, b, ctx);

            // TypeScript wrappers that may remain after desugaring
            case "TSNonNullExpression":
            case "TSAsExpression":
            case "TSSatisfiesExpression":
            case "TSTypeAssertion":
            case "TSInstantiationExpression":
                return this.expr((path as NodePath<Node & {type: typeof node.type, expression: Expression}>).get("expression") as NodePath<Expression>, b, ctx);

            default:
                throw new CFGBuildError(`Unexpected expression type ${node.type} at ${locationToString(node.loc, true, true)}`);
        }
    }

    private assignment(path: NodePath<Node & {type: "AssignmentExpression"}>, b: BasicBlock, ctx: Ctx): BasicBlock {
        const op = path.node.operator;
        const left = skipParenthesizedChildren(path.get("left") as NodePath);
        const right = path.get("right") as NodePath<Expression>;
        if (!left.isIdentifier() && !left.isMemberExpression()) {
            // destructuring (simple '=' only): the value is computed first,
            // then the targets are assigned in order
            assert(op === "=", "compound assignment to a pattern");
            b = this.expr(right, b, ctx);
            return this.pattern(left, b, ctx);
        }
        // for a member-expression target, the object and computed key are evaluated before the
        // right operand, regardless of the operator (the property store is not an identifier access)
        if (left.isMemberExpression())
            b = this.memberTarget(left, b, ctx);
        if (op === "&&=" || op === "||=" || op === "??=") {
            // logical assignment: the right operand and the write happen only on one branch
            if (left.isIdentifier())
                this.emit(b, left, "read");
            const [doIt, skip] = this.fork(b, ctx);
            const out = this.expr(right, doIt, ctx);
            if (left.isIdentifier())
                this.emit(out, left, "write");
            return this.join(ctx, out, skip);
        }
        if (op !== "=" && left.isIdentifier())
            this.emit(b, left, "read"); // compound assignment reads before evaluating the right operand
        b = this.expr(right, b, ctx);
        if (left.isIdentifier())
            this.emit(b, left, "write"); // the value is computed before the write
        return b;
    }

    /**
     * Visits one link of an optional chain. At each optional link, control may branch to
     * shortCircuit, skipping the events of the rest of the chain.
     */
    private chainStep(path: NodePath<OptionalMemberExpression | OptionalCallExpression>, b: BasicBlock, ctx: Ctx, shortCircuit: BasicBlock): BasicBlock {
        const isMember = path.isOptionalMemberExpression();
        const base = isMember ? (path as NodePath<OptionalMemberExpression>).get("object") : (path as NodePath<OptionalCallExpression>).get("callee");
        let cur = (base.isOptionalMemberExpression() || base.isOptionalCallExpression())
            ? this.chainStep(base, b, ctx, shortCircuit)
            : this.expr(base as NodePath<Expression>, b, ctx);
        if (path.node.optional) {
            const [cont, skip] = this.fork(cur, ctx);
            this.link(skip, shortCircuit);
            cur = cont;
        }
        if (isMember) {
            if ((path.node as OptionalMemberExpression).computed)
                cur = this.expr((path as NodePath<OptionalMemberExpression>).get("property") as NodePath<Expression>, cur, ctx);
        } else
            // note: no direct-eval check here — 'eval?.()' is indirect eval and cannot access the local scope
            cur = this.args((path as NodePath<OptionalCallExpression>).get("arguments"), cur, ctx);
        return cur;
    }

    /**
     * Visits the definition-time computation of a class: decorators, the superclass expression,
     * computed keys (in element order), then static field initializers and static blocks
     * (in element order), and finally the initialization of the class name binding.
     * These events belong to the CFG of the function containing the class definition.
     * (Instance field initializers are instead part of the class's constructor CFG.)
     */
    private classDefinition(path: NodePath<Class>, b: BasicBlock, ctx: Ctx): BasicBlock {
        for (const d of getDecoratorExpressions(path))
            b = this.expr(d, b, ctx);
        const sc = path.get("superClass");
        if (hasNode(sc))
            b = this.expr(sc, b, ctx);
        const elements = path.get("body").get("body");
        for (const el of elements) {
            for (const d of getDecoratorExpressions(el))
                b = this.expr(d, b, ctx);
            if ((el.isClassMethod() || el.isClassProperty() || el.isClassAccessorProperty()) && el.node.computed)
                b = this.expr(el.get("key") as NodePath<Expression>, b, ctx);
        }
        // after the class object is created: static initializers and static blocks, in order
        for (const el of elements) {
            if (el.isStaticBlock()) {
                const stmts = el.get("body");
                b = this.hoistFunctionDeclarations(stmts, b);
                b = this.stmtSeq(stmts, b, ctx);
            } else if ((el.isClassProperty() || el.isClassPrivateProperty() || el.isClassAccessorProperty()) && el.node.static) {
                const v = el.get("value") as NodePath<Expression | null | undefined>;
                if (hasNode(v))
                    b = this.expr(v, b, ctx);
            }
        }
        // the class name binding is initialized when the definition completes
        const id = path.get("id");
        if (hasNode(id))
            this.emit(b, id, "write");
        return b;
    }

    private jsx(path: NodePath<JSXElement | JSXFragment>, b: BasicBlock, ctx: Ctx): BasicBlock {
        if (path.isJSXElement()) {
            // a capitalized element name is a variable reference (lowercase names are intrinsic)
            let name = path.get("openingElement").get("name");
            while (name.isJSXMemberExpression())
                name = name.get("object");
            if (name.isJSXIdentifier() && !/^[a-z]/.test(name.node.name))
                this.emit(b, name, "read");
            for (const attr of path.get("openingElement").get("attributes")) {
                if (attr.isJSXAttribute()) {
                    const v = attr.get("value");
                    if (hasNode(v)) {
                        if (v.isJSXExpressionContainer()) {
                            const e = v.get("expression");
                            if (e.isExpression())
                                b = this.expr(e, b, ctx);
                        } else if (v.isJSXElement() || v.isJSXFragment())
                            b = this.jsx(v, b, ctx);
                    }
                } else {
                    assert(attr.isJSXSpreadAttribute());
                    b = this.expr(attr.get("argument"), b, ctx);
                }
            }
        }
        for (const c of path.get("children") as Array<NodePath>) {
            if (c.isJSXExpressionContainer()) {
                const e = c.get("expression");
                if (e.isExpression())
                    b = this.expr(e, b, ctx);
            } else if (c.isJSXSpreadChild())
                b = this.expr(c.get("expression"), b, ctx);
            else if (c.isJSXElement() || c.isJSXFragment())
                b = this.jsx(c, b, ctx);
        }
        return b;
    }

    /**
     * Marks the function owning an 'arguments' reference: the nearest non-arrow enclosing
     * function (arrows share the enclosing function's arguments object), or the program
     * (whose CommonJS wrapper also has an arguments object).
     * Uses the same attribution as the constraint producer (getEnclosingNonArrowFunction),
     * so the two cannot disagree; in particular, positions in computed method keys belong
     * to the enclosing function, not the method.
     */
    private markUsesArguments(path: NodePath): void {
        const f = getEnclosingNonArrowFunction(path);
        const c = this.cfgOf.get(f ?? this.programNode);
        if (c)
            c.usesArguments = true;
    }

    /**
     * Marks all functions lexically enclosing a direct 'eval' call: the evaluated code can read
     * and write any binding in scope at the call.
     */
    private markDirectEval(path: NodePath): void {
        for (let p: NodePath | null = path; p; p = p.parentPath) {
            const c = this.cfgOf.get(p.node);
            if (c)
                c.hasDirectEval = true;
        }
    }

    /*
     * Events, blocks, and edges
     */

    /**
     * Appends refinement pseudo-definitions to the given block (condition-based narrowing).
     * Unlike ordinary events, refinement events are not registered in the occurrences index
     * (they are not accesses in the program).
     */
    private emitRefinements(refs: Array<Refinement>, b: BasicBlock): void {
        if (!this.refinements)
            return;
        for (const r of refs)
            b.events.push(new RefinementEvent(r.id.node, r.id.scope.getBinding(r.id.node.name),
                {test: r.test, negated: r.negated}));
    }

    /**
     * Appends an identifier access event to the given block and registers it in the occurrences
     * index and (via its binding's home function) in FunctionCFG.declares.
     */
    private emit(b: BasicBlock, idPath: NodePath<Identifier | JSXIdentifier>, kind: AccessKind): void {
        const node = idPath.node;
        const binding = idPath.scope.getBinding(node.name);
        if (!binding && node.name === "arguments")
            this.markUsesArguments(idPath);
        const ev = new CfgEvent(node, kind, binding);
        b.events.push(ev);
        if (this.refinements && kind === "write" && binding)
            this.writeLog.push(binding);
        mapGetArray(this.pcfg.occurrences, node).push(ev);
        if (binding)
            this.homeCfg(binding)?.declares.add(binding);
    }

    /**
     * Finds the FunctionCFG of the function that lexically declares the given binding
     * (static block code is inlined in the enclosing function's CFG, and constructor
     * bindings belong to the class's CFG).
     */
    private homeCfg(binding: Binding): FunctionCFG | undefined {
        if (this.homes.has(binding))
            return this.homes.get(binding);
        let h: FunctionCFG | undefined;
        let p: NodePath | null = binding.scope.path;
        while (p) {
            if (p.isStaticBlock()) {
                // static block code is inlined in the CFG of the function containing the class definition
                const cls: NodePath | null = p.findParent(q => q.isClass());
                p = cls ? cls.parentPath : null;
                continue;
            }
            const c = this.cfgOf.get(p.node);
            if (c) {
                h = c;
                break;
            }
            p = p.parentPath;
        }
        this.homes.set(binding, h);
        return h;
    }

    /**
     * Creates a new basic block with the exception edge of the current context.
     */
    private newBlock(ctx: Ctx): BasicBlock {
        return new BasicBlock(ctx.exc());
    }

    /**
     * Creates a new block and links from the given block to it.
     */
    private linkNew(from: BasicBlock, ctx: Ctx): BasicBlock {
        const b = this.newBlock(ctx);
        this.link(from, b);
        return b;
    }

    /**
     * Creates a new block that joins the given blocks (each is linked to it).
     */
    private join(ctx: Ctx, ...blocks: Array<BasicBlock>): BasicBlock {
        const j = this.newBlock(ctx);
        for (const b of blocks)
            this.link(b, j);
        return j;
    }

    /**
     * Sets the normal successor of a block (which must not have one yet).
     */
    private link(from: BasicBlock, to: BasicBlock): void {
        assert(!from.succNormal, "block already has a normal successor");
        from.succNormal = to;
    }

    /**
     * Builds a branch condition and ends the resulting block with a two-way fork, emitting
     * the condition's refinements (condition-based narrowing) into the successor blocks:
     * those that hold when the condition is truthy into the first, those that hold when it
     * is falsy into the second. A refinement whose binding is written anywhere inside the
     * condition expression is omitted (deliberately blunt but always sound — refinements
     * only filter): it was derived from a read that may be stale by the time the branch is
     * taken, as in 'typeof x !== "function" && ((x = f), true)'.
     */
    private forkCond(test: NodePath<Expression>, b: BasicBlock, ctx: Ctx): [BasicBlock, BasicBlock] {
        const mark = this.writeLog.length;
        b = this.expr(test, b, ctx);
        const [t, f] = this.fork(b, ctx);
        if (this.refinements) {
            const r = conditionRefinements(test);
            const written = new Set(this.writeLog.slice(mark));
            const fresh = (refs: Array<Refinement>) => refs.filter(q => {
                const binding = q.id.scope.getBinding(q.id.node.name);
                return !binding || !written.has(binding);
            });
            this.emitRefinements(fresh(r.whenTrue), t);
            this.emitRefinements(fresh(r.whenFalse), f);
        }
        return [t, f];
    }

    /**
     * Ends the given block with a two-way fork, returning the two fresh successor blocks
     * ([truthy, falsy]; for nondeterministic forks the order is arbitrary).
     */
    private fork(b: BasicBlock, ctx: Ctx): [BasicBlock, BasicBlock] {
        assert(!b.succNormal && !b.succFalse, "block already has successors");
        const t = this.newBlock(ctx), f = this.newBlock(ctx);
        b.succNormal = t;
        b.succFalse = f;
        return [t, f];
    }

    /**
     * Cosmetic cleanup: redirects edges past empty pass-through blocks.
     * Sound: an empty block represents no executable code, so no exception can originate in it,
     * and its removal does not change the admitted event traces.
     */
    private removeEmptyBlocks(f: FunctionCFG): void {
        const redirect = (b0: BasicBlock | undefined): BasicBlock | undefined => {
            let b = b0;
            const seen = new Set<BasicBlock>();
            while (b && b.events.length === 0 && b.succNormal && !b.succFalse && !seen.has(b)) {
                seen.add(b);
                b = b.succNormal;
            }
            return b;
        };
        f.entry = redirect(f.entry)!;
        const visited = new Set<BasicBlock>([f.entry, f.exit, f.exitException]);
        const work = [f.entry];
        while (work.length > 0) {
            const b = work.pop()!;
            b.succNormal = redirect(b.succNormal);
            b.succFalse = redirect(b.succFalse);
            b.succException = redirect(b.succException);
            for (const s of [b.succNormal, b.succFalse, b.succException])
                if (s && !visited.has(s)) {
                    visited.add(s);
                    work.push(s);
                }
        }
    }
}
