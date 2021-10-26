module.exports = {
    preset: '@shelf/jest-mongodb',
    testRegex: 'src/.*\\.test\\.ts$',
    transform: {
        '^.+\\.(t|j)s?$': [
            '@swc/jest', {
                sourceMaps: 'inline',
                module: {
                    type: 'commonjs'
                },
                env: {
                    targets: {
                        node: '14'
                    }
                },
                jsc: {
                    parser: {
                        syntax: 'typescript',
                        dynamicImport: true
                    }
                }
            }]
    },
    collectCoverage: true,
    coverageProvider: 'v8',
    extensionsToTreatAsEsm: ['.ts'],
    watchPathIgnorePatterns: ['globalConfig'],
    resolver: 'jest-node-exports-resolver',
    // jest still use facebooks "haste" module resolver in case of cold run or --no-cache option
    modulePathIgnorePatterns: ['<rootDir>/data/']
};
