#!/usr/bin/env node
/**
 * jelly 调用图热函数分析（静态）—— 期望调用次数模型
 *
 * v(f) = [f∈S]·1  +  Σ_{c→f} v(c)·w(c,f)
 *
 *   v(f)：入口每执行一次，f 的期望调用次数（"热度 = 调用次数"）
 *   w(c,f) = Σ_{callsite s∈c} callsiteW(s)·prob(s,f)
 *     callsiteW(s) = loopWeight^depth（嵌套循环期望经过次数 = 各层次数之积；实证 96% 循环 depth<4）
 *     prob(s,f)    = 1/|targets(s)|（多目标 callsite 的概率分布，和为 1）
 *
 * DAG 上 v = base + W·v 收敛到精确解；递归环单调增长，用 maxIter 截断（不找 SCC）。
 *
 * 用法：
 *   jelly -b <dir> -j cg.json <entry>           # 先产出调用图
 *   node tools/heat-analysis/index.mjs -i cg.json -r <dir> -o heat.json
 *
 * 依赖：复用 jelly 根目录 node_modules 的 @babel/parser、@babel/traverse、commander。
 */
import {readFileSync, writeFileSync} from "node:fs";
import {readFile} from "node:fs/promises";
import {resolve} from "node:path";
import {parse} from "@babel/parser";
import _traverse from "@babel/traverse";
import {Command} from "commander";

const traverse = _traverse.default ?? _traverse;

// ---------------- 位置串 ----------------
// jelly 格式: "fileIndex:startLine:startCol(1-idx):endLine:endCol(1-idx)"，列序列化时 +1。
function parseLoc(str) {
    const parts = str.split(":");
    const fileIndex = Number(parts[0]);
    if (parts[1] === "?" || parts[1] === undefined) return {fileIndex};
    return {
        fileIndex,
        start: {line: Number(parts[1]), column: Number(parts[2]) - 1},
        end: {line: Number(parts[3]), column: Number(parts[4]) - 1},
    };
}

function cmpLC(a, b) {
    return a.line !== b.line ? a.line - b.line : a.column - b.column;
}

// ---------------- callIdx -> 所属函数 index ----------------
// 简化移植自 jelly src/misc/util.ts:mapCallsToFunctions：找包含调用点 start 的最内层函数。
function mapCallsToFunctions(cg) {
    const byFile = cg.files.map(() => ({fns: [], calls: []}));
    for (const [idx, loc] of Object.entries(cg.functions)) {
        const p = parseLoc(loc);
        if (!p.start) continue;
        byFile[p.fileIndex].fns.push({index: Number(idx), start: p.start, end: p.end});
    }
    for (const [idx, loc] of Object.entries(cg.calls)) {
        const p = parseLoc(loc);
        if (!p.start) continue;
        byFile[p.fileIndex].calls.push({index: Number(idx), start: p.start, end: p.end});
    }
    const ret = new Map();
    let scanned = 0, matched = 0;
    for (const {fns, calls} of byFile) {
        for (const call of calls) {
            scanned++;
            let best;
            for (const fn of fns) {
                if (cmpLC(fn.start, call.start) <= 0 && cmpLC(call.start, fn.end) <= 0) {
                    if (!best || cmpLC(fn.end, best.end) < 0) best = fn;
                }
            }
            if (best) {
                ret.set(call.index, best.index);
                matched++;
            }
        }
    }
    return {call2fun: ret, scanned, matched};
}

