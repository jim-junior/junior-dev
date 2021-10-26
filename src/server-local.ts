import config from './config';
import https from 'https';
import http, { RequestListener } from 'http';
import fs from 'fs';
import axios from 'axios';
import ngrok, { INgrokOptions } from 'ngrok';
import _ from 'lodash';

export async function configureLocalServer(app: RequestListener) {
    process.title = 'node-stackbit-api';

    const externalUrl = await fetchOpenNgrokTunnel();
    if (externalUrl) {
        config.server.webhookHostname = externalUrl.replace(/^http:/, 'https:');
    }

    const options = {
        key: fs.readFileSync('./server-local.key'),
        cert: fs.readFileSync('./server-local.cert'),
        requestCert: false,
        rejectUnauthorized: false
    };

    https.createServer(options, app).listen(8082, function () {
        console.log('listening to https on 8082');
    });
    http.createServer(app).listen(8081, function () {
        console.log('listening to http on 8081');
    });
}

interface NgrokApiTunnelsResponse {
    tunnels?: {
        config?: {
            addr?: string
        },
        public_url?: string
    }[]
}

async function fetchOpenNgrokTunnel() {
    try {
        try {
            const resp = await axios.get<NgrokApiTunnelsResponse>('http://localhost:4040/api/tunnels');
            let tunnel = _.find(resp?.data?.tunnels, { config: { addr: 'http://localhost:8081' } });
            if (!tunnel) {
                throw 'no tunnel found';
            }
            console.log('found existing ngrok url', tunnel.public_url);
            return tunnel.public_url;
        } catch (err){
            return createNgrokTunnel();
        }
    } catch (err) {
        console.error('Cannot create ngrok tunnel, did you configure an ngrok access token?');
    }
}

async function createNgrokTunnel() {
    const options: INgrokOptions = { addr: 8081 };
    const ngrokSubdomain = process.env.NGROK;
    if (ngrokSubdomain) {
        options.subdomain = ngrokSubdomain;
    }
    const url = await ngrok.connect(options);
    console.log('created new ngrok url', url);
    return url;
}
