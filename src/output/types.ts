/**
 * Structured output for basic type inference (`--types-json`).
 *
 * Reports the inferred may-type set per labeled expression, aligned with the
 * JSON reporter conventions used by --dataflow-json / --callgraph-json:
 * a file table plus location references, so locations stay compact and stable.
 */

import {isIdentifier, Node} from "@babel/types";
import {relative} from "path";
import {NodeVar} from "../analysis/constraintvars";
import {FunctionToken} from "../analysis/tokens";
import {FragmentState, RepresentativeVar} from "../analysis/fragmentstate";
import {TypeLabel, TypeLabels} from "../analysis/typelabels";
import {ShapeInfos, ShapeBinding, ShapePoint} from "../analysis/shapeinfer";
import {Location} from "../misc/util";
import {options} from "../options";
import logger from "../misc/logger";

export type TypesReportEntry = {
    /** Location reference "file:startLine:startCol(1-based):endLine:endCol(1-based)" (index into files). */
    location: string,
    /** AST node type of the expression. */
    nodeType: string,
    /** Inferred may-type set (propagated labels joined with token kinds). */
    types: Array<TypeLabel>,
    /** Labels contributed by propagation (primitives). */
    propagated?: Array<TypeLabel>,
    /** Labels contributed by tokens (object kinds). */
    fromTokens?: Array<TypeLabel>,
    /** Identifier name, when the entry is a variable declaration. */
    identifier?: string,
    /** Function target locations ("rel:sl:sc:el:ec", 1-based columns) for closure guards. */
    closures?: Array<string>,
    /** Expression source text, if available. */
    code?: string,
};

export type TypesReportShapeProperty = {
    name: string,
    kind: "data" | "accessor",
    writable: boolean,
    enumerable: boolean,
    configurable: boolean,
    /** May-type set of the values stored in the property (empty = unknown). */
    types?: Array<TypeLabel>,
    /** locKeys of FunctionTokens that may be stored in the property (closure targets). */
    closures?: Array<string>,
    /** true for the implicit non-enumerable 'constructor' on prototype shapes. */
    implicitConstructor?: boolean,
};

export type TypesReportShape = {
    name: string,
    kind: "instance" | "prototype" | "object",
    /** locKey of the defining node (constructor function / prototype host). */
    location: string,
    /** Ordered own-property list proven at reported program points. */
    properties: Array<TypesReportShapeProperty>,
};

export type TypesReport = {
    schemaVersion: 1,
    files: Array<string>,
    /** Number of propagation steps performed by the label fixpoint (diagnostics). */
    propagationSteps: number,
    entries: Array<TypesReportEntry>,
    /** Structural shapes; attached types are flow-insensitive may-types. */
    shapes?: Array<TypesReportShape>,
    /** Bindings explicitly distinguish expression completion and completed stores. */
    shapeBindings?: Array<ShapeBinding>,
    /** Expressions inferred to hold objects of one shape. */
    shapeGuards?: Array<{location: string, shape: string, prototypeShape?: string}>,
    shapeStates?: Array<ShapePoint>,
    shapeDiagnostics?: ShapeInfos["diagnostics"],
};

/**
 * Builds the type report for all labeled expressions.
 * Expressions are included even when no label reached them only if they have a
 * variable with token information; unlabeled/unresolved expressions are skipped.
 */
