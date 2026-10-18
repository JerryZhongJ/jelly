function f() {}
function g() {}

let x = f;
x();
x = g;
x();

let y;
if (Math.random())
    y = f;
else
    y = g;
y();

let z = f;
function call() {
    z();
}
call();
z = g;
call();

let w = f;
for (let i = 0; i < 2; i++) {
    w();
    w = g;
}
