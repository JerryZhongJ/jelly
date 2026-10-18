/**
 * 位置与稳定引用工具(基于 Jelly call graph JSON 的位置串)。
 *
 * Jelly loc 串格式: "fileIndex:startLine:startColumn(1-based):endLine:endColumn(1-based)"
 * (见 src/misc/util.ts SourceLocationsToJSON.makeLocString,序列化时 column 已 +1)。
 *
 * 稳定性说明:Jelly 每次分析中 function/call 的整数 index 会变,但"文件路径 + 源码范围"稳定。
 * 因此对外 SourceRef 不使用 index,而是用文件相对路径 + 1-based 行列。locKey 用文件名替换 fileIndex
 * 后的 loc 串,作为会话内唯一身份。
 *
 * 注意(第一阶段限制):若被分析源码在两次分析之间被编辑,行列会漂移,旧 ref 将解析为 unresolved。
 * 基于源码内容指纹的重新绑定属于第二阶段(需配合 Jelly 内核暴露 AST 信息)。
 */

/**
 * 解析 Jelly loc 串为带 fileIndex 的位置(内部 column 还原为 0-based,便于区间运算)。
 * 无位置的记录(如 "3:?:?:?:?")只返回 {fileIndex}。
 */
export function parseRawLoc(str) {
    const parts = String(str).split(":");
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

/** 两个区间位置是否起点相同(用于 callsite 匹配)。 */
export function sameStart(a, b) {
    return a && b && a.start.line === b.start.line && a.start.column === b.column ? true :
        a && b && a.start.line === b.start.line && a.start.column === b.start.column;
}

/** 构造稳定 locKey:用文件名替代 fileIndex,列保持 1-based(与 Jelly loc 串一致)。 */
export function locKey(fileNames, parsed) {
    const file = fileNames[parsed.fileIndex];
    if (!parsed.start) return `${file}:?:?:?:?`;
    const {start, end} = parsed;
    return `${file}:${start.line}:${start.column + 1}:${end.line}:${end.column + 1}`;
}

/**
 * 对外 SourceRef:稳定的函数/调用点/表达式引用。
 * column 对外统一 1-based(与 Jelly loc 串一致),end 为半开区间对应的源码结束位置。
 */
export function toSourceRef(kind, fileNames, parsed, extra = {}) {
    const file = fileNames[parsed.fileIndex];
    const ref = {kind, file};
    if (parsed.start) {
        ref.range = {
            start: {line: parsed.start.line, column: parsed.start.column + 1},
            end: {line: parsed.end.line, column: parsed.end.column + 1},
        };
        ref.locKey = locKey(fileNames, parsed);
    } else {
        ref.locKey = `${file}:?:?:?:?`;
    }
    return {...ref, ...extra};
}

/** 比较两个行/列点(0-based 内部用)。 */
export {cmpLC};

/** 判断 inner 的起点是否落在 [outer.start, outer.end] 内。 */
export function contains(outer, inner) {
    return cmpLC(outer.start, inner.start) <= 0 && cmpLC(inner.start, outer.end) <= 0;
}
