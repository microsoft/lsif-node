import { Foo } from 'p1';

class Bar implements Foo {
	public foo(): void {
	}
}

let b: Bar;
b.foo();