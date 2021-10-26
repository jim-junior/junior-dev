// error handling helpers

export const getThrownError = async (f: (...args: any[]) => any): Promise<Error> => {
    let error;
    try {
        await f();
        throw new Error('error was not thrown');
    } catch (e: any) {
        error = e;
    }
    return error;
};

export const expectedNotFoundError = {
    message: 'Not found!',
    name: 'NotFound',
    status: 404
};