export function typesToJSON(f: FragmentState, labels: TypeLabels, shapes?: ShapeInfos): TypesReport {
    const files: Array<string> = [];
    const fileIndex = new Map<string, number>();
    const fileRef = (path: string): string => {
        let i = fileIndex.get(path);
        if (i === undefined) {
            i = files.length;
            fileIndex.set(path, i);
            files.push(path);
        }
        return String(i);
    };

    // collect entries: one per labeled expression, plus per use-site location
    const entries: Array<TypesReportEntry> = [];
    const seen = new Set<string>(); // dedupe by (rep, location)

    const addEntry = (node: Node, loc: Location): void => {
        if (loc.nodeIndex !== undefined)
            return; // desugared node without its own source location (loc inherited from an ancestor by AST preprocessing): reporting it would attribute the label to the wrong expression
        const rep = f.a.typeLabels.expVars.get(node);
        if (!rep)
            return;
        const r = f.getRepresentative(rep);
        const propagated = bitLabels(labels.labelBits.get(r));
        const fromTokens = bitLabels(labels.tokenBits.get(r));
        if (propagated.length === 0 && fromTokens.length === 0)
            return;
        const rel = relative(options.basedir, loc.module!.getPath());
        const key = `${r.index}:${rel}:${loc.start.line}:${loc.start.column}`;
        if (seen.has(key))
            return;
        seen.add(key);
        const e: TypesReportEntry = {
            location: `${fileRef(rel)}:${loc.start.line}:${loc.start.column + 1}:${loc.end.line}:${loc.end.column + 1}`,
            nodeType: node.type,
            types: bitLabels((labels.labelBits.get(r) ?? 0) | (labels.tokenBits.get(r) ?? 0)),
        };
        if (propagated.length && fromTokens.length) {
            e.propagated = propagated;
            e.fromTokens = fromTokens;
        }
        entries.push(e);
    };

    // labeled expressions (injection sites and arithmetic-rule results); skip
    // trivial literal sites where the type is the literal's own - those carry
    // no inferred information
    for (const [node] of f.a.typeLabels.expVars) {
        const loc = (node as any).loc as Location | null;
        if (loc && loc.module && !isTrivialLiteral(node))
            addEntry(node, loc);
    }

    // per-representative label info (bits + closure targets), shared by the
    // declaration and use-site passes below
    const repBits = new Map<RepresentativeVar, number>();
    const repClosures = new Map<RepresentativeVar, Array<string>>();
    const locKeyOf = (n: Node): string | undefined => {
        const loc = (n as any).loc as Location | null;
        if (!loc || !loc.module || loc.start.line === 0)
            return undefined;
        return `${relative(options.basedir, loc.module.getPath())}:${loc.start.line}:${loc.start.column + 1}:${loc.end.line}:${loc.end.column + 1}`;
    };
    for (const v of f.a.vars)
        if (f.isRepresentative(v)) {
            const r = v as RepresentativeVar;
            const bits = (labels.labelBits.get(r) ?? 0) | (labels.tokenBits.get(r) ?? 0);
            if (!bits)
                continue;
            repBits.set(r, bits);
            for (const t of f.getTokens(r))
                if (t instanceof FunctionToken) {
                    const k = locKeyOf(t.fun as unknown as Node);
                    if (k) {
                        const arr = repClosures.get(r) ?? [];
                        if (!arr.includes(k)) {
                            arr.push(k);
                            repClosures.set(r, arr);
                        }
                    }
                }
        }

    // identifier entries (declarations and use sites); each entry carries the
    // closure target functions so annotations can map 'function' to closure guards
    const addIdentifierEntry = (name: string, locKey: string, r: RepresentativeVar) => {
        const key = `${r.index}:${locKey}`;
        if (seen.has(key))
            return;
        seen.add(key);
        const parts = locKey.split(":"); // rel:sl:sc:el:ec (1-based columns)
        const e: TypesReportEntry = {
            location: `${fileRef(parts[0])}:${parts[1]}:${parts[2]}:${parts[3]}:${parts[4]}`,
            nodeType: "Identifier",
            identifier: name,
            types: bitLabels(repBits.get(r)),
        };
        const closures = repClosures.get(r);
        if (closures && closures.length > 0)
            e.closures = closures;
        entries.push(e);
    };

    // declarations: variables (identifier nodes) that received labels, e.g. `let x = 42`
    for (const v of f.a.vars)
        if (v instanceof NodeVar && isIdentifier(v.node) && f.isRepresentative(v)) {
            const r = v as RepresentativeVar;
            if (!repBits.has(r))
                continue;
            const k = locKeyOf(v.node);
            if (k)
                addIdentifierEntry(v.node.name, k, r);
        }

    // use sites: identifier references recorded by expVar (use-site location -> variable)
    for (const [k, {node, v}] of f.a.expLocationIndex)
        if (v && isIdentifier(node)) {
            const r = f.getRepresentative(v);
            if (repBits.has(r))
                addIdentifierEntry(node.name, k, r);
        }

    logger.info(`Types report: ${entries.length} expressions`);
    const report: TypesReport = {
        schemaVersion: 1,
        files,
        propagationSteps: labels.steps,
        entries,
    };
    if (shapes) {
        report.shapes = shapes.shapes.map(s => ({
            name: s.name,
            kind: s.kind,
            location: s.location,
            properties: s.properties.map(p => {
                const q: TypesReportShapeProperty = {
                    name: p.name, kind: p.kind, writable: p.writable,
                    enumerable: p.enumerable, configurable: p.configurable,
                };
                if (p.types.length)
                    q.types = p.types;
                if (p.closures.length)
                    q.closures = p.closures;
                if (p.implicitConstructor)
                    q.implicitConstructor = true;
                return q;
            }),
        }));
        report.shapeBindings = shapes.bindings;
        report.shapeGuards = shapes.guards;
        report.shapeStates = shapes.states;
        report.shapeDiagnostics = shapes.diagnostics;
    }
    return report;
}

function bitLabels(bits: number | undefined): Array<TypeLabel> {
    // local import to avoid a cycle at module load time
    const {bitToTypeLabels} = require("../analysis/typelabels");
    return bitToTypeLabels(bits ?? 0);
}

/**
 * Node types whose label is trivially their own literal kind: reporting them
 * adds noise without inference value (the interesting results are labels that
 * *propagated* somewhere).
 */
function isTrivialLiteral(node: Node): boolean {
    switch (node.type) {
        case "NumericLiteral":
        case "StringLiteral":
        case "BooleanLiteral":
        case "NullLiteral":
        case "BigIntLiteral":
        case "TemplateLiteral":
            return true;
    }
    return false;
}
