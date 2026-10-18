function createParserGetter(name) {
    return function get() {
        return loadParser(name);
    };
}

function loadParser(name) {
    return function parser() {};
}

Object.defineProperty(exports, "urlencoded", {
    get: createParserGetter("urlencoded")
});

Object.defineProperty(exports, "json", {
    get: createParserGetter("json")
});

var u = exports.urlencoded;
u();

var j = exports.json;
j();
