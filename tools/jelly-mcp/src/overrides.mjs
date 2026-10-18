/**
 * 会话级调用边 override 缓存。
 *
 * 第一阶段语义(tools 层):override 作用于"从 Jelly 调用图重建的有效图",即 view_callgraph /
 * get_callers / get_callees / 热度计算所看到的调用边。这些能力都在 tools 层基于重建图计算,
 * 因此 override 能立即、一致地生效。
 *
 * 第一阶段限制(诚实标注):force_include / force_exclude 不会影响 Jelly 自身的 points-to、
 * 数据流与可达包分析 —— 那需要把先验注入 Jelly 求解器,属于第二阶段(配合内核改动)。因此
 * query_dataflow 的 subset 级结果仍反映 Jelly 原始分析,不受 override 影响。
 *
 * override 身份:(callsite locKey, callee locKey),与 Jelly 临时 index 无关,跨重分析稳定
 * (前提是源码行列未变,见 loc.mjs 限制说明)。
 */

/**
 * @typedef {"include"|"exclude"} OverrideMode
 */

export class CallEdgeOverrides {
    constructor() {
        // callsiteLocKey -> Map<calleeLocKey, OverrideMode>
        this._map = new Map();
    }

    /** 设置一条 override(覆盖同 key 旧值)。返回旧 mode(若有)。 */
    set(callsiteLocKey, calleeLocKey, mode) {
        if (mode !== "include" && mode !== "exclude")
            throw new Error(`mode must be "include" or "exclude", got: ${mode}`);
        let inner = this._map.get(callsiteLocKey);
        if (!inner) this._map.set(callsiteLocKey, (inner = new Map()));
        const prev = inner.get(calleeLocKey);
        inner.set(calleeLocKey, mode);
        return prev;
    }

    /** 删除指定 override(不是创建 exclude)。返回是否删除成功。 */
    delete(callsiteLocKey, calleeLocKey) {
        const inner = this._map.get(callsiteLocKey);
        if (!inner) return false;
        const ok = inner.delete(calleeLocKey);
        if (ok && inner.size === 0) this._map.delete(callsiteLocKey);
        return ok;
    }

    clear() {
        this._map.clear();
    }

    get(callsiteLocKey, calleeLocKey) {
        return this._map.get(callsiteLocKey)?.get(calleeLocKey);
    }

    /** 是否存在任意 override。 */
    get size() {
        let n = 0;
        for (const inner of this._map.values()) n += inner.size;
        return n;
    }

    /** 列出全部 override(稳定排序,便于展示)。 */
    list() {
        const out = [];
        for (const [callsite, inner] of this._map)
            for (const [callee, mode] of inner) out.push({callsite, callee, mode});
        out.sort((a, b) =>
            a.callsite !== b.callsite ? a.callsite.localeCompare(b.callsite) : a.callee.localeCompare(b.callee));
        return out;
    }

    /**
     * 对模型计算"有效 call2fun"边集合,并标注每条边的来源。
     * @param {object} model buildCallGraphModel 的结果
     * @returns {{
     *   edges: Array<{callIndex:number, funIndex:number, source:"base"|"include"|"exclude-removed"}>,
     *   call2funByCall: Map<number, Set<number>>,
     *   unresolvedIncludes: Array<{callsiteLocKey:string, calleeLocKey:string, reason:string}>,
     *   stats: {base:number, included:number, excluded:number}
     * }}
     */
    effectiveEdges(model) {
        const includedByCall = new Map(); // callIndex -> Set<funIndex>(override 加入)
        const excludedByCall = new Map(); // callIndex -> Set<funIndex>(override 排除)
        const unresolvedIncludes = [];

        for (const {callsite, callee, mode} of this.list()) {
            const callIndex = model.callByLocKey.get(callsite);
            const funIndex = model.funByLocKey.get(callee);
            if (callIndex === undefined || funIndex === undefined) {
                unresolvedIncludes.push({
                    callsiteLocKey: callsite,
                    calleeLocKey: callee,
                    reason: callIndex === undefined ? "callsite not found in current analysis" : "callee function not found in current analysis",
                });
                continue;
            }
            const target = mode === "include" ? includedByCall : excludedByCall;
            let set = target.get(callIndex);
            if (!set) target.set(callIndex, (set = new Set()));
            set.add(funIndex);
        }

        const call2funByCall = new Map();
        const edges = [];
        let base = 0, included = 0, excluded = 0;

        // 1) 基础边(过滤被 exclude 的)
        for (const [callIndex, callees] of model.call2funByCall) {
            const ex = excludedByCall.get(callIndex);
            const acc = new Set();
            for (const funIndex of callees) {
                if (ex?.has(funIndex)) {
                    excluded++;
                    edges.push({callIndex, funIndex, source: "exclude-removed"});
                    continue;
                }
                acc.add(funIndex);
                edges.push({callIndex, funIndex, source: "base"});
                base++;
            }
            call2funByCall.set(callIndex, acc);
        }

        // 2) 人工 include 的边(避免与基础边重复)
        for (const [callIndex, funIndices] of includedByCall) {
            let acc = call2funByCall.get(callIndex);
            if (!acc) call2funByCall.set(callIndex, (acc = new Set()));
            for (const funIndex of funIndices) {
                if (acc.has(funIndex)) continue;
                acc.add(funIndex);
                edges.push({callIndex, funIndex, source: "include"});
                included++;
            }
        }

        return {edges, call2funByCall, unresolvedIncludes, stats: {base, included, excluded}};
    }
}
