import _ from 'lodash';
import type * as Contentful from 'contentful-management/types';
import { getEntryField } from './contentful-project-service';

const processEntryErrors = ({ errorObject, entry, locale, spaceId }: { errorObject: Contentful.BulkActionProps['error'], entry: Contentful.EntryProps, locale: string, spaceId: string }) => {
    return errorObject?.details?.errors?.map((error: any) => {
        // ['fields', 'title'] => ['title']
        const fieldPath = _.tail(error.path);
        if (_.last(error.path) === locale) {
            fieldPath.pop();
        }
        const fieldValue = getEntryField(entry, fieldPath, locale);
        const srcObjectId = _.get(entry, 'sys.id');
        return {
            message: error.customMessage || error.details,
            data: {
                field: {
                    fieldPath,
                    srcObjectId,
                    srcProjectId: spaceId,
                    fieldValue: _.isUndefined(fieldValue) ? '' : fieldValue
                }
            }
        };
    });
};

module.exports = {
    processEntryErrors
};
