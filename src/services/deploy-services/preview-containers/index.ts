import { IProjectDoc } from '../../../models/project.model';
import { sharedContainerService } from './shared-container-service';
import { localContainerService } from './local-container-service';
import { PreviewContainerService } from './common-container-service';

export { PreviewContainerService } from './common-container-service';

export function getProjectPreviewContainerService(project: IProjectDoc): PreviewContainerService {
    switch (project.previewContainerMode) {
        case 'shared': {
            return sharedContainerService;
        }
        case 'local': {
            return localContainerService;
        }
        default: {
            throw new Error(`Unknown preview container mode ${project.previewContainerMode}`);
        }
    }
}

export async function forEachPreviewContainerService(f: (service: PreviewContainerService) => (Promise<void> | void)): Promise<void> {
    await Promise.all([
        f(localContainerService),
        f(sharedContainerService)
    ]);
}
