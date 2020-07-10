export interface A { name: string };
export interface B { name: string };
export interface C { name: string };

let d: A | (A & B);
d.name;