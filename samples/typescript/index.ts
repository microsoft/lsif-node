import * as mobx from 'mobx';

let map: mobx.ObservableMap = new mobx.ObservableMap();


// export function func(): void {
// }

// export class Emitter {
// 	private doEmit() {
// 	}

// 	public emit() {
// 	}
// }

// import * as Is from 'is';

// Is.number(10);

// import * as provide from './sub/provide';

// provide.foo();

// export function foo(x: string): void {
// 	x = '10';
// }

// export interface I {

// }

// export namespace I {
// 	export function create(): void {

// 	}
// }

// foo('dirk');

// class A {
// 	private foo(): void {
// 		interface Bar {
// 		}
// 	}
// }

// import * as provide from './sub/provide';

// provide.foo()

// type I = {
// 	foo(): number;
// }

// interface II extends I {
// 	bar(): number;
// }

// // import { foo } from './sub/provide';

// foo();

// import * as is from 'is';
// is.boolean(true);

// interface I {
// 	foo();
// }

// class A implements I {
// 	foo() {
// 	}
// }

// class B implements I {
// 	foo() {
// 	}
// }

// let i: I;
// i.foo();


// function foo(x: number): number;
// function foo(x: string): string;
// function foo(x: number | string): number | string {
// 	return undefined;
// }

// foo(10);
// foo('dirk');


// function foo() {
// 	let x: string = 10;
// }

// function bar() {
// 	foo();
// }

/*
class A {
	private foo(x: number): number;
	private foo(x: string): string;
	private foo(x: string | number): any {
		return undefined;
	}

	private bar() {
		this.foo(10);
		this.foo(20);
	}
*/

/*
interface I {
	foo(): void;
}

interface II {
	foo(): void;
}

class A implements I {
	foo(): void {
		let x: string = 10;
	}
}

class B implements I, II {
	foo(): void {
	}
}

let i: I;
i.foo();

let b: B;
b.foo();
*/

/*
class T {
	foo(x: number): number;
	foo(x: string): string;
	foo(x: string | number): string | number {
		return undefined;
	}
}

function main() {
	let t: T;
	t.foo('hello');
	t.foo(10);
}
*/

/*
function foo(x: number): number;
function foo(x: string): string;
function foo(x: string | number): string | number {
	return undefined;
}

foo(10);
foo('dirk');
*/
/*

// function foo() {
// }


/*
namespace I {
	export interface X {
		foo(x: string): number;
	}
}

interface I {
}

class A<T> implements I, I.X {
	foo(x: string): number;
	foo(x: number): number;
	foo(x: string | number): number {
		return 10;
	}

	bar(): void {
		this.foo('dirk');
	}
}

function bar(): string {
	return 'dirk';
}
*/

// namespace I {

// }

// interface I {
// 	foo(x: string | number): void;
// }

// interface II extends I {
// 	foo(x: string | number): void;
// }

// interface I {
// 	barOne();
// }

// class A implements II {
// 	foo(x: number): void;
// 	foo(x: string): void;
// 	foo(x: string | number): void {
// 	}

// 	barOne() {
// 		this.foo('string');
// 	}

// 	barTwo() {
// 		this.foo(10);
// 	}
// }

// class B extends A {
// 	foo(x: string | number): void {
// 	}

// 	barThree() {
// 		this.foo(10);
// 	}

// 	barFour(a) {
// 	}
// }