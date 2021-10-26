# stackbit-api

Backend API server for the frontend app stackbit-app

## Private NPM Token

The API server uses npm packages from the private Stackbit npm registry. You will need an npm account and your npm username needs to be added to the Stackbit npm registry.

For local development, create a token and add it to the node environment.

```
npm token create
```

```
export NPM_TOKEN=00000000-0000-0000-0000-000000000000
```

## AWS Secret Manager

To run the api server locally you will need a IAM account with AWS. Have Simon create an account for you.

Add the following AWS tokens to your env

```
export AWS_ACCESS_KEY_ID=XXXXXXXX
export AWS_SECRET_ACCESS_KEY=XXXXXXXXXX
```

## Local Server

Run the local API server:

```
npm run build-config:local && npm start
```

Or use `start:no-watch` so the server isn't restarted whenever you edit code.

```
npm run build-config:local && npm run start:no-watch
```

## Tests

Run tests using jest. it would look for code changes and re-run the related tests after saving the files.

```
npm run test
```

Naming convention:

1. Unit tests: for a file named `x.ts` create tests in a file named `x.test.ts`
1. Other tests:
   use meaningful file name ends with `test.ts` in `src/tests` folder, group tests in subfolders by topic
1. Test utils exists in `src/test-utils/`

## Run container locally

1. Clone stackbit-container next to stackbit-api (both must be in the same parent directory).
1. Set up stackbit-container (`npm install && npm run build-config:local`).
1. In `config.json`, change `localContainerMode.local` to be `true`.
1. In `config.json`, change `forceUpdateContainerUrl.local` to be `true`.

This will stream all container logs to api's logs. If this is undesirable, in `config.json` turn off
`outputLocalContainerLogs`.

## Create MongoDB migrations

Create migration at `src/migrations/{timestamp}-{migration-name}.ts`, e.g.:
`src/migrations/20201022145804-add-user-role.ts`. Open the migration file and implement
the `up` and `down` methods. Visit [migrate-mongo](https://github.com/seppevs/migrate-mongo)
for more info on how to implement migrations. You can also import mongoose models in
migration scripts. Also you can use existing migrations as an example inside `src/migrations/` folder.

Next time the server starts it will run all migrations that were not yet run.
The state of all migrations is stored in mongo inside `migrations` collection.

> Note: For some developers migrations might fail running regular `npm start` because of weird behavior of `ts-node-server` in watch mode.
> Use `npm run start:no-watch` instead.

### Stripe

To test the Stripe integration locally, including listening to webhooks sent by Stripe, you must be added to the Stackbit account on Stripe.

After that, take the following steps:

1. Install the [Stripe CLI](https://stripe.com/docs/stripe-cli)

1. Sign in to the Stackbit account using `stripe login`

1. Run `npm run stripe-webhook-listen`

1. The command above will give you a secret key. Use it as an environment variable when running the app.

    ```sh
    STRIPE_WEBHOOK_SECRET=<your-webhook-secret> npm start
    ```

### External api types sync with APP project script

note that script requires that `/stackbit-app` folder would be sibling of `/stackbit-api`

To update App's project external api types:

1. add export to external-api-types.ts
1. run `./npm run update-external-api-types:copy` from `/stackbit-api/`
