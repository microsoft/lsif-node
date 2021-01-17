export interface Func {
	(callback: (entry: { key: string; value: number; }) => void);
}

let f: Func;
f(e => { e.key; e.value; });