/**
 * Forward data-flow reachability reporter (`--dataflow-json`).
 *
 * Given a source expression location (`file:line:col`, 1-based column), resolve it
 * to a constraint variable (via GlobalState.expLocationIndex, filled in Operations.expVar),
 * then traverse FragmentState.subsetEdges forward to a bounded depth. Internal constraint
 * variables and tokens are projected to human-facing nodes; each edge is classified by
 * operation kind (store-property / load-property / argument / return / call-result /
 * assignment / external-escape). Abstract object representations (ObjectPropertyVar,
 * AncestorsVar, ReadResultVar, allocation tokens) are reported as compressed node kinds,
 * never as raw internal identifiers.
 *
 * subsetEdges is monotonically accumulated during the fixpoint; under timeout/abort/wave/
 * indirection limits the graph may be incomplete (fewer listener-instantiated edges), so the
 * resulting may-flow is an under-approximation — reflected in the `completeness` field.
 */

import {isIdentifier, Node} from "@babel/types";
import {relative} from "path";
import {
    AncestorsVar,
    ArgumentsVar,
    FunctionReturnVar,
    IntermediateVar,
    NodeVar,
    ObjectPropertyVar,
    ReadResultVar,
    ThisVar,
} from "../analysis/constraintvars";
import {
    AccessPathToken,
    AllocationSiteToken,
    FunctionToken,
    NativeObjectToken,
    PackageObjectToken,
    Token,
} from "../analysis/tokens";
import {FragmentState, RepresentativeVar} from "../analysis/fragmentstate";
import {Location} from "../misc/util";
import {locKeyFromLoc} from "../analysis/callEdgePriors";
import {options} from "../options";
import AnalysisDiagnostics from "../analysis/diagnostics";
import {
    DataflowEdge,
    DataflowEdgeKind,
    DataflowNode,
    DataflowNodeKind,
    DataflowReport,
    DataflowToken,
} from "../typings/dataflow";
import logger from "../misc/logger";

export interface DataflowOptions {
    maxDepth?: number;
    maxNodes?: number;
    direction?: "forward" | "reverse" | "both";
}

const DEFAULT_MAX_DEPTH = 20;
const DEFAULT_MAX_NODES = 10000;
const MAX_TOKENS_PER_NODE = 10;

