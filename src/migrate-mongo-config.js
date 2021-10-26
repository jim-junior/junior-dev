const config = require('./config').default;
// In this file you can configure migrate-mongo


module.exports = {
    mongodb: {
        url: config.mongo.url,
        options: {
            useNewUrlParser: true, // removes a deprecation warning when connecting
            useUnifiedTopology: true, // removes a deprecating warning when connecting
            //   connectTimeoutMS: 3600000, // increase connection timeout to 1 hour
            //   socketTimeoutMS: 3600000, // increase socket timeout to 1 hour
        }
    },

    // The migrations dir, can be an relative or absolute path. Only edit this when really necessary.
    migrationsDir: 'dist/migrations',

    // The mongodb collection where the applied changes are stored. Only edit this when really necessary.
    changelogCollectionName: 'migrations',

    // The file extension to create migrations and search for in migration dir
    migrationFileExtension: '.js'
};
