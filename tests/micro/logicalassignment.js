function a() {}
function b() {}
function c() {}
function d() {}

let x = a;
(x ??= b)(); // result in {a, b} -> 2 call->function edges

let y = c;
(y ||= d)(); // result in {c, d} -> 2 call->function edges
