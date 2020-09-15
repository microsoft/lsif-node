// file A
export const values: ReadonlyArray<{ line: number; character: number}> = [];

// file B
values[1].character;
values.find(() => true).character;


// file A
interface Hidden {
	line2: number;
	character: number;
}

export const range: {
	start: Hidden,
	end: Hidden
} = { start: { line2: 10, character: 10 }, end: { line2: 10, character: 10 } };


// file B
range.start.line2;
range.end.line2;


abstract class Foo {
    run(): void { }
}
export class Bar extends Foo {
    do(): void { }
}