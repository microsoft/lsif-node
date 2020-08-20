export function foo() {
	return {
		foo: () => { return 10; }
	}
}

interface Bar {
	name: string;
}

export type D = Bar;