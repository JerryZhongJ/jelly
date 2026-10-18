/**
 * Forward data-flow reachability report produced by `--dataflow-json`.
 *
 * Given a source expression location (`file:line:col`), Jelly resolves it to a
 * constraint variable and traverses the subset edges (the forward may-flow
 * graph) to a bounded depth, projecting internal constraint variables / tokens
 * to human-facing nodes and classifying each edge by operation kind.
 *
 * Locations use the same `"<fileIndex>:<startLine>:<startColumn(1-based)>:<endLine>:<endColumn(1-based)>"`
 * format as the call-graph JSON (see typings/callgraph.ts).
 */

export type DataflowNodeKind =
    | "variable"
    | "property"
    | "return"
    | "this"
    | "arguments"
    | "intermediate"
    | "function"
    | "allocation"
    | "native"
    | "package"
    | "access-path";

export type DataflowEdgeKind =
    | "store-property"
    | "load-property"
    | "argument"
    | "return"
    | "call-result"
    | "assignment"
    | "external-escape";

export interface DataflowToken {
    kind: string;
    [key: string]: any;
}

export interface DataflowNode {
    id: number;
    kind: DataflowNodeKind;
    /** ConstraintVar.toString(), for debugging. */
    var: string;
    /** LocationJSON, or omitted for abstract/internal nodes (hidden object representation). */
    location?: string;
    depth: number;
    /** Identifier name or AST node type, for variable nodes. */
    label?: string;
    /** Property name, for property nodes. */
    prop?: string;
    tokens: Array<DataflowToken>;
}

export interface DataflowEdge {
    from: number;
    to: number;
    kind: DataflowEdgeKind;
    /** Property name for store-property / load-property edges. */
    prop?: string;
    /** LocationJSON of the AST node that gave rise to this subset edge, when known. */
    via?: string;
    /** Direction relative to the queried source: "forward" = flows out, "reverse" = flows in. */
    direction?: "forward" | "reverse";
}

export interface DataflowCompleteness {
    aborted: boolean;
    timeout: boolean;
    waveLimitReached: number;
    indirectionsLimitReached: number;
}

export interface DataflowReport {
    schemaVersion: 1;
    source: {
        location: string;
        resolved: boolean;
        /** ConstraintVar.toString() of the resolved start variable. */
        var?: string;
        kind?: string;
        /** LocationJSON of the declaration node (for identifiers: where it's declared). */
        declaration?: string;
    };
    completeness: DataflowCompleteness;
    truncated: boolean;
    truncationReason: "maxDepth" | "maxNodes" | null;
    files: Array<string>;
    nodes: Array<DataflowNode>;
    edges: Array<DataflowEdge>;
    direction?: "forward" | "reverse" | "both";
}