// ---------------- 入口集 S ----------------
// 移植自 jelly src/output/compare.ts:298-307：每文件 start.line===1 && column===0 且跨度最长者 = 模块函数。
function identifyEntries(cg, entryMode) {
    const fileToMod = [];
    for (const [idx, loc] of Object.entries(cg.functions)) {
        const p = parseLoc(loc);
        if (!p.start || p.start.line !== 1 || p.start.column !== 0) continue;
        const prev = fileToMod[p.fileIndex];
        if (!prev || cmpLC(p.end, prev.end) > 0) fileToMod[p.fileIndex] = {index: Number(idx), end: p.end};
    }
    const entryFileSet = new Set();
    if (entryMode === "entries") {
        const pathToIndex = new Map(cg.files.map((f, i) => [f, i]));
        for (const e of cg.entries ?? []) {
            const fi = pathToIndex.get(e);
            if (fi !== undefined) entryFileSet.add(fi);
        }
    } else {
        cg.files.forEach((f, i) => {
            if (!/\bnode_modules\//.test(f)) entryFileSet.add(i);
        });
    }
    const S = new Set();
    for (const fi of entryFileSet) {
        const m = fileToMod[fi];
        if (m) S.add(m.index);
    }
    return S;
}

// 识别每个文件的合成模块函数（:1 顶层伪函数）—— require/import 目标，不作为调用边 callee。
function identifyModuleFuns(cg) {
    const s = new Set();
    for (const [idx, loc] of Object.entries(cg.functions)) {
        const p = parseLoc(loc);
        if (p.start && p.start.line === 1 && p.start.column === 0) s.add(Number(idx));
    }
    return s;
}

// ---------------- 从入口沿 fun2fun 的可达性 ----------------
function computeReachable(cg, S) {
    const adj = new Map();
    for (const [a, b] of cg.fun2fun) {
        let l = adj.get(a);
        if (!l) adj.set(a, (l = []));
        l.push(b);
    }
    const seen = new Set(S);
    const Q = [...S];
    while (Q.length) {
        const a = Q.pop();
        for (const b of adj.get(a) ?? []) if (!seen.has(b)) {
            seen.add(b);
            Q.push(b);
        }
    }
    return seen;
}

// ---------------- babel 解析 + 调用点循环深度 ----------------
const CALL_TYPES = new Set(["CallExpression", "NewExpression", "OptionalCallExpression"]);
const LOOP_TYPES = new Set(["ForStatement", "ForInStatement", "ForOfStatement", "WhileStatement", "DoWhileStatement"]);
const FUNC_TYPES = new Set([
    "FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression",
    "ClassMethod", "ObjectMethod", "ClassPrivateMethod",
]);

async function computeLoopDepths(cg, basedir, opts) {
    const callsByFile = cg.files.map(() => new Map());
    let totalCalls = 0;
    for (const [idx, loc] of Object.entries(cg.calls)) {
        const p = parseLoc(loc);
        if (!p.start) continue;
        totalCalls++;
        callsByFile[p.fileIndex].set(`${p.start.line}:${p.start.column}`, Number(idx));
    }

    const loopDepthByCall = new Map();
    let filesParsed = 0, filesSkipped = 0;

    for (let fileIndex = 0; fileIndex < cg.files.length; fileIndex++) {
        const relFile = cg.files[fileIndex];
        if (!opts.includeDeps && /\bnode_modules\//.test(relFile)) {
            filesSkipped++;
            continue;
        }
        const fileMap = callsByFile[fileIndex];
        if (!fileMap.size) continue;

        let code;
        try {
            code = await readFile(resolve(basedir, relFile), "utf8");
        } catch {
            continue;
        }
        let ast;
        try {
            ast = parse(code, {
                sourceType: "unambiguous",
                allowReturnOutsideFunction: true,
                allowImportExportEverywhere: true,
                errorRecovery: true,
                plugins: ["typescript", "jsx", "decorators-legacy"],
            });
        } catch {
            continue;
        }
        filesParsed++;

        traverse(ast, {
            enter(path) {
                if (!CALL_TYPES.has(path.node.type) || !path.node.loc) return;
                const s = path.node.loc.start;
                const callIdx = fileMap.get(`${s.line}:${s.column}`);
                if (callIdx === undefined) return;
                let depth = 0;
                for (let p = path.parentPath; p; p = p.parentPath) {
                    if (LOOP_TYPES.has(p.node.type)) depth++;
                    else if (FUNC_TYPES.has(p.node.type)) break;
                }
                loopDepthByCall.set(callIdx, depth);
            },
        });
    }
    return {loopDepthByCall, totalCalls, filesParsed, filesSkipped};
}

// ---------------- 边权聚合：w(c,f) = Σ callsiteW(s)·prob(s,f) ----------------
// callsiteW(s) = loopWeight^depth（嵌套循环期望经过次数 = 各层次数之积；depth=0 时为 1）。
// prob(s,f) = 1/|targets(s)|（多目标 callsite 概率分布，和为 1）。
function buildWeightedEdges(cg, call2caller, loopDepthByCall, loopWeight, moduleFuns) {
    const targetCount = new Map();
    for (const [callIdx] of cg.call2fun) targetCount.set(callIdx, (targetCount.get(callIdx) ?? 0) + 1);
    const weighted = new Map();
    let used = 0, skippedRequire = 0;
    for (const [callIdx, calleeIdx] of cg.call2fun) {
        if (moduleFuns.has(calleeIdx)) { skippedRequire++; continue; }
        const callerIdx = call2caller.get(callIdx);
        if (callerIdx === undefined) continue;
        const depth = loopDepthByCall.get(callIdx) ?? 0;
        const callsiteW = loopWeight ** depth;
        const prob = 1 / (targetCount.get(callIdx) ?? 1);
        const w = callsiteW * prob;
        let m = weighted.get(callerIdx);
        if (!m) weighted.set(callerIdx, (m = new Map()));
        m.set(calleeIdx, (m.get(calleeIdx) ?? 0) + w);
        used++;
    }
    return {weighted, used, skippedRequire};
}

// ---------------- 期望调用次数：v = base + W·v ----------------
function callcount(n, weighted, S, eps, maxIter) {
    const base = new Array(n).fill(0);
    for (const s of S) base[s] = 1; // 入口每次执行 = 1
    let v = new Array(n).fill(0);
    let iters = 0, converged = false, diff = 0;
    for (; iters < maxIter; iters++) {
        const next = base.slice();
        for (const [a, m] of weighted) {
            const va = v[a];
            if (!va) continue;
            for (const [b, w] of m) next[b] += va * w;
        }
        diff = 0;
        for (let i = 0; i < n; i++) diff += Math.abs(next[i] - v[i]);
        v = next;
        if (diff < eps) { converged = true; break; }
    }
    return {v, iters, converged, diff};
}

// ---------------- 主流程 ----------------
async function main() {
    const program = new Command();
    program
        .option("-i, --input <path>", "jelly call graph JSON")
        .option("-r, --root <dir>", "source root dir (basedir)", ".")
        .option("-o, --output <path>", "output report JSON", "heat-report.json")
        .option("--loop-weight <n>", "callsite weight when inside a loop (flat, not exponential)", "10")
        .option("--eps <n>", "convergence threshold (L1 residual)", "1e-6")
        .option("--max-iter <n>", "max iterations (caps recursive divergence)", "200")
        .option("--entry-mode <mode>", "entries | all-roots", "entries")
        .option("--top <n>", "print top N to stdout", "25")
        .option("--csv <path>", "also write CSV")
        .option("--include-deps", "also parse node_modules for loop depth", false);
    program.parse(process.argv);
    const o = program.opts();
    const loopWeight = Number(o.loopWeight);

    const cg = JSON.parse(readFileSync(o.input, "utf8"));
    const n = Object.keys(cg.functions).length;
    const nCalls = Object.keys(cg.calls).length;
    console.error(`[load] ${n} functions, ${cg.fun2fun.length} fun2fun, ${cg.call2fun.length} call2fun, ${nCalls} call sites, ${(cg.entries ?? []).length} entries`);

    const S = identifyEntries(cg, o.entryMode);
    console.error(`[entry] mode=${o.entryMode} → ${S.size} entry functions`);

    const {call2fun: call2caller, scanned, matched} = mapCallsToFunctions(cg);
    console.error(`[map] call→function: ${matched}/${scanned} matched`);

    const {loopDepthByCall, totalCalls, filesParsed, filesSkipped} =
        await computeLoopDepths(cg, resolve(o.root), {includeDeps: o.includeDeps});
    const depthDist = new Map();
    for (const d of loopDepthByCall.values()) depthDist.set(d, (depthDist.get(d) ?? 0) + 1);
    console.error(`[ast] loop depth for ${loopDepthByCall.size}/${totalCalls} call sites (${filesParsed} files parsed, ${filesSkipped} deps skipped); histogram: ${[...depthDist.entries()].sort((a, b) => a[0] - b[0]).map(([d, c]) => `d${d}=${c}`).join(" ")}`);

    const moduleFuns = identifyModuleFuns(cg);
    const {weighted, used, skippedRequire} = buildWeightedEdges(cg, call2caller, loopDepthByCall, loopWeight, moduleFuns);
    console.error(`[weight] ${used} call edges, ${skippedRequire} require/import edges skipped (loopWeight=${loopWeight}, callsiteW=loopWeight^depth)`);

    const {v, iters, converged, diff} = callcount(n, weighted, S, Number(o.eps), Number(o.maxIter));
    console.error(`[callcount] ${converged ? "converged" : "CAPPED at maxIter"} in ${iters} iters (L1 residual=${diff.toExponential(2)})`);

    const reachable = computeReachable(cg, S);
    const inDeg = new Array(n).fill(0);
    for (const [, m] of weighted) for (const b of m.keys()) inDeg[b]++;
    const maxDepth = new Array(n).fill(0);
    for (const [callIdx, calleeIdx] of cg.call2fun) {
        const d = loopDepthByCall.get(callIdx) ?? 0;
        if (d > maxDepth[calleeIdx]) maxDepth[calleeIdx] = d;
    }

    const rows = Object.entries(cg.functions).map(([idx, loc]) => {
        const i = Number(idx);
        const p = parseLoc(loc);
        return {
            index: i,
            file: p.fileIndex !== undefined ? cg.files[p.fileIndex] : "?",
            line: p.start?.line,
            startLine: p.start?.line,
            endLine: p.end?.line,
            loc,
            calls: v[i], // 期望调用次数（入口每执行一次）
            inDegree: inDeg[i],
            maxLoopDepth: maxDepth[i],
            isEntry: S.has(i),
            isReachable: reachable.has(i),
        };
    });
    rows.sort((a, b) => b.calls - a.calls);
    rows.forEach((r, i) => {
        r.rank = i + 1;
    });

    const report = {
        model: "expected-call-count",
        params: {
            loopWeight, entryMode: o.entryMode, eps: Number(o.eps),
            maxIter: Number(o.maxIter), functions: n, entries: S.size,
            reachable: reachable.size, iterations: iters, converged, residual: diff,
        },
        functions: rows.map(r => ({
            rank: r.rank, calls: r.calls, index: r.index, file: r.file, line: r.line,
            loc: r.loc, inDegree: r.inDegree, maxLoopDepth: r.maxLoopDepth,
            isEntry: r.isEntry, isReachable: r.isReachable,
        })),
    };
    writeFileSync(o.output, JSON.stringify(report, null, 2));
    console.error(`[output] ${o.output}`);

    if (o.csv) {
        const lines = ["rank,calls,file,startLine,endLine,inDegree,maxLoopDepth,isEntry,isReachable"];
        for (const r of rows) lines.push(`${r.rank},${r.calls},"${r.file}",${r.startLine ?? ""},${r.endLine ?? ""},${r.inDegree},${r.maxLoopDepth},${r.isEntry},${r.isReachable}`);
        writeFileSync(o.csv, lines.join("\n"));
        console.error(`[output] ${o.csv}`);
    }

    const top = Number(o.top);
    console.log(`\nTop ${Math.min(top, rows.length)} by expected call count  (entryMode=${o.entryMode}, loopWeight=${loopWeight}, ${converged ? "converged" : "CAPPED"} @${iters} iters)`);
    console.log("rank      calls    inDeg  loop  entry  reach  file:line");
    for (const r of rows.slice(0, top)) {
        const cstr = r.calls >= 1000 ? r.calls.toExponential(3) : r.calls.toFixed(2);
        console.log(
            `${String(r.rank).padStart(4)}   ${cstr.padStart(9)}   ${String(r.inDegree).padStart(5)}   ${String(r.maxLoopDepth).padStart(4)}   ${r.isEntry ? "ENTRY" : "    "}   ${r.isReachable ? "Y" : "n"}    ${r.file}:${r.line ?? "?"}`,
        );
    }
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
