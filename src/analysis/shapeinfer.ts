/** Forward ordered own-property inference over completed Jelly solutions. */
import traverse from "@babel/traverse";
import * as t from "@babel/types";
import {relative, resolve} from "path";
import {ConstraintVar, ObjectPropertyVar, ThisVar} from "./constraintvars";
import {FragmentState} from "./fragmentstate";
import {FunctionInfo, ModuleInfo} from "./infos";
import {ObjectToken, PrototypeToken, FunctionToken, NativeObjectToken, Token} from "./tokens";
import {TypeLabel, TypeLabels} from "./typelabels";
import {getKey, getProperty} from "../misc/asthelpers";
import {Location} from "../misc/util";
import {options} from "../options";
import logger from "../misc/logger";

export type ShapeProperty = {
    name: string, types: Array<TypeLabel>, closures: Array<string>, implicitConstructor: boolean,
    kind: "data" | "accessor", writable: boolean, enumerable: boolean, configurable: boolean,
};
export type Shape = {
    name: string, kind: "instance" | "prototype" | "object", location: string,
    properties: Array<ShapeProperty>,
};
export type ShapeBinding = {location: string, shape: string, phase: "after-expression" | "after-write"};
export type ShapeGuard = {location: string, shape: string, prototypeShape?: string};
export type ShapeReason = "uninitialized" | "path-dependent-write" | "loop" | "dynamic-key" |
    "multiple-instances" | "ambiguous-receiver" | "different-shapes" | "unknown-call" |
    "recursive-call" | "accessor" | "prototype-change" | "unsupported" | "budget";
export type ShapePoint = {
    location: string, token: string, phase: "after-expression" | "after-write",
    shape?: string, reason?: ShapeReason,
};
export class ShapeInfos {
    readonly shapes: Array<Shape> = [];
    readonly bindings: Array<ShapeBinding> = [];
    readonly guards: Array<ShapeGuard> = [];
    readonly states: Array<ShapePoint> = [];
    readonly diagnostics = {steps: 0, calls: 0, known: 0, unknown: 0, truncated: false};
}
type Descriptor = {name: string, accessor: boolean, implicitConstructor: boolean, enumerable: boolean};
type Fact = {props: ReadonlyArray<Descriptor>} | {reason: ShapeReason};
type Cell = {fact: Fact, summary: boolean};
type Heap = Map<Token, Cell>;
type Exit = {heap: Heap, kind: "normal" | "return" | "throw" | "break" | "continue"};
type Context = {conditional: boolean, loop: boolean, stack: ReadonlyArray<t.Function>, opaque?: ShapeReason};
type Observation = {node: t.Node, token: Token, phase: ShapePoint["phase"], fact: Fact, binding: boolean};
const unknown = (reason: ShapeReason): Fact => ({reason});
const known = (fact: Fact): fact is {props: ReadonlyArray<Descriptor>} => "props" in fact;
const ordinary = (name: string): Descriptor => ({name, accessor: false, implicitConstructor: false, enumerable: true});
// Local heap marker; never registered in Jelly. Unknown effects may also install
// inherited setters that affect objects allocated after the call.
const ambientEffects = new class extends Token {toString() {return "<unknown-effects>";}};

function equal(a: Fact, b: Fact): boolean {
    return known(a) && known(b) ? a.props.length === b.props.length && a.props.every((p, i) =>
        p.name === b.props[i].name && p.accessor === b.props[i].accessor &&
        p.implicitConstructor === b.props[i].implicitConstructor && p.enumerable === b.props[i].enumerable) :
        !known(a) && !known(b) && a.reason === b.reason;
}
function join(a: Fact, b: Fact): Fact {
    if (equal(a, b)) return a;
    if (!known(a)) return a;
    if (!known(b)) return b;
    return unknown("different-shapes");
}

/** Structured CFG traversal with matched calls/returns; no solver mutation. */
export function inferShapes(f: FragmentState, labels: TypeLabels, maxSteps = 100000, queries?: ReadonlyArray<string>): ShapeInfos {
    return new ForwardShapes(f, labels, maxSteps, queries).run();
}

