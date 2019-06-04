/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
import * as LSIF from 'lsif-protocol';
import { getFilteredIds, IFilter } from '../filter';

const emptyFilter: IFilter = {
    id: [],
    inV: [],
    label: [],
    outV: [],
    property: [],
    regex: undefined,
    type: [],
};

const mockInput = [
    {
        id: '1',
        label: LSIF.VertexLabels.document,
        type: LSIF.ElementTypes.vertex,
    },
    {
        id: '2',
        label: LSIF.VertexLabels.range,
        type: LSIF.ElementTypes.vertex,
    },
    {
        id: '3',
        label: LSIF.VertexLabels.range,
        tag: { text: 'foo' },
        type: LSIF.ElementTypes.vertex,
    },
    {
        id: '4',
        inV: 2,
        label: LSIF.EdgeLabels.contains,
        outV: 1,
        type: LSIF.ElementTypes.edge,
    },
    {
        id: '5',
        inV: 3,
        label: LSIF.EdgeLabels.contains,
        outV: 1,
        type: LSIF.ElementTypes.edge,
    },
    {
        id: '6',
        label: LSIF.VertexLabels.referenceResult,
        type: LSIF.ElementTypes.vertex,
    },
    {
        id: '7',
        inV: 3,
        label: LSIF.EdgeLabels.item,
        outV: 6,
        property: LSIF.ItemEdgeProperties.references,
        type: LSIF.ElementTypes.edge,
    },
];

describe('The main console-line interface', () => {
    describe('The filters', () => {
        it('Should return the whole input if no filter is specified', () => {
            const ids: string[] = getFilteredIds(emptyFilter, mockInput);
            expect(ids.length)
            .toEqual(mockInput.length);
            mockInput.forEach((element: LSIF.Element) => expect(ids)
            .toContain(element.id));
        }),
        it('Should filter by id', () => {
            const filter: IFilter = { ...emptyFilter, id: ['1', '2'] };
            const ids: string[] = getFilteredIds(filter, mockInput);
            expect(ids.length)
            .toEqual(filter.id.length);
            filter.id.forEach((id: string) => expect(ids)
            .toContain(id));
        }),
        it('Should filter by inV', () => {
            const filter: IFilter = { ...emptyFilter, inV: ['2'] };
            const ids: string[] = getFilteredIds(filter, mockInput);
            expect(ids.length)
            .toEqual(1);
            expect(ids)
            .toContain('4');
        }),
        it('Should filter by outV', () => {
            const filter: IFilter = { ...emptyFilter, outV: ['1'] };
            const ids: string[] = getFilteredIds(filter, mockInput);
            expect(ids.length)
            .toEqual(2);
            expect(ids)
            .toContain('4');
            expect(ids)
            .toContain('5');
        }),
        it('Should filter by label', () => {
            const filter: IFilter = { ...emptyFilter, label: ['range'] };
            const ids: string[] = getFilteredIds(filter, mockInput);
            expect(ids.length)
            .toEqual(2);
            expect(ids)
            .toContain('2');
            expect(ids)
            .toContain('3');
        }),
        it('Should filter by property', () => {
            const filter: IFilter = { ...emptyFilter, property: ['references'] };
            const ids: string[] = getFilteredIds(filter, mockInput);
            expect(ids.length)
            .toEqual(1);
            expect(ids)
            .toContain('7');
        }),
        it('Should filter by regex', () => {
            const filter: IFilter = { ...emptyFilter, regex: 'foo' };
            const ids: string[] = getFilteredIds(filter, mockInput);
            expect(ids.length)
            .toEqual(1);
            expect(ids)
            .toContain('3');
        }),
        it('Should be able to combine filters', () => {
            const filter: IFilter = { ...emptyFilter, regex: 'foo', label: ['range'] };
            const ids: string[] = getFilteredIds(filter, mockInput);
            expect(ids.length)
            .toEqual(1);
            expect(ids)
            .toContain('3');
        });
    });
});
