const cb = () => { console.log("cb"); };

function relay(...rest) {
    rest[0]();
    relay("lead", ...rest);
}

relay(cb);
