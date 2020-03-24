export interface Foo {
	foo(): void;
}

let f: Foo;
f.foo();

// let c = new class implements Foo {
// 	foo() { }
// }();