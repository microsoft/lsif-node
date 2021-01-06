chrome.debugger.onDetach;

interface Y {
	value: number;
}

export namespace X {
	export type B = Y;
}

import { mul } from './sub/provide';
mul(1, 1);

import { div } from '../provide'
div(1,1);