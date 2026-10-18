import {Binding} from "@babel/traverse";
import {Identifier, isFunction, isProgram, JSXIdentifier} from "@babel/types";
import {BasicBlock, CfgEvent, FunctionCFG, ProgramCFG} from "./cfg";
import {NodeRefinement, RefinementEvent} from "./refine";
import {getOrSet, Location, mapGetMap, mapGetSet, MinHeap} from "../misc/util";

/** A definition in the node-level views: a write-site identifier node, a refinement, or null. */
export type NodeDef = Identifier | JSXIdentifier | NodeRefinement | null;

/**
 * Reaching definitions / def-use chains over the CFGs, intended for flow-sensitive refinement
 * of variable values at read events. This is "SSA without phi nodes": instead of factoring
 * join points into phi nodes, each read event is mapped directly to the set of definitions
 * that may reach it.
 *
 * Soundness contract (inherited from the CFG contract in cfg.ts):
 * for every read event of a refinable binding, the definition that produced the value actually
 * observed at runtime is contained in the read's reaching-definitions set.
 *
 * Only *refinable* bindings are analyzed — bindings for which the CFG events provably cover
 * all accesses to the variable:
 * - declared and accessed within a single function (not captured by nested functions);
 *   note that this also makes suspension points (yield/await) and reentrant invocations
 *   harmless: no other code can touch an uncaptured local, and each invocation has its own
 *   environment;
 * - the function is not poisoned by 'with' or direct 'eval' (FunctionCFG.hasWith/hasDirectEval);
 * - declared with a binding kind whose writes the builder models precisely (REFINABLE_KINDS);
 *   any other kind, including Babel's "unknown" and kinds added by future Babel versions,
 *   fails closed — in particular, import bindings (kind "module") are live views that the
 *   exporting module can reassign without events here, and named function/class expression
 *   self-bindings (kind "local") silently ignore sloppy-mode writes, so a write event may not
 *   actually change the value;
 * - not a parameter of a function that references 'arguments' (FunctionCFG.usesArguments):
 *   in sloppy mode the arguments object aliases simple parameters, so parameters can be read
 *   and written without events (for CommonJS programs this also concerns the artificial module
 *   parameters, recognized by their native source location);
 * - not a block-level function declaration (kind "hoisted" in a non-function scope): in sloppy
 *   mode, Annex B maintains an aliased function-scoped copy with different values at different
 *   uses of the same binding;
 * - not exported as an ES module live binding (ProgramCFG.exportedLiveBindings): importers
 *   observe the variable over time, including reassignments after the export executed, which
 *   no single read event can express;
 * - not recorded as unhandled by the builder (ProgramCFG.unhandledBindings): writes the
 *   builder recognized but did not model precisely;
 * - not accessed in unreachable code (where there is no def-use information, although clients
 *   such as the constraint analysis may still model the access).
 * All accesses of refinable bindings are thereby covered by nodeDefs/writeNodes; reads of all
 * other bindings must be treated conservatively by clients (flow-insensitively, using the
 * declaration node as the variable, all writes flow there).
 */
export class DefUse {

    /**
     * The bindings whose reads have reaching-definitions information.
     */
    readonly refinable = new Set<Binding>();

    /**
     * For each read identifier node of a refinable binding (in code reachable in its CFG),
     * the definitions that may reach it (the union over the node's events, e.g. for finally
     * duplication), as write-site identifier nodes, refinements, and null meaning the binding
     * may still be in its initial state — undefined for var/parameter bindings, or the
     * temporal dead zone (where the read throws) for let/const/class bindings.
     * A node absent from this map must be treated conservatively.
     * (The event-level reaching definitions are transient in computeDefUse; unit tests can
     * observe them through its collectReachingDefs hook.)
     */
    readonly nodeDefs = new Map<Identifier | JSXIdentifier, Set<NodeDef>>();

    /**
     * Node-level view of the definitions: for each write-site identifier node of a refinable
     * binding (in reachable code), the identifier node declaring the binding.
     * (Refinements are not included; see `refinements`.)
     */
    readonly writeNodes = new Map<Identifier | JSXIdentifier, Identifier>();

