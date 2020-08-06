import { RAL } from './provide';

const ral: RAL;

ral.foo();


interface A {
	name: string;
	value: number;
}

interface B {
	name: string;
}

const x: A | B;
x.name;
x.value;

const y: A & B;
y.name;
y.value;