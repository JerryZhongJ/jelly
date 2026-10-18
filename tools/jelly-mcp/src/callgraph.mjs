/**
 * 从 Jelly call graph JSON 重建内存调用图模型。
 *
 * 模型以稳定 locKey 为主要身份,而非 Jelly 的临时整数 index。原始 index 仍保留以便与
 * fun2fun/call2fun 边数组对齐。
 *
 * 重建内容:
 *  - functions / calls: index -> {locKey, file, range}
 *  - funByLocKey / callByLocKey: locKey -> index(用于解析人工引用)
 *  - call2funRaw / fun2funRaw: 原始边(以 index 表示)
 *  - call2funByCall: callIndex -> Set<funIndex>(callsite -> 多 callee)
 *  - call2caller: callIndex -> caller funIndex(callsite 所属函数)
 *  - moduleFuns: 合成模块函数集合(start.line===1 && column===0),require/import 目标,不作普通 callee
 *  - entries: 入口函数 index 集合(基于 cg.entries 或非 node_modules 文件)
 */
import {parseRawLoc, locKey, cmpLC, contains} from "./loc.mjs";

/**
 * 计算 callsite -> 所属函数的最内层包含函数。
 * 参考实现:src/misc/util.ts mapCallsToFunctions(线性对数扫描)。
 * 这里采用直观正确的 O(calls*funs) 实现,规模在原型阶段足够;后续可替换为扫描版。
 */
function mapCallsToFunctions(functions, calls) {
    const call2fun = new Map();
    for (const [callIndex, call] of calls) {
        if (!call.start) continue;
        let best;
        for (const [funIndex, fun] of functions) {
            if (!fun.start) continue;
            if (contains(fun, call) && (!best || cmpLC(fun.end, best.end) < 0)) best = {funIndex, end: fun.end};
        }
        if (best) call2fun.set(callIndex, best.funIndex);
    }
    return call2fun;
}

/** 识别合成模块函数:每文件 start.line===1 && column===0 且跨度最长者。 */
function identifyModuleFuns(functions) {
    const moduleFuns = new Set();
    const fileToMod = new Map();
    for (const [funIndex, fun] of functions) {
        if (!fun.start || fun.start.line !== 1 || fun.start.column !== 0) continue;
        const prev = fileToMod.get(fun.fileIndex);
        if (!prev || cmpLC(fun.end, prev.end) > 0) fileToMod.set(fun.fileIndex, {funIndex, end: fun.end});
    }
    for (const {funIndex} of fileToMod.values()) moduleFuns.add(funIndex);
    return moduleFuns;
}

/** 识别入口函数集合(基于 cg.entries 指定的入口文件,或所有非 node_modules 文件)。 */
function identifyEntries(cg, functions, moduleFuns) {
    const fileToMod = new Map();
    for (const funIndex of moduleFuns) {
        const fun = functions.get(funIndex);
        if (fun?.start) fileToMod.set(fun.fileIndex, funIndex);
    }
    const entryFiles = new Set();
    if (Array.isArray(cg.entries) && cg.entries.length) {
        const pathToIndex = new Map(cg.files.map((f, i) => [f, i]));
        for (const e of cg.entries) {
            const fi = pathToIndex.get(e);
            if (fi !== undefined) entryFiles.add(fi);
        }
    } else {
        cg.files.forEach((f, i) => {
            if (!/\bnode_modules\//.test(f)) entryFiles.add(i);
        });
    }
    const entries = new Set();
    for (const fi of entryFiles) {
        const m = fileToMod.get(fi);
        if (m !== undefined) entries.add(m);
    }
    return entries;
}

/**
 * 重建调用图模型。
 * @param {object} cg Jelly call graph JSON(callgraph.ts 格式)
 * @returns {object} 内存模型
 */
export function buildCallGraphModel(cg) {
    const fileNames = cg.files ?? [];
    const functions = new Map(); // index -> {locKey, fileIndex, file, start, end}
    const calls = new Map();
    const funByLocKey = new Map();
    const callByLocKey = new Map();

    for (const [idx, loc] of Object.entries(cg.functions ?? {})) {
        const i = Number(idx);
        const p = parseRawLoc(loc);
        const entry = {
            locKey: locKey(fileNames, p),
            fileIndex: p.fileIndex,
            file: fileNames[p.fileIndex],
            start: p.start,
            end: p.end,
        };
        functions.set(i, entry);
        if (p.start) funByLocKey.set(entry.locKey, i);
    }
    for (const [idx, loc] of Object.entries(cg.calls ?? {})) {
        const i = Number(idx);
        const p = parseRawLoc(loc);
        const entry = {
            locKey: locKey(fileNames, p),
            fileIndex: p.fileIndex,
            file: fileNames[p.fileIndex],
            start: p.start,
            end: p.end,
        };
        calls.set(i, entry);
        if (p.start) callByLocKey.set(entry.locKey, i);
    }

    const fun2funRaw = (cg.fun2fun ?? []).map(([a, b]) => [Number(a), Number(b)]);
    const call2funRaw = (cg.call2fun ?? []).map(([a, b]) => [Number(a), Number(b)]);

    const call2funByCall = new Map();
    for (const [callIndex, funIndex] of call2funRaw) {
        if (!calls.has(callIndex) || !functions.has(funIndex)) continue;
        const set = call2funByCall.get(callIndex);
        if (set) set.add(funIndex);
        else call2funByCall.set(callIndex, new Set([funIndex]));
    }

    const call2caller = mapCallsToFunctions(functions, calls);
    const moduleFuns = identifyModuleFuns(functions);
    const entries = identifyEntries(cg, functions, moduleFuns);

    return {
        fileNames,
        functions,
        calls,
        funByLocKey,
        callByLocKey,
        fun2funRaw,
        call2funRaw,
        call2funByCall,
        call2caller,
        moduleFuns,
        entries,
        meta: {
            time: cg.time,
            ignoreDependencies: cg.ignoreDependencies,
            includePackages: cg.includePackages,
            excludePackages: cg.excludePackages,
        },
    };
}

/**
 * 汇总统计(用于 diagnostics/状态展示)。
 */
export function summarize(model) {
    return {
        files: model.fileNames.length,
        functions: model.functions.size,
        calls: model.calls.size,
        fun2fun: model.fun2funRaw.length,
        call2fun: model.call2funRaw.length,
        entries: model.entries.size,
        moduleFuns: model.moduleFuns.size,
    };
}
