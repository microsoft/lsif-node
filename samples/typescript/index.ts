interface A {
	name: string;
}

interface B {
	name: string;
}

interface C {
	name: String;
}

type D = A | (A & B);

let d: D;

d.name;

type E = A | (A & B);

let e: E;

e.name;

type F = A & B;

let f: F;

f.name;