function f() {}
f.m = function fm() {};
const o = {m: function om() {}};

let x = Math.random() ? f : null;
if (x)
    x();
else
    x();

let y = Math.random() ? f : o;
if (typeof y === "function")
    y.m();
else
    y.m();

function pick(cb) {
    if (typeof cb !== "function")
        return cb.m();
    cb();
}
pick(Math.random() ? f : o);
