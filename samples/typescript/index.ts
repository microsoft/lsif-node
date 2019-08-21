import { foo, bar } from './sub/provide';

console.log(foo, bar);


// function foo(x: number): void {
// }


// interface I {
//   foo(): void;
// }

// let i: I;

// interface I {
//   foo(): void;
// }

// interface II {
//   foo(): void;
// }

// class B implements I, II {
//   foo(): void {
//   }
// }

// let i: I;
// i.foo();

// let b: B;
// b.foo();



// export type BabelDescriptor = { initializer?: () => any; } & ( { foo: number } | { bar: number });


// export type PropertyCreator = (
//     instance: any,
// ) => void

// export interface Init {
//     initializer?: () => any;
// }

// export type BabelDescriptor = PropertyCreator & Init

// import * as p from './sub/provide';
// p.foo();

// process.env;

// interface A<T> {
// 	x: T;
// }

// export function foo(): void {
// }

// Object.is(1, 1);

// /**
//  * A longer comment that needs to be fetch
//  *
//  * jdjdj
//  * dkjdkj
//  */
// interface I1 {
// 	/**
// 	 * A longer comment that needs to be fetch
// 	 *
// 	 * jdjdj
// 	 * dkjdkj
// 	 */
// 	get(): void;
// }

// /**
//  * A longer comment that needs to be fetch
//  *
//  * jdjdj
//  * dkjdkj
//  */
// interface I2 {
// 	/**
// 	 * A longer comment that needs to be fetch
// 	 *
// 	 * jdjdj
// 	 * dkjdkj
// 	 */
// 	get(): void;
// }

// let i: I1 | I2;
// i.get();

// let i2: I1;
// i2.get();


// import * as mobx from 'mobx';

// let x: mobx.ObservableMap;

// let s: Set<string> = new Set();
// s.add('foo');

// /**
//  * A longer comment that needs to be fetch
//  *
//  * jdjdj
//  * dkjdkj
//  */
// function foo(): number {
// 	return 10;
// }

// export default foo();

// /**
//  * A longer comment that needs to be fetch
//  *
//  * jdjdj
//  * dkjdkj
//  */
// export const enum OutlineConfigKeys {
// 	'icons' = 'outline.icons',
// 	'problemsEnabled' = 'outline.problems.enabled',
// 	'problemsColors' = 'outline.problems.colors',
// 	'problemsBadges' = 'outline.problems.badges'
// }