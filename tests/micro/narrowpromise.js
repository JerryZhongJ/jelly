function f() {}
const p = new Promise(function executor(resolve) {
    if (typeof resolve === "function")
        resolve(f);
});
p.then(function cb(w) {
    w();
});
