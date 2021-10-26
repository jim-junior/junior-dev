import { createMongooseQuery, SortedPagesParams } from './sortedpages.utils';

describe('createMongooseQuery', () => {
    test('paging', async () => {
        const sortedPagesParams = { sortByField: 'createdAt', sortDirection: 1, pageSize: 10, pageIndex: 5 } as SortedPagesParams;
        const findParams = createMongooseQuery(sortedPagesParams);
        expect(findParams.filter).toStrictEqual({});
        expect(findParams.options).toStrictEqual({ sort: { createdAt: 1 }, limit: 10, skip: 50 });
    });
    test('next page', async () => {
        const sortedPagesParams = {
            sortByField: 'createdAt',
            sortDirection: 1,
            pageSize: 10,
            lastPageLastItemVal: 'zzz'
        } as SortedPagesParams;
        let findParams = createMongooseQuery(sortedPagesParams);
        expect(findParams.filter).toStrictEqual({ createdAt: { $gt: 'zzz' } });
        expect(findParams.options).toStrictEqual({ sort: { createdAt: 1 }, limit: 10 });

        sortedPagesParams.sortDirection = -1;
        findParams = createMongooseQuery(sortedPagesParams);
        expect(findParams.filter).toStrictEqual({ createdAt: { $lt: 'zzz' } });
        expect(findParams.options).toStrictEqual({ sort: { createdAt: -1 }, limit: 10 });
    });
    test('defaults', async () => {
        let sortedPagesParams = { pageIndex: 5 } as SortedPagesParams;
        let findParams = createMongooseQuery(sortedPagesParams, 'createdAt', 1, 10);
        expect(findParams.filter).toStrictEqual({});
        expect(findParams.options).toStrictEqual({ sort: { createdAt: 1 }, limit: 10, skip: 50 });

        sortedPagesParams = {
            sortByField: 'updatedAt',
            sortDirection: -1,
            pageSize: 20,
            pageIndex: 5
        } as SortedPagesParams;
        findParams = createMongooseQuery(sortedPagesParams, 'createdAt', 1, 10);
        expect(findParams.filter).toStrictEqual({});
        expect(findParams.options).toStrictEqual({ sort: { updatedAt: -1 }, limit: 20, skip: 100 });
    });
    test('minimal params', async () => {
        const sortedPagesParams = {} as SortedPagesParams;
        const findParams = createMongooseQuery(sortedPagesParams);
        expect(findParams.filter).toStrictEqual({});
        expect(findParams.options).toStrictEqual({});
    });
});
