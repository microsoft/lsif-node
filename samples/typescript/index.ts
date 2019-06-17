import * as mobx from 'mobx';

let x: mobx.ObservableMap;

export interface IDisposable {
	dispose(): void;
}

class A implements IDisposable {
	public dispose(): void {
	}
	private local(): void {
	}
}

let d: IDisposable = new A();
d.dispose();