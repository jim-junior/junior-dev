const _ = require('lodash');
const responseErrors = require('../../routers/response-errors');

class CustomError extends Error {
    constructor(errorObj, ...params) {
        // Pass remaining arguments (including vendor specific ones) to parent constructor
        super(...params);

        // Maintains proper stack trace for where our error was thrown (only available on V8)
        if (Error.captureStackTrace) {
            Error.captureStackTrace(this, CustomError);
        }

        // assign main errorObj values to CustomError class props
        // this.name = errorObj.name
    }
}

class ResponseError extends CustomError {
    constructor(name, messageOptions, ...params) {
        super({}, ...params);

        let error = responseErrors?.[name];

        if (_.isFunction(error)) {
            error = error(messageOptions);
        }

        if (!isKnownError(error)) {
            this.name = 'UnknownResponseError';
            return;
        }

        this.name = error.name;
        this.status = error.status;
        this.message = error.message;
    }
}

const isKnownError = (error) => {
    return !!responseErrors?.[error.name];
};

module.exports = {
    isKnownError,
    ResponseError
};
