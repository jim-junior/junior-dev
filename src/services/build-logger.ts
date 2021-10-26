import winston from 'winston';
import logger from './logger';

export function BuildLogger(projectId: string, userId: string, { profiling = false } = {}) {
    const buildLogger = logger.child({projectId: projectId, userId: userId});
    if (profiling) {
        const anyBuildLogger = buildLogger as any;
        anyBuildLogger.timer = process.hrtime();
        anyBuildLogger.mark = markStep.bind(buildLogger, anyBuildLogger.timer);
    }
    // TODO: stream transporter here for socket and saving, receive project object to save to it.
    return buildLogger;
};

function markStep(this: winston.Logger, timer: [number, number], note: string, props: unknown){
    const precision = 3; // 3 decimal places
    const elapsed = process.hrtime(timer)[1] / 1000000; // divide by a million to get nano to milli
    this.debug(`Build profiling: ${process.hrtime(timer)[0]}s, ${elapsed.toFixed(precision)}ms - ${note}`, props); // print message + time
}
