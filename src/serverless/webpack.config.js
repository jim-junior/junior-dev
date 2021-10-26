const webpack = require('webpack');
const slsw = require('serverless-webpack');
var nodeExternals = require('webpack-node-externals');
const CopyWebpackPlugin = require('copy-webpack-plugin');

// webpack.config.js
module.exports = {
    mode: 'production',
    entry: slsw.lib.entries,
    target: 'node',
    externals: [nodeExternals()],
    module: {},
    plugins: [
        new CopyWebpackPlugin([
            {
                from: './lib**',
                to: './',
            }
        ]),
    ],
};