class ForwardShapes {
    private readonly result = new ShapeInfos;
    private readonly vars = new Map<t.Node, ConstraintVar>();
    private readonly candidateNodes = new Set<t.Node>();
    private readonly tokenCache = new Map<t.Node, Array<Token>>();
    private readonly funs = new Map<FunctionInfo, t.Function>();
    private readonly objects = new Map<t.Node, ObjectToken>();
    private readonly prototypes = new Map<t.Function, PrototypeToken>();
    private readonly observations = new Map<string, Observation>();
    private readonly activeModules = new Set<ModuleInfo>();
    private readonly loadedModules = new Set<ModuleInfo>();
    private readonly roots = new Map<ModuleInfo, t.Program>();
    private readonly classFields = new Map<t.Function, Array<t.ClassProperty | t.ClassPrivateProperty>>();
    private readonly unsupportedConstructors = new Set<t.Function>();
    private readonly propertyVars = new Map<Token, Map<string, ConstraintVar>>();
    private readonly queryNodes?: Set<t.Node>;
    private readonly queryTokens?: Set<Token>;

    constructor(private readonly f: FragmentState, private readonly labels: TypeLabels, private readonly maxSteps: number, queries?: ReadonlyArray<string>) {
        for (const {node, v} of f.a.expLocationIndex.values()) if (v) this.vars.set(node, v);
        for (const [fun, info] of f.a.functionInfos) this.funs.set(info, fun);
        for (const token of f.a.tokens) {
            if (token instanceof ObjectToken) this.objects.set(token.allocSite as t.Node, token);
            if (token instanceof PrototypeToken) this.prototypes.set(token.allocSite as t.Function, token);
        }
        const thisVars = new Map<t.Function, ConstraintVar>();
        for (const v of f.a.vars) {
            if (v instanceof ThisVar) thisVars.set(v.fun, v);
            if (v instanceof ObjectPropertyVar && v.accessor === "normal") {
                let props = this.propertyVars.get(v.obj);
                if (!props) this.propertyVars.set(v.obj, props = new Map);
                props.set(v.prop, v);
            }
        }
        for (const [module, ast] of f.a.shapePrograms) {
            this.roots.set(module, ast.program);
            // Resolve original use sites without creating constraint variables.
            traverse(ast, {
                enter: path => {
                    if (t.isExpression(path.node) || t.isIdentifier(path.node)) this.candidateNodes.add(path.node);
                    const v = f.a.canonicalNodeVars.get(path.node);
                    if (v && !this.vars.has(path.node)) this.vars.set(path.node, v);
                },
                Identifier: path => {
                    if (!path.isReferencedIdentifier()) return;
                    const declaration = path.scope.getBinding(path.node.name)?.identifier;
                    const v = declaration && f.a.canonicalNodeVars.get(declaration);
                    if (v) this.vars.set(path.node, v);
                },
                ThisExpression: path => {
                    if (this.vars.has(path.node)) return;
                    const fun = path.findParent(p => p.isFunction() && !p.isArrowFunctionExpression())?.node;
                    const v = fun && thisVars.get(fun as t.Function);
                    if (v) this.vars.set(path.node, v);
                },
                Class: path => {
                    const ctor = path.node.body.body.find((n): n is t.ClassMethod => t.isClassMethod(n) && n.kind === "constructor");
                    if (ctor && (path.node.superClass || path.node.body.body.some(n => t.isClassPrivateProperty(n) || t.isClassPrivateMethod(n))))
                        this.unsupportedConstructors.add(ctor);
                    if (ctor) this.classFields.set(ctor, path.node.body.body.filter(
                        (n): n is t.ClassProperty | t.ClassPrivateProperty =>
                            (t.isClassProperty(n) || t.isClassPrivateProperty(n)) && !n.static));
                },
            });
        }
        if (queries) {
            this.queryNodes = new Set;
            this.queryTokens = new Set;
            for (const node of this.candidateNodes) {
                const location = this.loc(node);
                if (location && queries.some(q => location === q || location.startsWith(`${q}:`))) {
                    this.queryNodes.add(node);
                    for (const token of this.tokens(node)) this.queryTokens.add(token);
                }
            }
        }
    }

