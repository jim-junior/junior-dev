/* As of April 26th, 2021 there is an open PR to the customerio-node project to convert it to TypeScript.
   Presumably once merged, they would have exposed type definitions and this file should be deleted.
   Foreseeing that, the monkey-patching type definitions in this file are kept to a minimum. */

declare module 'customerio-node/api' {
    export interface SendEmailRequestOptions {
        to: string;
        transactional_message_id: number;
        identifiers: {
            id: string;
        };
        message_data: Record<string, any>;
    }

    export class SendEmailRequest {
        constructor(request: SendEmailRequestOptions);
    }

    export class APIClient {
        constructor(key: string);

        sendEmail(request: SendEmailRequest): Promise<unknown>;
    }
}
