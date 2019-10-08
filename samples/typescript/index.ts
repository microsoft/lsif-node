const map: Map<string, string> = new Map();
map.set('dirk', 'baeumer');

interface A {
	x: {
		y: string;
	}
}

interface B {
	x: {
		y: number;
	}
}

let z: A | B;

let v = z.x.y;
console.log(v);

// import { mul } from './sub/provide';


// const result: number = mul(10, 20);
// if (result !== 200) {
// 	throw new Error(`Multiplication failed`);
// }


// export class MyClass {
// 	constructor() {
// 	}

// 	public mul(a: number, b: number): number {
// 		return a * b;
// 	}
// }
