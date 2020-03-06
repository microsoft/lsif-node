import { Foo } from '../p1/lib/main';

class Bar implements Foo {
	public foo(): void {
	}
}

let b: Bar;
b.foo();