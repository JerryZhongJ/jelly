/**
 * 热度估计模型(第一阶段,tools 层)。
 *
 * 模型:每个函数的"热度"= 入口每执行一次时,该函数的期望被调用次数。
 *
 *   H(f) = override(f)                                  若 f 被 set_hot_value 硬覆盖(固定边界)
 *   H(f) = base(f) + Σ_{callsite s: caller(s)->f} H(caller(s)) · E(s) · P(s,f)   否则
 *
 *     base(f)        : 入口函数默认 1,其余 0
 *     E(s)           : callsite s 在 caller 每次执行中的期望执行次数(set_exec_expt 覆盖;
 *                      否则 loopWeight^loopDepth,无 loop 数据时为 1)
 *     P(s,f)         : callsite s 一次执行命中 callee f 的概率(set_target_prob 覆盖;
 *                      否则有效 targets 平分概率;显式概率和 ≤ 1,剩余质量平分给未设置 target)
 *
 * 已确认语义:set_hot_value 为"最终结果硬覆盖",被覆盖函数自身固定为该值,其对下游的出站
 * 贡献也使用该固定值(继续传播),入站贡献被忽略。
 *
 * 收敛性(第一阶段):递归正权环可能发散。这里用迭代 + 残差判断收敛,出现非有限值即标 divergent,
 * 达到 maxIter 未收敛且未发散标 capped(近临界)。基于 SCC 谱半径的精确 finite/divergent/
 * indeterminate 分类属于第二阶段增强。
 */
import {readFile} from "node:fs/promises";
import {resolve} from "node:path";
import {parse} from "@babel/parser";
import _traverse from "@babel/traverse";

const traverse = _traverse.default ?? _traverse;

const CALL_TYPES = new Set(["CallExpression", "NewExpression", "OptionalCallExpression"]);
const LOOP_TYPES = new Set(["ForStatement", "ForInStatement", "ForOfStatement", "WhileStatement", "DoWhileStatement"]);
const FUNC_TYPES = new Set([
    "FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression",
    "ClassMethod", "ObjectMethod", "ClassPrivateMethod",
]);

/**
 * 用 Babel 重新解析源码,计算每个 callsite 的词法循环嵌套深度。
 * 迁移自 tools/heat-analysis/index.mjs computeLoopDepths。
 * @param {object} model buildCallGraphModel 结果
 * @param {string} rootDir 源码根目录(basedir)
 * @param {{includeDeps?: boolean}} opts
 * @returns {Promise<{loopDepthByCall: Map<number, number>, filesParsed: number, filesSkipped: number, matched: number, total: number}>}
 */
export async function computeLoopDepths(model, rootDir, opts = {}) {
    const callsByFile = model.fileNames.map(() => new Map());
    let total = 0;
    for (const [idx, entry] of model.calls) {
        if (!entry.start) continue;
        total++;
        callsByFile[entry.fileIndex].set(`${entry.start.line}:${entry.start.column}`, idx);
    }

    const loopDepthByCall = new Map();
    let filesParsed = 0, filesSkipped = 0, matched = 0;

    for (let fileIndex = 0; fileIndex < model.fileNames.length; fileIndex++) {
        const relFile = model.fileNames[fileIndex];
        if (!opts.includeDeps && /\bnode_modules\//.test(relFile)) {
            filesSkipped++;
            continue;
        }
        const fileMap = callsByFile[fileIndex];
        if (!fileMap.size) continue;

        let code;
        try {
            code = await readFile(resolve(rootDir, relFile), "utf8");
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
                matched++;
                let depth = 0;
                for (let p = path.parentPath; p; p = p.parentPath) {
                    if (LOOP_TYPES.has(p.node.type)) depth++;
                    else if (FUNC_TYPES.has(p.node.type)) break;
                }
                loopDepthByCall.set(callIdx, depth);
            },
        });
    }
    return {loopDepthByCall, filesParsed, filesSkipped, matched, total};
}

/**
 * 在有效调用边上聚合权重 weighted[caller][callee] = Σ_s E(s)·P(s,f)。
 * 同时校验 target 概率约束(显式概率非负、有限、和 ≤ 1)。
 */
