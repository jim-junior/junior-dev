import mongoose from 'mongoose';

export type SortedPagesParams = {
    sortByField?: string; // name of the field to sort by
    sortDirection?: 1 | -1;
    pageSize?: number; // result length
    lastPageLastItemVal?: string; // last item sortByField value
    pageIndex?: number; // zero based page index
};

export interface MongooseQuery {
    filter: mongoose.FilterQuery<any>;
    options: mongoose.QueryOptions;
}

export function createMongooseQuery(
    sortedPagesParams: SortedPagesParams,
    defaultSortField?: string,
    defaultSortDirection?: 1 | -1,
    defaultPageSize?: number
): MongooseQuery {
    const sortBy = sortedPagesParams.sortByField ?? defaultSortField;
    const sortDirection = sortedPagesParams.sortDirection ?? defaultSortDirection;
    const pageSize = sortedPagesParams.pageSize ?? defaultPageSize;
    const filter: Record<string, any> = {};
    const options: Record<string, any> = {};

    if (sortBy) {
        options.sort = {
            [sortBy]: sortDirection
        };
        if (pageSize) {
            options.limit = pageSize;
            const from = sortedPagesParams.lastPageLastItemVal;
            const pageIdx = sortedPagesParams.pageIndex;
            if (from) {
                filter[sortBy] = sortDirection === -1 ? { $lt: from } : { $gt: from };
            } else if (pageIdx && pageIdx > 0) {
                options.skip = pageIdx * pageSize;
            }
        }
    }
    return { options, filter };
}

export function parseSortDirection(sortDirection: any): 1 | -1 | undefined {
    if (sortDirection === '1') return 1;
    if (sortDirection === '-1') return -1;
    return undefined;
}
