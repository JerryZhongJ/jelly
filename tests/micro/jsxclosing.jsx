function render() {
    const A = {B: function() { return null; }};
    return <A.B>hello</A.B>;
}
render();
