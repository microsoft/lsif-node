export type PropertyCreator = (
    instance: any,
) => void

export type BabelDescriptor = PropertyDescriptor & { initializer?: () => any }

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