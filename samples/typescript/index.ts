interface I1 {
	get(): void;
}

interface I2 {
	get(): void;
}

let i: I1 | I2;
i.get();

let i2: I1;
i2.get();


import * as mobx from 'mobx';

let x: mobx.ObservableMap;

let s: Set<string> = new Set();
s.add('foo');

function foo(): number {
	return 10;
}

export default foo();

export const enum OutlineConfigKeys {
	'icons' = 'outline.icons',
	'problemsEnabled' = 'outline.problems.enabled',
	'problemsColors' = 'outline.problems.colors',
	'problemsBadges' = 'outline.problems.badges'
}