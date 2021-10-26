import _ from 'lodash';
import baseConfig, {
    BaseConfig,
    Config as OriginalConfig,
} from './base-config';
import aws from 'aws-sdk';

type IfAny<T, Y, N> = 0 extends (1 & T) ? Y : N;

// When OriginalConfig is any, when building the config, we just set Config to be any without modifications.
type Config = IfAny<OriginalConfig, any, Omit<OriginalConfig, 'userGroups' | 'upgradeHookSchemes'> & {
    userGroups: Record<string, OriginalConfig['userGroups']['nocode']>;
    upgradeHookSchemes: Record<
        string,
        OriginalConfig['upgradeHookSchemes']['2021a']
    >;
}>;

let configLoaded = false;
const config = {};
export default config as Config;

function fetchSecrets(config: any) {
    const client = new aws.SecretsManager({
        region: 'us-east-1',
    });

    const secretName = `${config.env}/stackbit-api`;

    return new Promise((resolve, reject) => {
        client.getSecretValue({ SecretId: secretName }, (err, data) => {
            if (err || !data.SecretString) {
                return reject(err);
            }
            const secrets = JSON.parse(data.SecretString);
            return resolve(secrets);
        });
    });
}

function readFromEnv() {
    if (process.env.STACKBIT_SECRETS) {
        return JSON.parse(process.env.STACKBIT_SECRETS);
    }
}

export async function addSecretsToConfig(
    baseConfig: BaseConfig
): Promise<Config> {
    const config: Config = baseConfig as any;
    if (!config.features.secretsManager) {
        return config;
    }
    let secrets: any;
    if (config.env === 'local') {
        secrets = await fetchSecrets(config);
    } else if (!_.isEmpty(process.env.STACKBIT_SECRETS)) {
        secrets = readFromEnv();
    } else {
        throw new Error(
            'Can\'t load secrets. Make sure STACKBIT_SECRETS is set.'
        );
    }
    Object.keys(secrets).forEach((secretKey) => {
        _.set(config, secretKey, secrets[secretKey]);
    });
    return config;
}

export async function loadConfig(): Promise<Config> {
    if (!configLoaded) {
        configLoaded = true;
        const fullConfig = await addSecretsToConfig(baseConfig);
        Object.assign(config, fullConfig);
    }
    return config as Config;
}
