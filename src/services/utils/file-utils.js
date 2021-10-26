const fse = require('fs-extra');

function escapeRegExp(str) {
    return str ? str.replace(/([.*+?^=!:${}()|[\]/\\])/g, '\\$1') : '';
}

async function patchFile(fileName, patches) {
    const fileExists = await fse.pathExists(fileName);
    if (!fileExists) {
        return false;
    }
    let data = await fse.readFile(fileName, 'utf8');
    Object.keys(patches).forEach(searchValue => {
        const replaceValue = patches[searchValue];
        data = data.replace(new RegExp(escapeRegExp(searchValue), 'g'), replaceValue);
    });
    await fse.outputFile(fileName, data);
    return true;
}

module.exports = {
    patchFile
};
