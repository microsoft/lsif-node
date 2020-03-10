interface I {
  foo(): void;
}

interface II extends I {
	foo(): void;
}

class A implements II {
  foo(): void {
  }
}

class B implements I {
  foo(): void {
  }
}

let i: I;
i.foo();

let b: B;
b.foo();