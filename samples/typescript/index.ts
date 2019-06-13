interface IDisposable {
	dispose(): void;
}

class A implements IDisposable {
	dispose(): void {
	}
}

let d: IDisposable = new A();
d.dispose();