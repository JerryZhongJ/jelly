import {mkdtempSync, writeFileSync, rmSync} from "fs";
import {tmpdir} from "os";
import {join} from "path";
import {analyzeFiles} from "../../src/analysis/analyzer";
import Solver from "../../src/analysis/solver";
import {inferShapes, ShapeInfos} from "../../src/analysis/shapeinfer";
import {propagateTypeLabels} from "../../src/analysis/typelabels";
import {options, resetOptions} from "../../src/options";
import {setLogLevel} from "../../src/misc/logger";
import {typesToJSON} from "../../src/output/types";

describe("forward shape inference", () => {
    let dir: string;
    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), "jelly-shapes-"));
        resetOptions();
        Object.assign(options, {basedir: dir, inferTypes: true, typesJson: "unused", patchEscaping: false, patchThis: false, printProgress: false});
        setLogLevel("error");
    });
    afterEach(() => rmSync(dir, {recursive: true, force: true}));

    async function analyze(code: string, extra: Record<string, string> = {}) {
        writeFileSync(join(dir, "main.js"), code);
        for (const [file, contents] of Object.entries(extra)) writeFileSync(join(dir, file), contents);
        const solver = new Solver;
        await analyzeFiles(["main.js"], solver);
        const labels = propagateTypeLabels(solver.fragmentState);
        return {solver, labels, result: inferShapes(solver.fragmentState, labels), code};
    }
    function at(result: ShapeInfos, code: string, marker: string) {
        const line = code.split("\n").findIndex(s => s.includes(marker)) + 1;
        const observations = result.states.filter(s => s.phase === "after-expression" && s.location.startsWith(`main.js:${line}:`));
        expect(observations.length).toBeGreaterThan(0);
        return observations.map(s => s.shape ? result.shapes.find(shape => shape.name === s.shape)!.properties.map(p => p.name) : s.reason);
    }
    test("tracks successive shapes and store completion separately", async () => {
        const {result, code} = await analyze(`const o = {};
o; // empty
o.z = 1;
o; // first
o.a = 2;
o; // second
o.z = 3;
o; // overwrite`);
        expect(at(result, code, "// empty")).toEqual([[]]);
        expect(at(result, code, "// first")).toEqual([["z"]]);
        expect(at(result, code, "// second")).toEqual([["z", "a"]]);
        expect(at(result, code, "// overwrite")).toEqual([["z", "a"]]);
        expect(result.bindings.some(b => b.phase === "after-write")).toBe(true);
    });
    test("passes token state through synchronous helpers and matched returns", async () => {
        const {result, code} = await analyze(`function z(p) { p.z = 1; return p; }
function a(p) { p.a = 2; }
const o = {};
const r = z(o);
a(r);
o; // done`);
        expect(at(result, code, "// done")).toEqual([["z", "a"]]);
    });
    test("does not execute a function body when its declaration is evaluated", async () => {
        const {result, code} = await analyze(`const o = {};
function unused() { o.extra = 1; }
o; // untouched`);
        expect(at(result, code, "// untouched")).toEqual([[]]);
    });
    test("known read-only helper preserves the heap", async () => {
        const {result, code} = await analyze(`function read(p) { return p.x; }
const o = {x: 1};
read(o);
o; // unchanged`);
        expect(at(result, code, "// unchanged")).toEqual([["x"]]);
    });
    test("rejects branch-dependent additions even with equal branch results", async () => {
        const {result, code} = await analyze(`const o = {};
if (flag) o.x = 1; else o.x = 2;
o; // conditional`);
        expect(at(result, code, "// conditional")).toEqual(["path-dependent-write"]);
    });
    test("propagates conditional and loop context into callees", async () => {
        const branch = await analyze(`function add(p) { p.x = 1; }
const o = {};
if (flag) add(o);
o; // conditional`);
        expect(at(branch.result, branch.code, "// conditional")).toEqual(["path-dependent-write"]);
        const loop = await analyze(`function add(p) { p.x = 1; }
const o = {};
while (flag) add(o);
o; // loop`);
        expect(at(loop.result, loop.code, "// loop")).toEqual(["loop"]);
    });
    test("merges multiple concrete instances represented by one constructor token", async () => {
        const {result, code} = await analyze(`function Box() { this.x = 1; }
const a = new Box();
a; // single
const b = new Box();
a.y = 1;
b; // multiple`);
        expect(at(result, code, "// single")).toEqual([["x"]]);
        expect(at(result, code, "// multiple")).toEqual(["multiple-instances"]);
    });
    test("repeated literal allocation is not reset to Known", async () => {
        const {result, code} = await analyze(`function make() { return {}; }
const a = make();
const b = make();
a.x = 1;
b; // repeated`);
        expect(at(result, code, "// repeated")).toEqual(["multiple-instances"]);
    });
    test("keeps string-literal computed keys but rejects unknown keys", async () => {
        const {result, code} = await analyze(`const o = {};
o["x"] = 1;
o; // statickey
o[key] = 2;
o; // dynamickey`);
        expect(at(result, code, "// statickey")).toEqual([["x"]]);
        expect(at(result, code, "// dynamickey")).toEqual(["dynamic-key"]);
    });
    test("unknown native effects and recursion do not retain Known", async () => {
        const native = await analyze(`const o = {};
Object.assign(o, {x: 1});
o; // native`);
        expect(at(native.result, native.code, "// native")).toEqual(["unknown-call"]);
        const recursion = await analyze(`const o = {};
function recurse(p) { recurse(p); }
recurse(o);
o; // recursion`);
        expect(at(recursion.result, recursion.code, "// recursion")).toEqual(["recursive-call"]);
    });
    test("tracks prototype initialization and module-local helper calls", async () => {
        const data = await analyze(`const init = require("./helper");
const o = {};
init(o);
o; // module`, {"helper.js": "module.exports = function(p) { p.b = 1; p.a = 2; };"});
        expect(at(data.result, data.code, "// module")).toEqual([["b", "a"]]);
    });
    test("post-pass leaves Jelly solutions unchanged and serializes structural/type layers", async () => {
        const {solver, labels, result} = await analyze("const o = {x: 1}; o.y = true; o;");
        const a = solver.globalState, f = solver.fragmentState;
        const before = [a.vars.length, a.tokens.length, f.numberOfSubsetEdges, f.numberOfCallToFunctionEdges];
        const again = inferShapes(f, labels);
        expect([a.vars.length, a.tokens.length, f.numberOfSubsetEdges, f.numberOfCallToFunctionEdges]).toEqual(before);
        expect(again.states).toEqual(result.states);
        const report = typesToJSON(f, labels, result);
        expect(report.shapeStates).toEqual(result.states);
        expect(report.shapes!.some(s => s.properties.some(p => p.name === "x" && p.types?.includes("number")))).toBe(true);
        const limited = inferShapes(f, labels, 1);
        expect(limited.diagnostics.truncated).toBe(true);
        expect(limited.states.every(s => !s.shape && s.reason === "budget")).toBe(true);
    });
    test("query selects observations and token state without changing the solution", async () => {
        const {solver, labels, result} = await analyze(`const a = {};
const b = {};
a.z = 1;
b.q = 2;
a.a = 3;
a; // query`);
        const queried = inferShapes(solver.fragmentState, labels, 100000, ["main.js:6:1"]);
        expect(queried.states).toHaveLength(1);
        expect(queried.shapes[0].properties.map(p => p.name)).toEqual(["z", "a"]);
        const full = result.states.find(s => s.location === "main.js:6:1:6:2" && s.phase === "after-expression")!;
        expect(queried.states[0]).toMatchObject({location: full.location, token: full.token, phase: full.phase});
        expect(queried.shapes[0].properties).toEqual(result.shapes.find(s => s.name === full.shape)!.properties);
        expect(inferShapes(solver.fragmentState, labels, 100000, ["main.js:90:1"]).diagnostics.steps).toBe(0);
        const limited = inferShapes(solver.fragmentState, labels, 1, ["main.js:6:1"]);
        expect(limited.states).toEqual([expect.objectContaining({reason: "budget"})]);
    });
    test("evaluates receiver before RHS effects and observes the store afterwards", async () => {
        const {result, code} = await analyze(`const o = {};
function rhs() { o.z = 1; return 2; }
o.a = rhs();
o; // ordered`);
        expect(at(result, code, "// ordered")).toEqual([["z", "a"]]);
        const before = result.states.find(s => s.location === "main.js:3:1:3:2" && s.phase === "after-expression")!;
        const after = result.states.find(s => s.location === before.location && s.phase === "after-write")!;
        expect(result.shapes.find(s => s.name === before.shape)!.properties).toHaveLength(0);
        expect(result.shapes.find(s => s.name === after.shape)!.properties.map(p => p.name)).toEqual(["z", "a"]);
    });
    test("short circuit assignment does not execute RHS writes unconditionally", async () => {
        const {result, code} = await analyze(`const o = {};
let flag;
flag &&= (o.x = 1);
o; // logical`);
        expect(at(result, code, "// logical")).toEqual(["path-dependent-write"]);
    });
    test("optional-call argument writes are conditional", async () => {
        const {result, code} = await analyze(`function read(x) { return x; }
const o = {};
read?.(o.x = 1);
o; // optional`);
        expect(at(result, code, "// optional")).toEqual(["path-dependent-write"]);
    });
    test("does not execute statements after return and does not mix return paths", async () => {
        const {result, code} = await analyze(`function add(p) { p.z = 1; return; p.a = 2; }
const o = {};
add(o);
o; // returned`);
        expect(at(result, code, "// returned")).toEqual([["z"]]);
    });
    test("an existing-property write inside a branch does not change structure", async () => {
        const {result, code} = await analyze(`const o = {x: 1};
if (flag) o.x = 2;
o; // same`);
        expect(at(result, code, "// same")).toEqual([["x"]]);
    });
    test("ambiguous receiver writes do not strongly update multiple tokens", async () => {
        const {result, code} = await analyze(`const a = {}, b = {};
const p = flag ? a : b;
p.x = 1;
a; // ambiguous`);
        expect(at(result, code, "// ambiguous")).toEqual(["ambiguous-receiver"]);
    });
    test("callee observations in a loop also cover later iterations", async () => {
        const {result} = await analyze(`function add(p) { p; p.x = 1; }
const o = {};
while (flag) add(o);`);
        const inside = result.states.filter(s => s.location.startsWith("main.js:1:") && s.token.startsWith("Object["));
        expect(inside.length).toBeGreaterThan(0);
        expect(inside.every(s => s.reason === "loop")).toBe(true);
    });
    test("tracks class field order and non-enumerable prototype methods", async () => {
        const {result, code} = await analyze(`class Box { z = 1; a; constructor() { this.b = 2; } method() {} }
const o = new Box();
o; // class
Box.prototype; // prototype`);
        expect(at(result, code, "// class")).toEqual([["z", "a", "b"]]);
        const prototype = result.shapes.find(s => s.kind === "prototype" && s.properties.length === 2)!;
        expect(prototype.properties.map(p => [p.name, p.enumerable])).toEqual([["constructor", false], ["method", false]]);
    });
    test("preserves source creation order rather than sorting property names", async () => {
        const {result, code} = await analyze(`const o = {z: 1, "2": 2, a: 3, "1": 4};
o; // indices`);
        expect(at(result, code, "// indices")).toEqual([["z", "2", "a", "1"]]);
    });
    test("handles ES module initialization before body statements", async () => {
        const {result, code} = await analyze(`const o = {};
import {init} from "./helper.js";
init(o);
o; // esm`, {"helper.js": "export function init(p) { p.b = 1; p.a = 2; }"});
        expect(at(result, code, "// esm")).toEqual([["b", "a"]]);
    });
    test("initializes exported constructor prototypes before use", async () => {
        const {result, code} = await analyze(`import {Box} from "./helper.js";
Box.prototype; // exportedprototype
const o = new Box();
o; // exportedinstance`, {"helper.js": "export function Box() { this.x = 1; }"});
        expect(at(result, code, "// exportedprototype")).toContainEqual(["constructor"]);
        expect(at(result, code, "// exportedinstance")).toEqual([["x"]]);
    });
    test("unsupported effects invalidate known shapes", async () => {
        for (const effect of ["delete o.x;", "o.__proto__ = {};", "Object.defineProperty(o, 'y', {value: 1});"]) {
            const {result, code} = await analyze(`const o = {x: 1};\n${effect}\no; // invalidated`);
            expect(at(result, code, "// invalidated")[0]).not.toBeInstanceOf(Array);
        }
    });
    test("exception syntax, derived constructors and default parameters remain conservative", async () => {
        const exceptional = await analyze(`const o = {};
try { o.x = 1; } catch (e) { o.y = 2; }
o; // caught`);
        expect(at(exceptional.result, exceptional.code, "// caught")).toEqual(["unsupported"]);
        const derived = await analyze(`class Base { constructor() { this.x = 1; } }
class Child extends Base { constructor() { super(); this.y = 2; } }
const o = new Child();
o; // derived`);
        expect(at(derived.result, derived.code, "// derived")).toEqual(["unsupported"]);
        const defaults = await analyze(`const o = {};
function add(p = (o.x = 1)) {}
add();
o; // defaults`);
        expect(at(defaults.result, defaults.code, "// defaults")).toEqual(["unsupported"]);
    });
    test("unknown ambient effects also affect later inherited-property writes", async () => {
        const {result, code} = await analyze(`external();
const o = {x: 1};
o; // fresh
o.y = 2;
o; // ambient`);
        expect(at(result, code, "// fresh")).toEqual([["x"]]);
        expect(at(result, code, "// ambient")).toEqual(["unknown-call"]);
    });
    test("prototype replacement invalidates later constructor writes", async () => {
        const {result, code} = await analyze(`function Box() { this.x = 1; }
Box.prototype = {set x(value) {}};
const o = new Box();
o; // replacement`);
        expect(at(result, code, "// replacement")[0]).not.toBeInstanceOf(Array);
    });
    test("spread and computed-key coercion do not hide effects on other objects", async () => {
        for (const operation of ["const r = {...source};", "const r = [...source];", "const r = {}; r[source] = 1;"]) {
            const {result, code} = await analyze(`const o = {};\nconst source = {};\n${operation}\no; // effects`);
            expect(at(result, code, "// effects")).toEqual(["unsupported"]);
        }
    });
    test("structural states carry global property may-types rather than point-specific values", async () => {
        const {result} = await analyze(`const o = {x: 1};
o.x = "later";
o;`);
        const early = result.states.find(s => s.location === "main.js:1:11:1:17" && s.phase === "after-expression")!;
        expect(result.shapes.find(s => s.name === early.shape)!.properties[0].types).toEqual(expect.arrayContaining(["number", "string"]));
    });
});
