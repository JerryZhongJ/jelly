/**
 * Jelly 运行器:生成 call graph JSON。
 *
 * 两种模式:
 *  1) 直接加载已有 cg JSON 文件(便于用现有数据测试,且不依赖 Jelly 已安装);
 *  2) spawn `jelly`(或主项目编译产物 `node lib/main.js`)按入口生成 `-j <tmpfile>` 再读取。
 *
 * 安全:只读取源码与生成临时调用图文件;不启用会执行被分析程序的选项(如 --approx)。
 */
import {readFile, writeFile, mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join, resolve, isAbsolute} from "node:path";
import {spawn} from "node:child_process";

/** 检测可用的 jelly 可执行命令:优先 `jelly`,回退到主项目编译产物。 */
async function resolveJellyBin(repoRoot) {
    const candidates = [];
    candidates.push({cmd: "jelly", args: []});
    if (repoRoot) candidates.push({cmd: process.execPath, args: [join(repoRoot, "lib", "main.js")]});
    for (const c of candidates) {
        try {
            await runQuiet(c.cmd, ["--version"], 8000);
            return c;
        } catch { /* try next */ }
    }
    throw new Error("Could not find a usable jelly binary. Install @cs-au-dk/jelly globally or build the repo (`npm run build`).");
}

function runQuiet(cmd, args, timeout) {
    return new Promise((resolveP, reject) => {
        const p = spawn(cmd, args, {stdio: ["ignore", "pipe", "pipe"]});
        let done = false;
        const t = setTimeout(() => {
            if (!done) {
                done = true;
                p.kill("SIGKILL");
                reject(new Error("timeout"));
            }
        }, timeout);
        p.on("error", () => {
            if (done) return;
            done = true;
            clearTimeout(t);
            reject(new Error("spawn error"));
        });
        p.on("exit", code => {
            if (done) return;
            done = true;
            clearTimeout(t);
            code === 0 ? resolveP() : reject(new Error(`exit ${code}`));
        });
    });
}

/**
 * 加载 Jelly call graph JSON。
 * @param {{callgraphFile?: string, entryFiles?: string[], root?: string, repoRoot?: string, extraArgs?: string[]}} input
 * @returns {Promise<{cg: object, root: string, source: string}>}
 */
export async function loadCallGraph(input) {
    if (input.callgraphFile) {
        const cg = JSON.parse(await readFile(input.callgraphFile, "utf8"));
        return {cg, root: input.root ?? ".", source: `file:${input.callgraphFile}`};
    }

    if (!Array.isArray(input.entryFiles) || !input.entryFiles.length)
        throw new Error("Either callgraphFile or entryFiles must be provided");

    const root = input.root ?? process.cwd();
    const bin = await resolveJellyBin(input.repoRoot);
    const dir = await mkdtemp(join(tmpdir(), "jelly-mcp-"));
    const outFile = join(dir, "cg.json");
    try {
        const args = [
            ...bin.args,
            "-b", root,
            "-j", outFile,
            ...(input.extraArgs ?? []),
            ...input.entryFiles,
        ];
        await runCapture(bin.cmd, args, root);
        const cg = JSON.parse(await readFile(outFile, "utf8"));
        return {cg, root, source: `jelly:${bin.cmd}`};
    } finally {
        await rm(dir, {recursive: true, force: true});
    }
}

function runCapture(cmd, args, cwd) {
    return new Promise((resolveP, reject) => {
        const p = spawn(cmd, args, {cwd, stdio: ["ignore", "pipe", "pipe"]});
        let stderr = "";
        p.stderr.on("data", d => {
            stderr += d;
        });
        p.on("error", err => reject(err));
        p.on("exit", code => {
            if (code === 0) resolveP();
            else reject(new Error(`jelly exited with code ${code}\n${stderr.slice(-2000)}`));
        });
    });
}
