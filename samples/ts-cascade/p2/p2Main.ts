import { Disposable } from 'p1';

class Widget implements Disposable {
	public dispose(): void {
	}
}

let w: Widget;
w.dispose();