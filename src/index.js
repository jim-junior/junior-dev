const startServer = require('./server');

(async () => {
    try {
        await startServer();
    } catch (error) {
        console.log(error);
        process.exit(65);
    }
})();
