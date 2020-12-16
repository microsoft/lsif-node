declare module chrome {
    namespace _debugger {
		export var onDetach: number;
	}
	export { _debugger as debugger }
}