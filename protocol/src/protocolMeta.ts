/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */

import * as lsp from 'vscode-languageserver-protocol';

import {
	Id, ElementTypes, Element, V, VertexLabels, Vertex, Edge, Event, EventScope, EventKind, GroupEvent, ProjectEvent, DocumentEvent, MonikerAttachEvent,
	ResultSet, Range, RangeTag
} from './protocol';

interface ValidateFunc {
	(value: unknown): boolean;
}

class PropertyValidator {

	public readonly name: string;
	private readonly validator: ValidateFunc;
	private isOptional: boolean;

	constructor(name: string, validator: ValidateFunc, isOptional: boolean) {
		this.name = name;
		this.validator = validator;
		this.isOptional = isOptional;
	}

	public validate(value: unknown): boolean {
		if (this.isOptional && value === undefined) {
			return true;
		}
		return this.validator(value);
	}
}

class ElementValidator {
	public readonly name: string;
	public readonly base: ElementValidator | undefined;
	private readonly properties: Map<string, PropertyValidator>;

	constructor(name: string, base: ElementValidator | undefined) {
		this.name = name;
		this.base = base;
		this.properties = new Map();
	}

	public addProperty(name: string, validator: PropertyValidator): void {
		this.properties.set(name, validator);
	}

	public validate(value: unknown): boolean {
		ElementValidator.assertElement(value);
		ElementValidator.assertVertexOrEdge(value);

		if (this.base !== undefined && !this.base.validate(value)) {
			return false;
		}

		let result: boolean = true;
		for (const entry of this.properties.entries()) {
			const propertyName = entry[0];
			result = result && entry[1].validate((value as any)[propertyName]);
			if (!result) {
				return false;
			}
		}
		return result;
	}

	public static assertElement(value: unknown): asserts value is Element {
		if (value === undefined || value === null) {
			throw new Error(`Received undefined or null for an element`);
		}
		const candidate = value as Element;
		if (!ElementTypes.is(candidate.type)) {
			throw new Error (`Value ${JSON.stringify(value, undefined, 0)} is neither a vertex nor an edge.`);
		}
	}

	public static assertVertexOrEdge(value: Element): asserts value is Vertex | Edge {
		const candidate = value as (Vertex | Edge);
		if (typeof candidate.label !== 'string') {
			throw new Error(`Value ${JSON.stringify(value, undefined, 0)} is neither a vertex nor an edge.`);
		}
	}
}

class ElementValidators {

	private readonly elements: Map<string, ElementValidator>;

	public constructor() {
		this.elements = new Map();
	}

	public getValidator(className: string): ElementValidator | undefined {
		return this.elements.get(this.elementName(className));
	}

	public getOrCreateValidator(className: string, base: ElementValidator | undefined): ElementValidator {
		const label = this.elementName(className);
		let result = this.elements.get(label);
		if (result === undefined) {
			result = new ElementValidator(label, base);
			this.elements.set(label, result);
		}
		return result;
	}

	public getValidatorByLabel(label: string): ElementValidator {
		const result = this.elements.get(label);
		if (result === undefined) {
			throw new Error(`No element validator found for element name ${label}`);
		}
		return result;
	}

	private elementName(className: string): string {
		if (className.length < 2) {
			throw new Error(`Invalid class name ${className}`);
		}
		return `${className[1].toLowerCase()}${className.substr(2)}`;
	}
}

const elementValidators = new ElementValidators();

interface Proto {
	name: string;
	__proto__: Proto | null;
}

interface Prototype {
	constructor: Function;
}

interface ConstructorFunction extends Function {
	__proto__: Proto | null;
}

namespace ConstructorFunction {
	export function is(value: Function): value is ConstructorFunction {
		const candidate = value as ConstructorFunction;
		return candidate !== undefined && candidate.__proto__ !== undefined;
	}
}

function ensureParent(proto: Proto | null): ElementValidator | undefined {
	if (proto === null || !proto.name.startsWith('_')) {
		return undefined;
	}
	const result = elementValidators.getValidator(proto.name);
	if (result !== undefined) {
		return result;
	}
	return elementValidators.getOrCreateValidator(proto.name, ensureParent(proto.__proto__));
}

export function element() {
	return function(constructor: Function) {
		elementValidators.getOrCreateValidator(constructor.name, ConstructorFunction.is(constructor) ? ensureParent(constructor.__proto__) : undefined);
	};
}

export function property(validator: ValidateFunc, isOptional: boolean = false) {
	return function (target: Prototype, name: string) {
		const constructor = target.constructor;
		elementValidators.getOrCreateValidator(constructor.name, ConstructorFunction.is(constructor) ? ensureParent(constructor.__proto__) : undefined).addProperty(name, new PropertyValidator(name, validator, isOptional));
	};
}

export type I<T> = { [P in keyof T]: T[P] };

@element()
class _Element {
	@property(Id.is)
	id: Id;
	@property(ElementTypes.is)
	type: ElementTypes;
	protected constructor() {
		throw new Error(`Don't instantiate`);
	}
}



@element()
class _V extends _Element implements Required<V> {
	@property(value => value === ElementTypes.vertex)
	type: ElementTypes.vertex;
	@property(VertexLabels.is)
	label: VertexLabels;
	protected constructor() {
		super();
		throw new Error(`Don't instantiate`);
	}
}

@element()
class _Event extends _V implements Required<Event> {
	@property(value => value === VertexLabels.event)
	label: VertexLabels.event;
	@property(EventScope.is)
	scope: EventScope;
	@property(EventKind.is)
	kind: EventKind;
	@property(Id.is)
	data: Id;
	protected constructor() {
		super();
		throw new Error(`Don't instantiate`);
	}
}

@element()
export class _GroupEvent extends _Event implements Required<GroupEvent> {
	@property(value => value === EventScope.group)
	scope: EventScope.group;
	protected constructor() {
		super();
		throw new Error(`Don't instantiate`);
	}
}

@element()
export class _ProjectEvent extends _Event implements Required<ProjectEvent> {
	@property(value => value === EventScope.project)
	scope: EventScope.project;
	protected constructor() {
		super();
		throw new Error(`Don't instantiate`);
	}
}

@element()
export class _DocumentEvent extends _Event implements Required<DocumentEvent> {
	@property(value => value === EventScope.document)
	scope: EventScope.document;
	protected constructor() {
		super();
		throw new Error(`Don't instantiate`);
	}
}

@element()
export class _MonikerAttachEvent extends _Event implements Required<MonikerAttachEvent> {
	@property(value => value === EventScope.monikerAttach)
	scope: EventScope.monikerAttach;
	protected constructor() {
		super();
		throw new Error(`Don't instantiate`);
	}
}

@element()
export class _ResultSet extends _V implements Required<ResultSet> {
	@property(value => value === VertexLabels.resultSet)
	label: VertexLabels.resultSet;
	protected constructor() {
		super();
		throw new Error(`Don't instantiate`);
	}
}

@element()
export class _Range extends _V implements Required<Range>, Required<lsp.Range> {
	@property(value => value === VertexLabels.range)
	label: VertexLabels.range;
	@property(RangeTag.is)
	tag: RangeTag;
	@property(lsp.Position.is)
	start: lsp.Position;
	@property(lsp.Position.is)
	end: lsp.Position;

	protected constructor() {
		super();
		throw new Error(`Don't instantiate`);
	}
}
