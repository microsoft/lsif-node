// function _foo(): void {
// }

// export { _foo as foo, _foo as foo2 };

interface Base {
	foo(): void;
}

export interface RAL extends Base {
	readonly console: {
		error(message?: any, ...optionalParams: any[]): void;
	}
}