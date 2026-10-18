const xs = [
    () => { console.log("a"); }, // cb1
    () => { console.log("b"); }  // cb2
];

class C {
    constructor(p1, p2) {
        p1(); // -> cb1
        p2(); // -> cb2
    }
}
new C(...xs);

const obj = {
    m(p1, p2) {
        p1(); // -> cb1
        p2(); // -> cb2
    }
};
obj.m(...xs);

function g(...rest) {
    rest[0](); // -> cb1
    rest[1](); // -> cb2
}
g(...xs);

const ext = (globalThis.someUnknownExternal ?? ((p1, p2) => { p1(); p2(); }));
ext(...xs);

const fromSpread = Array.from(...[xs]); // should still yield an array with cb1/cb2
fromSpread[0](); // -> cb1
fromSpread[1](); // -> cb2

function h1(p1, p2) {
    p1(); // -> cb1
    p2(); // -> cb2
}
h1.call(null, ...xs);

function h2(p1, p2) {
    p1(); // -> cb1
    p2(); // -> cb2
}
h2.apply(null, [...xs]); // array literal with spread, then apply

function h3(p1, p2) {
    p1(); // -> cb1
    p2(); // -> cb2
}
const bound = h3.bind(null, ...xs);
bound();

[1, 2].forEach(...[() => { console.log("c"); }]); // cb_c should be called

new Promise(...[(resolve) => { resolve(() => { console.log("d"); }); }])
    .then(cb => cb()); // cb_d should be called

function* gen() {
    yield () => { console.log("e"); }; // cb_e
    yield () => { console.log("f"); }; // cb_f
}
function k(p1, p2) {
    p1(); // -> cb_e
    p2(); // -> cb_f
}
k(...gen());
const arrFromGen = [...gen()];
arrFromGen[0]();
arrFromGen[1]();

function escapes(...rest) {
    return rest;
}
globalThis.__leak = escapes(() => { console.log("g"); });

const a13 = Array(...xs);
a13[0](); // -> cb1/cb2 via array unknown slot
a13[1]();

const a14 = Array.of(...xs);
a14[0]();
a14[1]();

const base15 = [() => { console.log("h"); }]; // cb_h
const a15 = base15.concat(...xs);
a15[0]();
a15[1]();
a15[2]();

const base16 = [];
base16.push(...xs);
base16[0]();
base16[1]();

const base17 = [];
base17.unshift(...xs);
base17[0]();
base17[1]();

const base18 = [() => { console.log("i"); }, () => { console.log("j"); }];
base18.splice(1, 0, ...xs);
base18[0]();
base18[1]();
base18[2]();
base18[3]();

const a19 = Object.assign({}, ...[{ m: () => { console.log("k"); } }]); // cb_k
a19.m();

Promise.all(...[[Promise.resolve(() => { console.log("l"); })]]) // cb_l
    .then(arr => arr[0]());

Promise.race(...[[Promise.resolve(() => { console.log("m"); })]]) // cb_m
    .then(fn => fn());

function timed(p1, p2) {
    p1(); // -> cb1
    p2(); // -> cb2
}
setTimeout(timed, 0, ...xs);

function immed(p) {
    p(); // -> cb_n
}
setImmediate(immed, ...[() => { console.log("n"); }]);