function buildWeighted(model, effective, assumptions, loopDepthByCall, params) {
    const {execExpt, targetProb} = assumptions;
    const weighted = new Map();
    const probReports = [];

    for (const [callIndex, targets] of effective.call2funByCall) {
        const callerIndex = model.call2caller.get(callIndex);
        if (callerIndex === undefined) continue;
        const callEntry = model.calls.get(callIndex);
        const callLocKey = callEntry?.locKey;

        // 跳过 require/import 目标(合成模块函数),它们不是普通调用
        const validTargets = [...targets].filter(f => !model.moduleFuns.has(f));
        if (!validTargets.length) continue;

        // 执行期望 E
        const depth = loopDepthByCall.get(callIndex) ?? 0;
        const E = execExpt.has(callLocKey) ? execExpt.get(callLocKey) : params.loopWeight ** depth;

        // 目标概率 P
        const explicit = new Map();
        let sumExplicit = 0;
        const probMap = callLocKey ? targetProb.get(callLocKey) : undefined;
        if (probMap) {
            for (const [calleeLocKey, p] of probMap) {
                if (!Number.isFinite(p) || p < 0)
                    throw new Error(`Invalid target probability ${p} at callsite ${callLocKey}`);
                const fIdx = model.funByLocKey.get(calleeLocKey);
                if (fIdx === undefined || !targets.has(fIdx)) continue; // 引用失效或不在有效 target 中
                explicit.set(fIdx, p);
                sumExplicit += p;
            }
        }
        if (sumExplicit > 1 + 1e-9)
            throw new Error(`Target probability sum ${sumExplicit} > 1 at callsite ${callLocKey}`);

        const unscaled = validTargets.length - explicit.size;
        const remaining = 1 - sumExplicit;
        const each = unscaled > 0 ? remaining / unscaled : 0;

        for (const f of validTargets) {
            const P = explicit.has(f) ? explicit.get(f) : each;
            const w = E * P;
            if (!w) continue;
            let m = weighted.get(callerIndex);
            if (!m) weighted.set(callerIndex, (m = new Map()));
            m.set(f, (m.get(f) ?? 0) + w);
        }

        probReports.push({callLocKey, execExpt: E, loopDepth: depth, targets: validTargets.length, explicit: explicit.size, sumExplicit, unscaled, remaining});
    }
    return {weighted, probReports};
}

/**
 * 迭代求解 H = base + W·H,带硬覆盖边界。
 * @param {number} n 函数 index 上界(maxIndex+1)
 * @param {Map} weighted caller->(callee->weight)
 * @param {Float64Array} base 入口基值
 * @param {Map<number, number>} boundValue 硬覆盖值
 */
function solve(n, weighted, base, boundValue, eps, maxIter) {
    const isBound = i => boundValue.has(i);
    const v = new Float64Array(n);
    let iterations = 0, converged = false, residual = 0, divergent = false;

    for (; iterations < maxIter; iterations++) {
        const next = new Float64Array(n);
        for (let i = 0; i < n; i++) next[i] = isBound(i) ? boundValue.get(i) : base[i];
        for (const [a, m] of weighted) {
            if (a >= n) continue;
            const va = isBound(a) ? boundValue.get(a) : v[a];
            if (!va) continue;
            for (const [b, w] of m) {
                if (b >= n || isBound(b)) continue;
                next[b] += va * w;
            }
        }
        if (![...next].every(Number.isFinite)) {
            divergent = true;
            break;
        }
        residual = 0;
        for (let i = 0; i < n; i++) residual += Math.abs(next[i] - v[i]);
        v.set(next);
        if (residual < eps) {
            converged = true;
            break;
        }
    }
    return {v, iterations, converged, residual, divergent, capped: !converged && !divergent};
}

/**
 * 计算热度。
 * @param {object} model
 * @param {object} effective overrides.effectiveEdges 的结果
 * @param {object} assumptions {functionBaseOverride:Map<locKey,number>, execExpt:Map, targetProb:Map}
 * @param {object} params {loopWeight, eps, maxIter}
 * @param {Map<number, number>} loopDepthByCall 可选,来自 computeLoopDepths
 */