export function dataflowToJSON(
    f: FragmentState,
    sourceLoc: string | undefined,
    diagnostics: AnalysisDiagnostics,
    opts: DataflowOptions = {},
): DataflowReport {
    const maxDepth = opts.maxDepth ?? DEFAULT_MAX_DEPTH;
    const maxNodes = opts.maxNodes ?? DEFAULT_MAX_NODES;
    const direction = opts.direction ?? "both";

    // File table built from analyzed modules (matches call-graph JSON's relative-to-basedir paths).
    const fileNames: Array<string> = [];
    const fileIndex = new Map<string, number>();
    for (const m of f.a.moduleInfos.values()) {
        if (m.loc) {
            const rel = relative(options.basedir, m.getPath());
            if (!fileIndex.has(rel)) {
                fileIndex.set(rel, fileNames.length);
                fileNames.push(rel);
            }
        }
    }

    const locKey = (loc: any): string | undefined => {
        if (!loc) return undefined;
        const m = (loc as Location).module;
        if (!m) return undefined;
        const rel = relative(options.basedir, m.getPath());
        const fi = fileIndex.get(rel);
        if (fi === undefined) return undefined;
        return `${fi}:${loc.start.line}:${loc.start.column + 1}:${loc.end.line}:${loc.end.column + 1}`;
    };

    // Parameter representatives, for argument-edge classification.
    const paramReps = new Set<RepresentativeVar>();
    for (const ps of f.functionParameters.values())
        for (const p of ps) {
            const r = f.getRepresentative(p);
            if (r) paramReps.add(r);
        }

    // First source location recorded for each property-write dst / property-read base (rep).
    const writeVia = new Map<RepresentativeVar, {prop?: string, via?: string}>();
    for (const w of f.propertyWrites) {
        const r = f.getRepresentative(w.dst);
        if (r && !writeVia.has(r)) writeVia.set(r, {prop: w.prop, via: locKey((w.node as any).loc)});
    }
    const readVia = new Map<RepresentativeVar, {prop?: string, via?: string}>();
    for (const rd of f.propertyReads) {
        const r = f.getRepresentative(rd.base);
        if (r && !readVia.has(r)) readVia.set(r, {prop: rd.prop, via: locKey((rd.node as any).loc)});
    }

    const completeness = {
        aborted: !!diagnostics.aborted,
        timeout: !!diagnostics.timeout,
        waveLimitReached: diagnostics.waveLimitReached ?? 0,
        indirectionsLimitReached: diagnostics.indirectionsLimitReached ?? 0,
    };
    const empty: DataflowReport = {
        schemaVersion: 1,
        source: {location: sourceLoc ?? "", resolved: false},
        completeness,
        truncated: false,
        truncationReason: null,
        files: fileNames,
        nodes: [],
        edges: [],
    };

    if (!sourceLoc) {
        logger.warn("--dataflow-json requires --dataflow-source file:line:col");
        return empty;
    }
    const match = /^(.*):(\d+):(\d+):(\d+):(\d+)$/.exec(sourceLoc); // file:sl:sc:el:ec (range)
    if (!match) {
        logger.warn(`Unrecognized --dataflow-source location: ${sourceLoc} (expected file:sl:sc:el:ec)`);
        return empty;
    }
    const key = `${match[1]}:${match[2]}:${match[3]}:${match[4]}:${match[5]}`; // range key, matching expLocationIndex
    const entry = f.a.expLocationIndex.get(key);
    if (!entry || !entry.v) {
        logger.warn(`No constraint variable for expression at ${sourceLoc}`);
        return empty;
    }
    const start = f.getRepresentative(entry.v);

    const projectToken = (t: Token): DataflowToken => {
        if (t instanceof FunctionToken)
            return {kind: "function", location: locKey((t.fun as any).loc)};
        if (t instanceof AllocationSiteToken)
            return {kind: "allocation", objectKind: t.kind, location: locKey((t.allocSite as any)?.loc)};
        if (t instanceof NativeObjectToken)
            return {kind: "native", name: t.name};
        if (t instanceof PackageObjectToken)
            return {kind: "package", objectKind: t.kind};
        if (t instanceof AccessPathToken)
            return {kind: "access-path"};
        return {kind: t.constructor.name};
    };

    const projectNode = (v: RepresentativeVar, depth: number): DataflowNode => {
        let kind: DataflowNodeKind;
        let label: string | undefined;
        let prop: string | undefined;
        if (v instanceof NodeVar) {
            kind = "variable";
            const n = v.node as Node;
            label = n && isIdentifier(n) ? (n as any).name : (n as any)?.type;
        } else if (v instanceof ObjectPropertyVar) {
            kind = "property";
            prop = v.prop;
        } else if (v instanceof FunctionReturnVar) {
            kind = "return";
        } else if (v instanceof ThisVar) {
            kind = "this";
        } else if (v instanceof ArgumentsVar) {
            kind = "arguments";
        } else if (v instanceof AncestorsVar || v instanceof ReadResultVar) {
            kind = "intermediate"; // internal analysis mechanism; collapsed, not exposed
        } else if (v instanceof IntermediateVar) {
            kind = "intermediate";
            label = v.label;
        } else {
            kind = "intermediate";
        }
        const parent = v.getParent();
        const location = parent && (parent as any).loc ? locKey((parent as any).loc) : undefined;
        const tokens: Array<DataflowToken> = [];
        let n = 0;
        for (const t of f.getTokens(v)) {
            if (n++ >= MAX_TOKENS_PER_NODE) break;
            tokens.push(projectToken(t));
        }
        const node: DataflowNode = {id: 0, kind, var: v.toString(), depth, tokens};
        if (location) node.location = location;
        if (label) node.label = label;
        if (prop) node.prop = prop;
        return node;
    };

    const classify = (src: RepresentativeVar, dst: RepresentativeVar): {
        kind: DataflowEdgeKind, prop?: string, via?: string,
    } => {
        if (f.maybeEscapingToExternal.has(src) || f.maybeEscapingToExternal.has(dst))
            return {kind: "external-escape"};
        if (dst instanceof ObjectPropertyVar) {
            const w = writeVia.get(dst);
            return {kind: "store-property", prop: dst.prop, via: w?.via};
        }
        if (src instanceof ObjectPropertyVar || src instanceof ReadResultVar) {
            const r = readVia.get(src);
            return {
                kind: "load-property",
                prop: src instanceof ObjectPropertyVar ? src.prop : r?.prop,
                via: r?.via,
            };
        }
        if (src instanceof FunctionReturnVar || dst instanceof FunctionReturnVar)
            return {kind: "return"};
        if (dst instanceof ArgumentsVar)
            return {kind: "argument"};
        if (dst instanceof NodeVar && paramReps.has(dst as RepresentativeVar))
            return {kind: "argument"};
        if (src instanceof IntermediateVar && dst instanceof NodeVar)
            return {kind: "call-result"};
        return {kind: "assignment"};
    };

    const nodes: Array<DataflowNode> = [];
    const ids = new Map<RepresentativeVar, number>();
    const depthOf = new Map<RepresentativeVar, number>();
    const edges: Array<DataflowEdge> = [];
    const addNode = (v: RepresentativeVar, depth: number): number => {
        const existing = ids.get(v);
        if (existing !== undefined) {
            if (depth < (depthOf.get(v) ?? depth)) {
                depthOf.set(v, depth);
                nodes[existing].depth = depth;
            }
            return existing;
        }
        const id = nodes.length;
        ids.set(v, id);
        depthOf.set(v, depth);
        const node = projectNode(v, depth);
        node.id = id;
        nodes.push(node);
        return id;
    };

    let truncated = false;
    let truncationReason: "maxDepth" | "maxNodes" | null = null;

    addNode(start, 0);

    // BFS helper: traverses successors via adjFn, recording edges with a direction tag.
    const bfs = (
        adjFn: (v: RepresentativeVar) => Set<RepresentativeVar> | undefined,
        dir: "forward" | "reverse",
    ) => {
        const visited = new Set<RepresentativeVar>([start]);
        const queue: Array<RepresentativeVar> = [start];
        while (queue.length) {
            if (ids.size > maxNodes) {
                truncated = true;
                truncationReason = "maxNodes";
                break;
            }
            const rep = queue.shift()!;
            const d = depthOf.get(rep) ?? 0;
            if (d >= maxDepth) continue;
            const succs = adjFn(rep);
            if (!succs) continue;
            for (const next of succs) {
                const repId = ids.get(rep)!;
                const nextId = addNode(next, d + 1);
                const c = dir === "forward" ? classify(rep, next) : classify(next, rep);
                const e: DataflowEdge = {
                    from: dir === "forward" ? repId : nextId,
                    to: dir === "forward" ? nextId : repId,
                    kind: c.kind,
                    direction: dir,
                };
                if (c.prop) e.prop = c.prop;
                if (c.via) e.via = c.via;
                edges.push(e);
                if (!visited.has(next)) {
                    visited.add(next);
                    queue.push(next);
                }
            }
        }
    };

    if (direction === "forward" || direction === "both")
        bfs(v => f.subsetEdges.get(v), "forward");
    if (direction === "reverse" || direction === "both")
        bfs(v => f.reverseSubsetEdges.get(v), "reverse");

    logger.info(
        `Dataflow from ${sourceLoc}: ${nodes.length} nodes, ${edges.length} edges`
        + `${truncated ? ` (truncated: ${truncationReason})` : ""}`,
    );

    return {
        schemaVersion: 1,
        source: {
            location: sourceLoc,
            resolved: true,
            var: start.toString(),
            kind: (entry.node as any)?.type,
            declaration: (start instanceof NodeVar && start.node) ? locKeyFromLoc((start.node as any).loc) : undefined,
        },
        completeness,
        truncated,
        truncationReason,
        files: fileNames,
        nodes,
        edges,
        direction,
    };
}
