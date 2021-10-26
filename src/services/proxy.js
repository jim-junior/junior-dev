const Proxy = require('http-proxy-middleware/dist/http-proxy-middleware').HttpProxyMiddleware;

module.exports = (context, opts) => {
    const proxy = new Proxy(context, opts);

    const origLogError = proxy.logError;
    proxy.proxy.removeListener('error', origLogError);
    proxy.logError = function(err, req) {
        if (req.aborted && err.code === 'ECONNRESET') {
            return;
        }
        origLogError.apply(this, arguments);
    };
    proxy.proxy.on('error', proxy.logError);

    return proxy.middleware;
};
