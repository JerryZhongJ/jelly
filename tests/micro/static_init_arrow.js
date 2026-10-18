class A {
    static aHit() { return 1; }
}

class C extends A {
    static cHit() { return 2; }

    instM() { return 3; }

    static fThis = () => this.cHit();

    static fThisNested = () => () => this.cHit();

    static #fThisPriv = () => this.cHit();
    static getPriv() { return C.#fThisPriv; }

    static fSuper = () => super.aHit();

    static fSuperNested = () => () => super.aHit();

    static blockThis;
    static blockSuper;
    static {
        C.blockThis  = () => this.cHit();
        C.blockSuper = () => super.aHit();
    }

    instArrow = () => this.instM();
}

C.fThis();
C.fThisNested()();
C.getPriv()();
C.fSuper();
C.fSuperNested()();
C.blockThis();
C.blockSuper();
new C().instArrow();
