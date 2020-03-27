export interface Disposable {
	dispose(): void;
}

let d: Disposable;
d.dispose();

// let c = new class implements Foo {
// 	foo() { }
// }();