const c0 = () => { console.log("0"); };
const c1 = () => { console.log("1"); };
const c2 = () => { console.log("2"); };
const ca = () => { console.log("a"); };
const cb = () => { console.log("b"); };

function bar(a, b, c, d, e) {
    a();
    b();
    c();
    d();
    e();
}

function f(x, y, ...foo) {
    bar(x, y, ...foo);
}

f(ca, cb, c0, c1, c2);
