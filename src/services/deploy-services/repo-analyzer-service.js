function gemfileContainsGem(gemfileData, gemName) {
    return gemfileData.includes(`gem "${gemName}"`) || gemfileData.includes(`gem '${gemName}'`);
}

function gemfileContainsGemspec(gemfileData) {
    return gemfileData.includes('gemspec');
}

module.exports = {
    gemfileContainsGem,
    gemfileContainsGemspec
};