    private loc(n: t.Node): string | undefined {
        const l = n.loc as Location | null;
        if (!l?.module || !l.start.line || l.nodeIndex !== undefined) return undefined;
        return `${relative(options.basedir, l.module.getPath())}:${l.start.line}:${l.start.column + 1}:${l.end.line}:${l.end.column + 1}`;
    }
    private tokens(n: t.Node | null | undefined): Array<Token> {
        if (!n) return [];
        const cached = this.tokenCache.get(n);
        if (cached) return cached;
        if (t.isParenthesizedExpression(n)) return this.tokens(n.expression);
        const v = this.vars.get(n);
        if (v) {
            const out = [...this.f.getTokens(this.f.getRepresentative(v))];
            this.tokenCache.set(n, out); return out;
        }
        // Jelly need not materialize a result variable for an unused member read.
        // Its own-property solution can still identify tokens at that use site.
        if (t.isMemberExpression(n)) {
            const name = getProperty(n), out = new Set<Token>();
            if (name !== undefined) for (const receiver of this.tokens(n.object)) {
                const property = this.propertyVars.get(receiver)?.get(name);
                if (property) for (const token of this.f.getTokens(this.f.getRepresentative(property))) out.add(token);
            }
            const tokens = [...out]; this.tokenCache.set(n, tokens); return tokens;
        }
        return [];
    }
    private tick(): boolean {
        if (this.result.diagnostics.truncated) return false;
        if (++this.result.diagnostics.steps <= this.maxSteps) return true;
        this.result.diagnostics.truncated = true;
        return false;
    }
    private invalidate(heap: Heap, tokens: Iterable<Token>, reason: ShapeReason) {
        for (const token of tokens) {
            const cell = heap.get(token);
            if (cell && known(cell.fact)) heap.set(token, {...cell, fact: unknown(reason)});
        }
    }
    private invalidateAll(heap: Heap, reason: ShapeReason) {
        this.invalidate(heap, heap.keys(), reason);
        if (!heap.has(ambientEffects)) heap.set(ambientEffects, {fact: unknown(reason), summary: false});
    }
    private merge(heaps: Array<Heap>): Heap {
        const out: Heap = new Map;
        for (const heap of heaps)
            for (const [token, cell] of heap) {
                const prev = out.get(token);
                out.set(token, prev ? {fact: join(prev.fact, cell.fact), summary: prev.summary || cell.summary} : cell);
            }
        return out;
    }
    private allocate(token: Token | undefined, heap: Heap, ctx: Context, props: ReadonlyArray<Descriptor> = []) {
        if (!token || this.queryTokens && !this.queryTokens.has(token)) return;
        const old = heap.get(token);
        heap.set(token, {summary: !!old, fact: old ? unknown("multiple-instances") : ctx.opaque ? unknown(ctx.opaque) : ctx.loop ? unknown("loop") : {props}});
    }
    private observe(node: t.Node, heap: Heap, ctx: Context, phase: ShapePoint["phase"] = "after-expression", binding = false, explicit?: Token) {
        if (this.queryNodes && !this.queryNodes.has(node)) return;
        const loc = this.loc(node);
        if (!loc) return;
        for (const token of explicit ? [explicit] : this.tokens(node)) {
            if (!(token instanceof ObjectToken || token instanceof PrototypeToken)) continue;
            const fact = ctx.opaque ? unknown(ctx.opaque) : ctx.loop ? unknown("loop") : heap.get(token)?.fact ?? unknown("uninitialized");
            const key = `${loc}|${token.index}|${phase}`, prev = this.observations.get(key);
            this.observations.set(key, {node, token, phase, fact: prev ? join(prev.fact, fact) : fact, binding: binding || !!prev?.binding});
        }
    }
    private write(targets: Array<Token>, name: string | undefined, heap: Heap, ctx: Context, accessor = false, enumerable = true, definition = false) {
        if (!definition && (name === "__proto__" || name === "prototype" &&
            targets.some(t => t instanceof FunctionToken || t instanceof NativeObjectToken && t.constr))) {
            // Prototype replacement also matters when the receiver is a function
            // or native object, whose own structural shape is not tracked here.
            this.invalidateAll(heap, "prototype-change");
            return;
        }
        for (const token of targets) {
            const cell = heap.get(token);
            if (!cell) continue;
            let next: Fact;
            if (!known(cell.fact)) continue;
            if (ctx.opaque) next = unknown(ctx.opaque);
            else if (name === undefined) next = unknown("dynamic-key");
            else if (name === "__proto__") next = unknown("prototype-change");
            else {
                const old = cell.fact.props.find(p => p.name === name);
                if (old?.accessor || accessor) next = unknown("accessor");
                else if (old) continue;
                else if (!definition && heap.has(ambientEffects)) next = heap.get(ambientEffects)!.fact;
                else if (ctx.loop) next = unknown("loop");
                else if (ctx.conditional) next = unknown("path-dependent-write");
                else if (targets.length !== 1) next = unknown("ambiguous-receiver");
                else if (cell.summary) next = unknown("multiple-instances");
                else next = {props: [...cell.fact.props, {...ordinary(name), enumerable}]};
            }
            heap.set(token, {...cell, fact: next});
        }
    }
    private sequence(nodes: ReadonlyArray<t.Node>, heap: Heap, ctx: Context): Array<Exit> {
        // Function declarations are instantiated before the block executes.
        for (const n of nodes) {
            const declaration = t.isExportNamedDeclaration(n) || t.isExportDefaultDeclaration(n) ? n.declaration : n;
            if (declaration && t.isFunctionDeclaration(declaration)) this.initPrototype(declaration, heap, ctx);
        }
        let exits: Array<Exit> = [{heap, kind: "normal"}];
        for (const node of nodes) {
            if (this.result.diagnostics.truncated) break;
            const normals = exits.filter(e => e.kind === "normal");
            if (!normals.length) break;
            exits = [...exits.filter(e => e.kind !== "normal"), ...this.statement(node,
                normals.length === 1 ? normals[0].heap : this.merge(normals.map(e => e.heap)), ctx)];
        }
        return exits;
    }
    private statement(n: t.Node, heap: Heap, ctx: Context): Array<Exit> {
        if (!this.tick()) {
            this.invalidateAll(heap, "budget");
            return [{heap, kind: "normal"}];
        }
        if (t.isProgram(n) || t.isBlockStatement(n)) return this.sequence(n.body, heap, ctx);
        if (t.isExpressionStatement(n)) this.expression(n.expression, heap, ctx);
        else if (t.isVariableDeclaration(n)) {
            for (const d of n.declarations) {
                if (d.init) this.expression(d.init, heap, ctx);
                if (!t.isIdentifier(d.id)) this.invalidateAll(heap, "unsupported");
                this.observe(d.id, heap, ctx);
            }
        } else if (t.isFunctionDeclaration(n)) { /* handled at block entry */ }
        else if (t.isReturnStatement(n) || t.isThrowStatement(n)) {
            if (n.argument) this.expression(n.argument, heap, ctx);
            return [{heap, kind: t.isReturnStatement(n) ? "return" : "throw"}];
        } else if (t.isBreakStatement(n) || t.isContinueStatement(n)) return [{heap, kind: t.isBreakStatement(n) ? "break" : "continue"}];
        else if (t.isIfStatement(n)) {
            this.expression(n.test, heap, ctx);
            const branch = {...ctx, conditional: true};
            return [...this.statement(n.consequent, new Map(heap), branch),
                ...(n.alternate ? this.statement(n.alternate, new Map(heap), branch) : [{heap: new Map(heap), kind: "normal" as const}])];
        } else if (t.isForStatement(n) || t.isWhileStatement(n) || t.isDoWhileStatement(n) || t.isForInStatement(n) || t.isForOfStatement(n)) {
            // Shape-changing loop effects become Unknown on the first visit.
            const loop = {...ctx, conditional: true, loop: true};
            if (t.isForStatement(n) && n.init) {
                if (t.isVariableDeclaration(n.init)) this.statement(n.init, heap, ctx);
                else this.expression(n.init, heap, ctx);
            }
            if (t.isForInStatement(n) || t.isForOfStatement(n)) {
                this.expression(n.right, heap, ctx);
                if (t.isForOfStatement(n)) this.invalidateAll(heap, "unknown-call"); // iterator protocols
                if (t.isMemberExpression(n.left)) {
                    this.expression(n.left.object, heap, loop);
                    if (n.left.computed) this.computedKey(n.left.property, heap, loop);
                    this.write(this.tokens(n.left.object), getProperty(n.left), heap, loop);
                } else if (!t.isIdentifier(n.left) && !t.isVariableDeclaration(n.left)) this.invalidateAll(heap, "unsupported");
            }
            const first = new Map(heap);
            if ("test" in n && n.test) this.expression(n.test, first, loop);
            const exits = this.statement(n.body, first, loop);
            for (const e of exits)
                if (e.kind !== "return" && e.kind !== "throw" && t.isForStatement(n) && n.update) this.expression(n.update, e.heap, loop);
            const out = this.merge([heap, ...exits.map(e => e.heap)]);
            return [{heap: out, kind: "normal"}, ...exits.filter(e => e.kind === "return" || e.kind === "throw")];
        } else if (t.isTryStatement(n)) {
            this.invalidateAll(heap, "unsupported");
            const conservative = {...ctx, conditional: true, opaque: "unsupported" as const};
            const branches = this.statement(n.block, new Map(heap), conservative);
            if (n.handler) branches.push(...this.statement(n.handler.body, new Map(heap), conservative));
            if (!n.finalizer) return branches;
            return branches.flatMap(e => this.statement(n.finalizer!, e.heap, conservative).map(end => end.kind === "normal" ? {...end, kind: e.kind} : end));
        } else if (t.isSwitchStatement(n)) {
            this.expression(n.discriminant, heap, ctx);
            this.invalidateAll(heap, "unsupported");
            for (const c of n.cases) {
                if (c.test) this.expression(c.test, heap, {...ctx, conditional: true, opaque: "unsupported"});
                const exits = this.sequence(c.consequent, heap, {...ctx, conditional: true, opaque: "unsupported"});
                for (const e of exits) this.invalidate(e.heap, e.heap.keys(), "unsupported");
            }
        } else if (t.isClassDeclaration(n)) this.classExpression(n, heap, ctx);
        else if (t.isImportDeclaration(n) || t.isExportAllDeclaration(n)) { /* loaded before module body */ }
        else if (t.isExportNamedDeclaration(n) || t.isExportDefaultDeclaration(n)) {
            if (n.declaration) {
                if (t.isExpression(n.declaration)) this.expression(n.declaration, heap, ctx);
                else return this.statement(n.declaration, heap, ctx);
            }
        } else if (!t.isEmptyStatement(n)) this.invalidateAll(heap, "unsupported");
        return [{heap, kind: "normal"}];
    }
    private expression(n: t.Node, heap: Heap, ctx: Context): void {
        if (!this.tick()) {
            this.invalidateAll(heap, "budget"); this.observe(n, heap, ctx); return;
        }
        if (t.isObjectExpression(n)) {
            const token = this.objects.get(n);
            this.allocate(token, heap, ctx);
            for (const p of n.properties) {
                if (t.isSpreadElement(p)) {
                    this.expression(p.argument, heap, ctx);
                    this.invalidateAll(heap, "unsupported"); // spreading may invoke getters
                } else {
                    if (p.computed) this.computedKey(p.key, heap, ctx);
                    if (t.isObjectProperty(p)) this.expression(p.value, heap, ctx);
                    this.write(token ? [token] : [], getKey(p), heap, {...ctx, conditional: false}, t.isObjectMethod(p) && p.kind !== "method", true, true);
                }
            }
            this.observe(n, heap, ctx, "after-expression", true, token); return;
        } else if (t.isAssignmentExpression(n)) {
            const member = t.isMemberExpression(n.left) ? n.left : undefined;
            const conditional = ["&&=", "||=", "??="].includes(n.operator);
            if (member) {
                this.expression(member.object, heap, ctx);
                if (member.computed) this.computedKey(member.property, heap, ctx);
                if (n.operator !== "=") this.read(member, heap);
            }
            const skipped = conditional ? new Map(heap) : undefined;
            this.expression(n.right, heap, conditional ? {...ctx, conditional: true} : ctx);
            if (n.operator !== "=" && !conditional && (this.tokens(n.left).length || this.tokens(n.right).length))
                this.invalidateAll(heap, "unsupported");
            if (member) {
                if (this.f.callToFunctionOrModule.has(member)) this.invalidateAll(heap, "accessor");
                this.write(this.tokens(member.object), getProperty(member), heap,
                    {...ctx, conditional: ctx.conditional || conditional});
                this.observe(member.object, heap, ctx, "after-write", true);
            } else if (!t.isIdentifier(n.left)) this.invalidateAll(heap, "unsupported");
            if (skipped) {
                const merged = this.merge([skipped, heap]); heap.clear();
                for (const [token, cell] of merged) heap.set(token, cell);
            }
        } else if (t.isUpdateExpression(n) || t.isUnaryExpression(n)) {
            this.expression(n.argument, heap, ctx);
            if ((t.isUpdateExpression(n) || ["+", "-", "~"].includes(n.operator)) && this.tokens(n.argument).length)
                this.invalidateAll(heap, "unsupported");
            if (t.isMemberExpression(n.argument)) {
                if (t.isUnaryExpression(n) && n.operator === "delete") this.invalidate(heap, this.tokens(n.argument.object), "unsupported");
                else if (t.isUpdateExpression(n)) {
                    this.write(this.tokens(n.argument.object), getProperty(n.argument), heap, ctx);
                    this.observe(n.argument.object, heap, ctx, "after-write", true);
                }
            }
        } else if (t.isCallExpression(n) || t.isNewExpression(n) || t.isOptionalCallExpression(n)) {
            this.expression(n.callee, heap, ctx);
            const conditional = t.isOptionalCallExpression(n) ? {...ctx, conditional: true} : ctx;
            for (const arg of n.arguments) {
                this.expression(t.isSpreadElement(arg) ? arg.argument : arg, heap, conditional);
                if (t.isSpreadElement(arg)) this.invalidateAll(heap, "unsupported");
            }
            this.call(n, heap, conditional);
            this.observe(n, heap, ctx, "after-expression", t.isNewExpression(n)); return;
        } else if (t.isMemberExpression(n) || t.isOptionalMemberExpression(n)) {
            this.expression(n.object, heap, ctx);
            if (n.computed) this.computedKey(n.property, heap, ctx);
            this.read(n, heap);
            if (t.isOptionalMemberExpression(n)) this.invalidateAll(heap, "unsupported");
        } else if (t.isLogicalExpression(n) || t.isConditionalExpression(n)) {
            this.expression(t.isLogicalExpression(n) ? n.left : n.test, heap, ctx);
            const a = new Map(heap), b = new Map(heap), branch = {...ctx, conditional: true};
            this.expression(t.isLogicalExpression(n) ? n.right : n.consequent, a, branch);
            if (t.isConditionalExpression(n)) this.expression(n.alternate, b, branch);
            const merged = this.merge([a, b]); heap.clear();
            for (const [token, cell] of merged) heap.set(token, cell);
        } else if (t.isSequenceExpression(n)) {
            for (const e of n.expressions) this.expression(e, heap, ctx);
        } else if (t.isBinaryExpression(n)) {
            this.expression(n.left, heap, ctx); this.expression(n.right, heap, ctx);
            if (n.operator !== "===" && n.operator !== "!==" && (this.tokens(n.left).length || this.tokens(n.right).length))
                this.invalidateAll(heap, "unsupported");
        } else if (t.isFunctionExpression(n) || t.isArrowFunctionExpression(n)) this.initPrototype(n, heap, ctx);
        else if (t.isClassExpression(n)) this.classExpression(n, heap, ctx);
        else if (t.isArrayExpression(n)) {
            for (const e of n.elements) if (e) {
                this.expression(t.isSpreadElement(e) ? e.argument : e, heap, ctx);
                if (t.isSpreadElement(e)) this.invalidateAll(heap, "unsupported");
            }
        } else if (t.isParenthesizedExpression(n)) this.expression(n.expression, heap, ctx);
        else if (t.isAwaitExpression(n) || t.isYieldExpression(n)) {
            if (n.argument) this.expression(n.argument, heap, ctx);
            this.invalidateAll(heap, "unknown-call");
        } else if (!(t.isIdentifier(n) || t.isThisExpression(n) || t.isSuper(n) || t.isLiteral(n) || t.isPrivateName(n))) this.invalidateAll(heap, "unsupported");
        this.observe(n, heap, ctx);
    }
    private computedKey(n: t.Node, heap: Heap, ctx: Context) {
        this.expression(n, heap, ctx);
        if (this.tokens(n).length) this.invalidateAll(heap, "unsupported"); // ToPropertyKey may call user code
    }
    private read(n: t.MemberExpression | t.OptionalMemberExpression, heap: Heap) {
        if (this.f.callToFunctionOrModule.get(n)?.size) this.invalidateAll(heap, "accessor");
        for (const token of this.tokens(n.object)) {
            const fact = heap.get(token)?.fact;
            if (heap.has(ambientEffects) && (!fact || !known(fact) || !fact.props.some(p => p.name === getProperty(n))))
                this.invalidateAll(heap, "accessor");
            // Reading an unknown object may invoke an unmodeled getter.
            if (fact && (!known(fact) || fact.props.some(p => p.name === getProperty(n) && p.accessor)) ||
                !fact && this.queryTokens && (token instanceof ObjectToken || token instanceof PrototypeToken))
                this.invalidateAll(heap, "accessor");
        }
    }
    private initPrototype(fun: t.Function, heap: Heap, ctx: Context) {
        const token = this.prototypes.get(fun);
        if (token) this.allocate(token, heap, ctx, [{...ordinary("constructor"), implicitConstructor: true, enumerable: false}]);
    }
    private classExpression(n: t.Class, heap: Heap, ctx: Context) {
        if (n.superClass) {this.expression(n.superClass, heap, ctx); this.invalidateAll(heap, "unsupported");}
        const ctor = n.body.body.find((m): m is t.ClassMethod => t.isClassMethod(m) && m.kind === "constructor");
        if (ctor) {
            this.initPrototype(ctor, heap, ctx);
            for (const m of n.body.body) {
                if ("computed" in m && m.computed && "key" in m) this.computedKey(m.key, heap, ctx);
                if (t.isClassMethod(m) && m.kind !== "constructor" && !m.static) {
                    const pt = this.prototypes.get(ctor); this.write(pt ? [pt] : [], getKey(m), heap, ctx, m.kind !== "method", false, true);
                } else if (t.isClassProperty(m) && m.static && m.value) this.expression(m.value, heap, ctx);
                else if (t.isStaticBlock(m)) this.sequence(m.body, heap, ctx);
            }
        }
    }
    private call(n: t.CallExpression | t.NewExpression | t.OptionalCallExpression, heap: Heap, ctx: Context) {
        const targets = [...(this.f.callToFunctionOrModule.get(n) ?? [])];
        const functions = targets.filter((x): x is FunctionInfo => x instanceof FunctionInfo);
        const modules = targets.filter((x): x is ModuleInfo => x instanceof ModuleInfo);
        const callee = this.tokens(n.callee);
        this.result.diagnostics.calls++;
        if (t.isNewExpression(n)) for (const token of this.tokens(n)) if (token instanceof ObjectToken) this.allocate(token, heap, ctx);
        if (modules.length) {
            if (targets.length !== 1) this.invalidateAll(heap, "unknown-call");
            else this.module(modules[0], heap, ctx);
        } else if (targets.length === 1 && functions.length === 1 && !this.f.externalCallLocations.has(n) &&
            callee.length > 0 && callee.every(token => token instanceof FunctionToken || token instanceof ObjectToken ||
                token instanceof PrototypeToken || token instanceof NativeObjectToken && !token.invoke && !token.constr)) {
            const fun = this.funs.get(functions[0]);
            if (!fun || fun.async || fun.generator) this.invalidateAll(heap, "unknown-call");
            else if (this.unsupportedConstructors.has(fun) || fun.params.some(p => !t.isIdentifier(p))) this.invalidateAll(heap, "unsupported");
            else if (ctx.stack.includes(fun) || ctx.stack.length >= 128) this.invalidateAll(heap, "recursive-call");
            else {
                const nested = {...ctx, stack: [...ctx.stack, fun]};
                if (t.isNewExpression(n)) for (const field of this.classFields.get(fun) ?? []) {
                    if (field.value) this.expression(field.value, heap, nested);
                    this.write(this.tokens(n), getKey(field), heap, nested, false, true, true);
                }
                const exits = t.isBlockStatement(fun.body) ? this.statement(fun.body, heap, nested) :
                    (this.expression(fun.body, heap, nested), [{heap, kind: "return" as const}]);
                const returned = exits.filter(e => e.kind !== "throw").map(e => e.heap);
                if (!returned.length) for (const e of exits) this.invalidate(e.heap, e.heap.keys(), "unsupported");
                const out = this.merge(returned.length ? returned : exits.map(e => e.heap)); heap.clear();
                for (const [token, cell] of out) heap.set(token, cell);
            }
        } else {
            const harmless = callee.length > 0 && callee.every(token => token instanceof NativeObjectToken && token.moduleInfo === undefined &&
                /^(Math\.|Number\.is|Object\.is$)/.test(token.name)) && n.arguments.every(arg => !this.tokens(t.isSpreadElement(arg) ? arg.argument : arg).length);
            if (!harmless) this.invalidateAll(heap, "unknown-call");
        }
    }
    private module(module: ModuleInfo, heap: Heap, ctx: Context) {
        if (ctx.conditional || ctx.loop) {
            this.invalidateAll(heap, "unknown-call");
            // Module caches cannot be shared between alternatives. Analyze effects
            // conservatively and do not mark the module as definitely loaded.
            if (this.activeModules.has(module)) return;
        } else if (this.loadedModules.has(module)) return;
        if (this.activeModules.has(module)) {this.invalidateAll(heap, "recursive-call"); return;}
        const root = this.roots.get(module);
        if (!root) {this.invalidateAll(heap, "unknown-call"); return;}
        this.activeModules.add(module);
        // ES module dependencies run before any statement of the importing body,
        // including imports that appear below executable statements in the file.
        for (const declaration of root.body)
            if (t.isImportDeclaration(declaration) || t.isExportAllDeclaration(declaration) ||
                t.isExportNamedDeclaration(declaration) && declaration.source) {
                const targets = [...(this.f.callToFunctionOrModule.get(declaration) ?? [])];
                if (targets.length === 1 && targets[0] instanceof ModuleInfo) this.module(targets[0], heap, ctx);
                else this.invalidateAll(heap, "unknown-call");
            }
        const out = this.merge(this.statement(root, heap, ctx).map(e => e.heap)); heap.clear();
        for (const [token, cell] of out) heap.set(token, cell);
        this.activeModules.delete(module);
        if (!ctx.conditional && !ctx.loop) this.loadedModules.add(module);
    }
    run(): ShapeInfos {
        if (this.queryTokens?.size === 0) return this.result;
        for (const root of [...this.roots.keys()].filter(m => this.f.a.entryFiles.has(resolve(m.getPath())))) {
            if (this.result.diagnostics.truncated) break;
            this.loadedModules.clear(); this.module(root, new Map, {conditional: false, loop: false, stack: []});
        }
        if (this.result.diagnostics.truncated)
            for (const node of this.queryNodes ?? this.candidateNodes)
                this.observe(node, new Map, {conditional: false, loop: false, stack: [], opaque: "budget"});
        const shapeNames = new Map<string, string>(), bindingKeys = new Set<string>(), guardKeys = new Set<string>();
        const signatures = new Map<ReadonlyArray<Descriptor>, string>();
        for (const o of this.observations.values()) {
            const location = this.loc(o.node)!;
            if (this.result.diagnostics.truncated) o.fact = unknown("budget");
            const point: ShapePoint = {location, token: o.token.toString(), phase: o.phase};
            if (known(o.fact)) {
                let structural = signatures.get(o.fact.props);
                if (!structural) {structural = JSON.stringify(o.fact.props); signatures.set(o.fact.props, structural);}
                const signature = `${o.token.index}:${structural}`;
                let name = shapeNames.get(signature);
                if (!name) {
                    name = `Shape${shapeNames.size + 1}`; shapeNames.set(signature, name);
                    this.result.shapes.push({
                        name, kind: o.token instanceof PrototypeToken ? "prototype" : o.token instanceof ObjectToken && t.isFunction(o.token.allocSite as t.Node) ? "instance" : "object",
                        location: this.loc((o.token as ObjectToken).allocSite as t.Node) ?? location,
                        properties: o.fact.props.map(p => {
                            const v = this.propertyVars.get(o.token)?.get(p.name), rep = v ? this.f.getRepresentative(v) : undefined;
                            return {name: p.name, kind: p.accessor ? "accessor" : "data", writable: !p.accessor, enumerable: p.enumerable, configurable: true,
                                implicitConstructor: p.implicitConstructor, types: rep && !p.implicitConstructor ? this.labels.getTypes(rep) : [],
                                closures: rep ? [...this.f.getTokens(rep)].filter((t): t is FunctionToken => t instanceof FunctionToken)
                                    .map(t => this.loc(t.fun)).filter((l): l is string => !!l).sort() : []};
                        }),
                    });
                }
                point.shape = name; this.result.diagnostics.known++;
                const tokens = this.tokens(o.node), v = this.vars.get(o.node), types = v ? this.labels.getTypes(this.f.getRepresentative(v)) : [];
                const annotatable = tokens.length === 1 && types.length === 1 && types[0] === "object";
                if (o.binding && annotatable) {
                    const key = `${location}|${name}|${o.phase}`;
                    if (!bindingKeys.has(key)) {bindingKeys.add(key); this.result.bindings.push({location, shape: name, phase: o.phase});}
                } else if (!o.binding && o.phase === "after-expression") {
                    const key = `${location}|${name}`;
                    if (annotatable && !guardKeys.has(key)) {guardKeys.add(key); this.result.guards.push({location, shape: name});}
                }
            } else {point.reason = o.fact.reason; this.result.diagnostics.unknown++;}
            this.result.states.push(point);
        }
        this.result.states.sort((a, b) => a.location.localeCompare(b.location) || a.token.localeCompare(b.token) || a.phase.localeCompare(b.phase));
        logger.info(`Shape inference: ${this.result.shapes.length} shapes, ${this.result.diagnostics.known} known, ${this.result.diagnostics.unknown} unknown observations`);
        return this.result;
    }
}