export function computeHeat(model, effective, assumptions, params, loopDepthByCall = new Map()) {
    const {functionBaseOverride} = assumptions;
    const {weighted, probReports} = buildWeighted(model, effective, assumptions, loopDepthByCall, params);

    const maxIndex = [...model.functions.keys()].reduce((a, b) => Math.max(a, b), -1);
    const n = maxIndex + 1;

    const base = new Float64Array(n);
    for (let i = 0; i < n; i++) if (model.entries.has(i)) base[i] = 1;

    // 硬覆盖:set_hot_value 作为最终值固定边界
    const boundValue = new Map();
    for (const [locKey, value] of functionBaseOverride) {
        if (!Number.isFinite(value) || value < 0)
            throw new Error(`Invalid hot value ${value} for function ${locKey}`);
        const fIdx = model.funByLocKey.get(locKey);
        if (fIdx === undefined) continue; // 引用失效,跳过(由调用方报告 unresolved)
        boundValue.set(fIdx, value);
    }

    const {v, iterations, converged, residual, divergent, capped} =
        solve(n, weighted, base, boundValue, params.eps, params.maxIter);

    // 可达性:从 entries 沿有效 weighted 派生的 fun2fun
    const adj = new Map();
    for (const [a, m] of weighted) adj.set(a, [...m.keys()]);
    const reachable = new Set(model.entries);
    const stack = [...model.entries];
    while (stack.length) {
        const a = stack.pop();
        for (const b of adj.get(a) ?? []) if (!reachable.has(b)) {
            reachable.add(b);
            stack.push(b);
        }
    }

    // 入度 + 每 callee 的最大循环深度
    const inDegree = new Array(n).fill(0);
    const maxLoopDepth = new Array(n).fill(0);
    for (const [a, m] of weighted) {
        for (const b of m.keys()) inDegree[b]++;
    }
    for (const [callIndex, callees] of effective.call2funByCall) {
        const d = loopDepthByCall.get(callIndex) ?? 0;
        for (const f of callees) if (!model.moduleFuns.has(f) && d > maxLoopDepth[f]) maxLoopDepth[f] = d;
    }

    const perFunction = [];
    for (const [funIndex, entry] of model.functions) {
        const status = divergent && !Number.isFinite(v[funIndex]) ? "divergent"
            : divergent || capped ? "capped"
            : "finite";
        perFunction.push({
            locKey: entry.locKey,
            file: entry.file,
            line: entry.start?.line,
            startLine: entry.start?.line,
            endLine: entry.end?.line,
            hot: Number.isFinite(v[funIndex]) ? v[funIndex] : null,
            isBound: boundValue.has(funIndex),
            isEntry: model.entries.has(funIndex),
            isReachable: reachable.has(funIndex),
            isModuleFun: model.moduleFuns.has(funIndex),
            inboundContribution: boundValue.has(funIndex) ? null : Math.max(0, (v[funIndex] || 0) - base[funIndex]),
            inDegree: inDegree[funIndex] ?? 0,
            maxLoopDepth: maxLoopDepth[funIndex] ?? 0,
            status,
        });
    }
    perFunction.sort((a, b) => (b.hot ?? -Infinity) - (a.hot ?? -Infinity));
    perFunction.forEach((r, i) => {
        r.rank = i + 1;
    });

    return {
        model: "expected-call-count",
        status: divergent ? "divergent" : capped ? "capped" : "converged",
        params: {
            loopWeight: params.loopWeight,
            eps: params.eps,
            maxIter: params.maxIter,
            functions: model.functions.size,
            entries: model.entries.size,
            reachable: reachable.size,
            iterations,
            residual,
        },
        overrideStats: effective.stats,
        perFunction,
        assumptions: {
            hotValueOverrides: functionBaseOverride.size,
            execExptOverrides: assumptions.execExpt.size,
            targetProbCallsites: assumptions.targetProb.size,
        },
    };
}
