
function getProcessPromise(p) {
    return new Promise((resolve, reject) => {
        let data = '';
        let stderr = '';
        p.stdout.on('data', out => data += out);
        p.stderr.on('data', out => stderr += out);
        p.on('exit', (code) => {
            if (code !== 0) {
                reject(new Error(`process exited with code: ${code}, stderr: ${stderr}`));
            } else {
                resolve(data);
            }
        });
        p.on('error', (err) => {
            reject(err);
        });
    });
}

module.exports = {
    getProcessPromise
};