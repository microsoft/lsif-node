import * as LSIF from 'lsif-protocol';
import { getFilteredIds } from '../filter';

const emptyFilter = {
    id: [],
    inV: [],
    outV: [],
    type: [],
    label: [],
    property: [],
    regex: undefined
}

const mockInput = [
    { id: '1', type: LSIF.ElementTypes.vertex, label: LSIF.VertexLabels.document },
    { id: '2', type: LSIF.ElementTypes.vertex, label: LSIF.VertexLabels.range },
    { id: '3', type: LSIF.ElementTypes.vertex, label: LSIF.VertexLabels.range, tag: { text: 'foo' } },
    { id: '4', type: LSIF.ElementTypes.edge, label: LSIF.EdgeLabels.contains, outV: 1, inV: 2 },
    { id: '5', type: LSIF.ElementTypes.edge, label: LSIF.EdgeLabels.contains, outV: 1, inV: 3 },
    { id: '6', type: LSIF.ElementTypes.vertex, label: LSIF.VertexLabels.referenceResult },
    { id: '7', type: LSIF.ElementTypes.edge, label: LSIF.EdgeLabels.item, property: LSIF.ItemEdgeProperties.references, outV: 6, inV: 3 }
]

describe('The main console-line interface', () => {
    describe('The filters', () => {
        it('Should return the whole input if no filter is specified', () => {
            const ids = getFilteredIds(emptyFilter, mockInput);
            expect(ids.length).toEqual(mockInput.length);
            mockInput.forEach(element => expect(ids).toContain(element.id));
        }),
        it('Should filter by id', () => {
            const filter = { ...emptyFilter, id: ['1', '2'] };
            const ids = getFilteredIds(filter, mockInput);
            expect(ids.length).toEqual(filter.id.length);
            filter.id.forEach(id => expect(ids).toContain(id));
        }),
        it('Should filter by inV', () => {
            const filter = { ...emptyFilter, inV: ['2'] };
            const ids = getFilteredIds(filter, mockInput);
            expect(ids.length).toEqual(1);
            expect(ids).toContain('4');
        }),
        it('Should filter by outV', () => {
            const filter = { ...emptyFilter, outV: ['1'] };
            const ids = getFilteredIds(filter, mockInput);
            expect(ids.length).toEqual(2);
            expect(ids).toContain('4');
            expect(ids).toContain('5');
        }),
        it('Should filter by label', () => {
            const filter = { ...emptyFilter, label: ['range'] };
            const ids = getFilteredIds(filter, mockInput);
            expect(ids.length).toEqual(2);
            expect(ids).toContain('2');
            expect(ids).toContain('3');
        }),
        it('Should filter by property', () => {
            const filter = { ...emptyFilter, property: ['references'] };
            const ids = getFilteredIds(filter, mockInput);
            expect(ids.length).toEqual(1);
            expect(ids).toContain('7');
        }),
        it('Should filter by regex', () => {
            const filter = { ...emptyFilter, regex: 'foo' };
            const ids = getFilteredIds(filter, mockInput);
            expect(ids.length).toEqual(1);
            expect(ids).toContain('3');
        }),
        it('Should be able to combine filters', () => {
            const filter = { ...emptyFilter, regex: 'foo', label: ['range'] };
            const ids = getFilteredIds(filter, mockInput);
            expect(ids.length).toEqual(1);
            expect(ids).toContain('3');
        })
    })
});