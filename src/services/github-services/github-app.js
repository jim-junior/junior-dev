const { Octokit } = require('@octokit/rest');

async function getUserInstallations(user, token) {
    return new Octokit({auth: 'token ' + token}).apps.listInstallationsForAuthenticatedUser().then(result => {
        const githubConnection = user.connections.find(con => con.type === 'github-app');
        return result.data.installations.filter(installation => {
            if (installation.target_type === 'Organization') {
                return true;
            }

            return githubConnection.connectionUserId ? installation.target_id === parseInt(githubConnection.connectionUserId, 10) : true;
        });
    });
}

module.exports = {
    getUserInstallations
};