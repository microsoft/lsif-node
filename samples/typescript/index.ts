import { foo, foo2 } from './provide';

foo();
foo2();


interface RAL {
	readonly console: {
		error(message?: any, ...optionalParams: any[]): void;
	}
}

export { RAL };


export const x: number = 10;