// namespace N {
// 	export function foo(): void { }
// 	function bar(): void { }
// }

				// export interface I {
				// 	// field: { key: number; }
				// 	foo(): { key: number };
				// 	// "123": number;
				// 	// __bar: string;
				// }

// interface Func {
// 	(arg: number): { key: number };
// 	arg: string;
// }

export class Foo {
	get [Symbol.toStringTag](): string {
		return "Foo";
	}
}