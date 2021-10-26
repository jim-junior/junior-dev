import config from '../../config';
import { IUserDoc } from '../../models/user.model';
import {
    SimpleCommit,
} from '@octokit/webhooks-definitions/schema';

interface UrlRepoInfo {
    repo: string;
    owner: string;
}

export const determineCommitSource = (commit: SimpleCommit): string | undefined => {
    const committerName = commit?.committer?.name;

    if (!committerName) {
        return undefined;
    }

    const studioSources = ['Stackbit', 'stackbit', 'stackbit-projects'];
    const cmsSources = ['Forestry'];
    const githubSources = ['GitHub']; // if you edit and commit a file using Github.com the committer name will be "GitHub"

    if (commit?.author?.name === 'Stackbit Code Editor') {
        return 'code-editor';
    }
    if (studioSources.includes(committerName)) {
        if (commit?.message.endsWith(': updated by Schema Editor')) {
            return 'schema-editor';
        }
        return 'studio';
    }
    if (cmsSources.includes(committerName)) {
        return 'cms';
    }
    if (githubSources.includes(committerName)) {
        return 'github-web-flow';
    }
    return 'developer';
};

export const decodeRepoUrl = (repoUrl: string): UrlRepoInfo => {
    const match = repoUrl.match(/github\.com[/:](.+?)\/(.+?)(\.git)?$/);
    const owner = match?.[1] ?? '';
    const repo = match?.[2] ?? '';
    return { owner, repo };
};

export const isValidGithubUrl = (url: string): boolean => {
    const pattern = '^(?:git|https?|git@)(?:\\:\\/\\/)?github.com[/|:][A-Za-z0-9-]+?' + '\\/[\\w\\.-]+\\/?(?!=.git)(?:\\.git(?:\\/?|\\#[\\w\\.\\-_]+)?)?$';
    const re = new RegExp(pattern);
    return re.test(url);
};

export const getUserOrPublicGithubToken = (user: IUserDoc | null): string | undefined | null => {
    const publicPersonalAccessToken = config?.github?.publicPersonalAccessToken ?? null;
    return user?.githubAccessToken || publicPersonalAccessToken;
};
