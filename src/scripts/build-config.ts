import { buildConfig } from 'single-config';
import { addSecretsToConfig } from '../config';

const envName = process.argv[2];

(async () => {
    await buildConfig(
        './config.json',
        './src/base-config.ts',
        {
            env: envName,
            moduleType: 'typescript',
            loadDynamicConfig: addSecretsToConfig,
            excludeDynamicConfigFromFile: true,
            typeOnlyOutput: './src/base-config-types.ts'
        }
    );
})()