    /**
     * The refinements of refinable bindings (in reachable code), with their sources filled in.
     */
    readonly refinements = new Set<NodeRefinement>();

    /**
     * Canonicalization of reads by (binding, definition set): reads of the same binding whose
     * definition sets are equal provably observe the same values, so clients can use a single
     * constraint variable for all of them (see ConstraintVarProducer.identVar and the def-use
     * wiring in astvisitor) — n×m definition-to-use edges collapse to n edges per distinct
     * definition set. Only non-identity entries are stored; nodes that are also write sites
     * keep their own variable and never represent other reads (their node variable also
     * carries the written value, e.g. in 'x++', which other reads must not observe).
     */
    readonly readRep = new Map<Identifier | JSXIdentifier, Identifier | JSXIdentifier>();

    /** The canonical representative for the given read identifier node (see readRep). */
    rep(node: Identifier | JSXIdentifier): Identifier | JSXIdentifier {
        return this.readRep.get(node) ?? node;
    }
}

/**
 * The binding kinds that may be refinable — those whose write semantics the CFG builder
 * models with events (see the exclusions in the DefUse documentation above for why "module"
 * and "local" are not among them). Any other kind, including Babel's "unknown" and kinds
 * added by future Babel versions, is non-refinable by default (fail closed).
 */
const REFINABLE_KINDS: ReadonlySet<Binding["kind"]> = new Set(["var", "let", "const", "param", "hoisted"]);

/**
 * Computes reaching definitions for all read events of refinable bindings.
 * @param pcfg the program CFG
 * @param collectReachingDefs testing-only hook: invoked with the event-level reaching
 * definitions of each read event of a refinable binding in reachable code (the sets must not
 * be modified); production clients use the node-level views retained in DefUse instead
 */
