function fa() {}
function fo() {}
const arr = [];
arr.m = fa;
const obj = {m: fo};
let x = Math.random() ? arr : obj;
if (Array.isArray(x))
    x.m();
else
    x.m();

function fe() {}
function fd() {}
const err = new Error("e");
err.m = fe;
const date = new Date();
date.m = fd;
let y = Math.random() ? err : date;
if (y instanceof Error)
    y.m();
else
    y.m();

function fs() {}
class MyErr extends Error {}
const err2 = new MyErr();
err2.m = fs;
let z = Math.random() ? err2 : date;
if (z instanceof Error)
    z.m();

function pd() {}
const partner = new Map();
partner.m = pd;

function ga() {}
const arr2 = [];
arr2.m = ga;
let va = Math.random() ? arr2 : partner;
if (va instanceof Array)
    va.m();

function gf() {}
const fun = function ff() {};
fun.m = gf;
let vf = Math.random() ? fun : partner;
if (vf instanceof Function)
    vf.m();

function pe() {}
const partner2 = new Set();
partner2.m = pe;
function gm() {}
const map = new Map();
map.m = gm;
let vm = Math.random() ? map : partner2;
if (vm instanceof Map)
    vm.m();

function gs() {}
const set = new Set();
set.m = gs;
let vs = Math.random() ? set : partner;
if (vs instanceof Set)
    vs.m();

function gwm() {}
const wmap = new WeakMap();
wmap.m = gwm;
let vwm = Math.random() ? wmap : partner;
if (vwm instanceof WeakMap)
    vwm.m();

function gws() {}
const wset = new WeakSet();
wset.m = gws;
let vws = Math.random() ? wset : partner;
if (vws instanceof WeakSet)
    vws.m();

function gwr() {}
const wref = new WeakRef({});
wref.m = gwr;
let vwr = Math.random() ? wref : partner;
if (vwr instanceof WeakRef)
    vwr.m();

function gr() {}
const re = /x/;
re.m = gr;
let vr = Math.random() ? re : partner;
if (vr instanceof RegExp)
    vr.m();

function gp() {}
const prom = Promise.resolve(1);
prom.m = gp;
let vp = Math.random() ? prom : partner;
if (vp instanceof Promise)
    vp.m();

let vd = Math.random() ? date : partner;
if (vd instanceof Date)
    vd.m();
