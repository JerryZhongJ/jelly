function target1() {}
const obj1 = {
    get foo() {
        return target1;
    }
};
(obj1.foo)();

function target2() {}
function makeGetter() {
    return function getBar() {
        return target2;
    };
}
const obj2 = {};
const read2 = obj2.bar;
Object.defineProperty(obj2, "bar", {get: makeGetter()});
read2();

function target3() {}
class C {
    get baz() {
        return target3;
    }
}
(new C().baz)();

function target4() {}
const obj4 = {
    inner: target4,
    get self() {
        return this.inner;
    }
};
(obj4.self)();

function target5() {}
let captured5;
const obj5 = {};
Object.defineProperty(obj5, "qux", {
    set: function setQux(v) {
        captured5 = v;
    }
});
obj5.qux = target5;
captured5();

function target6() {}
let captured6;
class D {
    set quux(v) {
        captured6 = v;
    }
}
new D().quux = target6;
captured6();

function target7() {}
let captured7;
const proto7 = {};
const obj7 = Object.create(proto7);
obj7.late = target7;
Object.defineProperty(proto7, "late", {
    set: function setLate(v) {
        captured7 = v;
    }
});
captured7();