export function computeDefUse(pcfg: ProgramCFG,
                              collectReachingDefs?: (read: CfgEvent, defs: ReadonlySet<CfgEvent | null>) => void): DefUse {
    const res = new DefUse();

    // canonical NodeRefinement per (anchor node, polarity); the filter test is determined by those
    const nodeRefinements = new Map<Identifier | JSXIdentifier, Map<boolean, NodeRefinement>>();
    function nodeRefinement(e: RefinementEvent): NodeRefinement {
        return getOrSet(mapGetMap(nodeRefinements, e.node), e.filter.negated, () => {
            const nr = new NodeRefinement(e.node, e.filter);
            res.refinements.add(nr);
            return nr;
        });
    }
    function toNodeDef(d: CfgEvent | null): NodeDef {
        return d === null ? null : d instanceof RefinementEvent ? nodeRefinement(d) : d.node;
    }

    // the blocks of each function that are reachable from its entry
    // (events in unreachable blocks belong to code that can never execute)
    const blocksOf = new Map<FunctionCFG, Array<BasicBlock>>();
    const reachableNodes = new Set<Identifier | JSXIdentifier>();
    for (const f of pcfg.functions.values()) {
        const blocks: Array<BasicBlock> = [f.entry];
        const seen = new Set<BasicBlock>(blocks);
        for (let i = 0; i < blocks.length; i++) {
            for (const e of blocks[i].events)
                reachableNodes.add(e.node);
            for (const succ of [blocks[i].succNormal, blocks[i].succFalse, blocks[i].succException])
                if (succ && !seen.has(succ)) {
                    seen.add(succ);
                    blocks.push(succ);
                }
        }
        blocksOf.set(f, blocks);
    }

    // bindings with accesses in unreachable code: the analysis (astvisitor) still models such
    // accesses, but they have no def-use information, so these bindings are not refined.
    // (Node granularity: a node all of whose events are unreachable is an access without
    // def-use information; a node with some reachable event is covered by the node-level views,
    // e.g. a use in a finally block whose copy for one exit path is unreachable.)
    const deadAccessed = new Set<Binding>();
    for (const [node, evs] of pcfg.occurrences)
        if (!reachableNodes.has(node) && evs[0]?.binding)
            deadAccessed.add(evs[0].binding!);

    // the function declaring each binding
    const home = new Map<Binding, FunctionCFG>();
    for (const f of pcfg.functions.values())
        for (const b of f.declares)
            home.set(b, f);

    // bindings with events outside their declaring function (captured by nested functions,
    // or occurring in class field initializers that execute in the constructor's CFG)
    const escaped = new Set<Binding>();
    for (const [f, blocks] of blocksOf)
        for (const bl of blocks)
            for (const e of bl.events)
                if (e.binding && home.get(e.binding) !== f)
                    escaped.add(e.binding);

    for (const f of pcfg.functions.values())
        if (!f.hasWith && !f.hasDirectEval)
            for (const b of f.declares) {
                if (escaped.has(b) ||
                    deadAccessed.has(b) ||
                    pcfg.exportedLiveBindings.has(b) || // ES module live exports observe the variable over time
                    pcfg.unhandledBindings.has(b) || // writes not modeled precisely by the builder
                    !REFINABLE_KINDS.has(b.kind) ||
                    (b.kind === "param" && f.usesArguments) ||
                    (b.kind === "hoisted" && !isFunction(b.scope.block) && !isProgram(b.scope.block)) ||
                    (b.identifier.loc as Location | null)?.native !== undefined) // artificial declarations (e.g. CommonJS module parameters) are written by the runtime without events
                    continue;
                res.refinable.add(b);
            }

    for (const f of pcfg.functions.values())
        analyze(f, blocksOf.get(f)!);

    // canonicalize reads: one representative per (binding, definition set), in recording order
    // (hash-consing: definitions are numbered on first encounter, the sorted numbers form the key)
    {
        const defIds = new Map<NodeDef, number>();
        const reps = new Map<Binding, Map<string, Identifier | JSXIdentifier>>();
        for (const [node, defs] of res.nodeDefs) {
            if (res.writeNodes.has(node))
                continue; // dual read/write nodes (e.g. 'x++') keep their own variable
            const ids: Array<number> = [];
            for (const d of defs)
                ids.push(getOrSet(defIds, d, () => defIds.size));
            const key = ids.sort((x, y) => x - y).join(",");
            const binding = pcfg.occurrences.get(node)![0].binding!;
            const m = mapGetMap(reps, binding);
            const rep = m.get(key);
            if (rep)
                res.readRep.set(node, rep);
            else
                m.set(key, node);
        }
    }

    return res;

    /**
     * Standard iterative forward may-analysis over one function's blocks.
     * A state gives the possible definitions of each refinable binding declared in the
     * function, indexed densely by the binding's position (see `index`); the definition sets
     * are immutable and shared between states, so a join can compare them cheaply and reuse
     * them, and every binding starts as the shared `initial` set, {null}.
     * Transfer: a write is a strong update (it kills all other definitions). Per the exception
     * rule (see cfg.ts), the state passed along succException is the block-entry state joined
     * with all definitions generated in the block, without kills.
     * @param blocks the function's reachable blocks, in discovery order
     */
    function analyze(f: FunctionCFG, blocks: Array<BasicBlock>): void {
        const index = new Map<Binding, number>(); // the position of each refinable binding
        for (const b of f.declares)
            if (res.refinable.has(b))
                index.set(b, index.size);
        if (index.size === 0)
            return;

        const initial: DefSet = new Set([null]);

        // The worklist is ordered by the blocks' discovery order, which visits a block after
        // its predecessors except across back edges — so each block is normally computed once,
        // whereas an arbitrary order recomputes its whole subgraph every time a predecessor is
        // refined. That makes it a priority queue rather than a stack or queue: draining a
        // FIFO in rounds instead defers the blocks enqueued during a round to the next one,
        // which costs extra visits.
        const position = new Map<BasicBlock, number>();
        for (const bl of blocks)
            position.set(bl, position.size);

        const ins = new Map<BasicBlock, State>();
        const work = new MinHeap();
        const pending = new Uint8Array(blocks.length); // mirrors worklist membership
        function enqueue(bl: BasicBlock): void {
            const pos = position.get(bl)!;
            if (!pending[pos]) {
                pending[pos] = 1;
                work.push(pos);
            }
        }
        ins.set(f.entry, new Array<DefSet>(index.size).fill(initial));
        enqueue(f.entry);

        // joins src into the in-state of bl (states own their arrays but share the sets)
        function join(bl: BasicBlock, src: State): void {
            const target = ins.get(bl);
            if (!target) {
                // first reach: the in-state becomes a (set-sharing) copy of src
                ins.set(bl, src.slice());
                enqueue(bl);
                return;
            }
            // most joins of a converging fixpoint add nothing, so containsAll tests each
            // entry before anything is allocated or rebuilt
            let changed = false;
            for (let i = 0; i < src.length; i++)
                if (!containsAll(target[i], src[i])) {
                    target[i] = union(target[i], src[i]);
                    changed = true;
                }
            if (changed)
                enqueue(bl);
        }

        while (work.size > 0) {
            const pos = work.pop()!;
            pending[pos] = 0;
            const bl = blocks[pos];
            const st = ins.get(bl)!;
            // the out-states are only cloned if the block actually contains writes,
            // and the exception out-state only if the block has an exception successor
            let out: State = st, exc: State = st;
            for (const e of bl.events) {
                if (e.kind !== "write" || !e.binding)
                    continue;
                const i = index.get(e.binding);
                if (i === undefined)
                    continue;
                if (out === st) {
                    out = st.slice(); // shares sets with st; writes replace entries
                    if (bl.succException)
                        exc = st.slice();
                }
                out[i] = new Set([e]);
                if (bl.succException)
                    exc[i] = addDef(exc[i], e);
            }
            for (const succ of [bl.succNormal, bl.succFalse])
                if (succ)
                    join(succ, out);
            if (bl.succException)
                join(bl.succException, exc);
        }

        // record the reaching definitions at each read event, and the node-level views
        for (const [bl, st] of ins) {
            let cur: State = st; // cloned lazily at the first write (writes replace entries)
            for (const e of bl.events) {
                if (!e.binding)
                    continue;
                const i = index.get(e.binding);
                if (i === undefined)
                    continue;
                if (e.kind === "read") {
                    const s = cur[i];
                    collectReachingDefs?.(e, s);
                    const ds = mapGetSet(res.nodeDefs, e.node);
                    for (const d of s)
                        ds.add(toNodeDef(d));
                } else {
                    if (e instanceof RefinementEvent) {
                        // record the definitions flowing into the refinement
                        const nr = nodeRefinement(e);
                        for (const d of cur[i])
                            nr.sources.add(toNodeDef(d));
                    } else
                        res.writeNodes.set(e.node, e.binding.identifier);
                    if (cur === st)
                        cur = st.slice();
                    cur[i] = new Set([e]);
                }
            }
        }
    }
}

/** An immutable set of definitions, shared between states. */
type DefSet = ReadonlySet<CfgEvent | null>;

/** The definitions of each refinable binding at a program point, indexed densely by position. */
type State = Array<DefSet>;

/** Whether `a` contains every element of `b` (shared sets make the identity test effective). */
function containsAll(a: DefSet, b: DefSet): boolean {
    if (a === b)
        return true;
    if (a.size < b.size)
        return false;
    for (const x of b)
        if (!a.has(x))
            return false;
    return true;
}

/** The union of two definition sets as a new set (callers ensure neither contains the other). */
function union(a: DefSet, b: DefSet): DefSet {
    const s = new Set(a);
    for (const x of b)
        s.add(x);
    return s;
}

/** The union of `a` and {d}, reusing `a` when it already contains `d`. */
function addDef(a: DefSet, d: CfgEvent): DefSet {
    if (a.has(d))
        return a;
    const s = new Set(a);
    s.add(d);
    return s;
}
