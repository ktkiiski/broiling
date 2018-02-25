import { CloudWatchLogs } from 'aws-sdk';
import { mergeAsync, toArray, wait } from '../async';
import { retrievePages } from './utils';

export interface LogStreamOptions {
    logGroupName: string;
    startTime: number;
    follow: boolean;
    maxCount?: number;
}

export interface MultiLogStreamOptions {
    logGroupNames: string[];
    startTime: number;
    follow: boolean;
    maxCount?: number;
}

export interface LogEvent {
    /**
     * The name of the log stream this event belongs to.
     */
    logStreamName: string;
    /**
     * The name of the log group this event belongs to.
     */
    logGroupName: string;
    /**
     * The time the event occurred, expressed as the number of milliseconds after Jan 1, 1970 00:00:00 UTC.
     */
    timestamp: number;
    /**
     * The data contained in the log event.
     */
    message: string;
    /**
     * The time the event was ingested, expressed as the number of milliseconds after Jan 1, 1970 00:00:00 UTC.
     */
    ingestionTime: number;
    /**
     * The ID of the event.
     */
    eventId: string;
}

/**
 * Wrapper class for Amazon S3 operations with a reactive interface.
 */
export class AmazonCloudWatch {

    private cloudWatch = new CloudWatchLogs({
        region: this.region,
        apiVersion: '2014-03-28',
    });

    constructor(private region: string) { }

    public async *streamLogGroups(options: MultiLogStreamOptions): AsyncIterableIterator<LogEvent> {
        // First stream everything got so far
        const {logGroupNames, follow} = options;
        let {maxCount = Infinity, startTime} = options;
        if (maxCount <= 0) {
            return;
        }
        const eventIterators = logGroupNames.map(
            (logGroupName) => this.iterateLogEvents({logGroupName, maxCount, startTime}),
        );
        const oldEvents = await toArray(mergeAsync(...eventIterators));
        // TODO: Could do merge sort for the iterators for better performance for large log groups
        const sortedEvents = oldEvents.sort((a, b) => a.timestamp - b.timestamp);
        for (const event of sortedEvents) {
            yield event;
            maxCount --;
            if (maxCount <= 0) {
                return;
            }
            startTime = event.timestamp + 1;
        }
        // Follow if enabled
        while (follow) {
            const iterator = this.streamLogGroups({logGroupNames, startTime, maxCount, follow: false});
            for await (const event of iterator) {
                yield event;
                maxCount --;
                if (maxCount <= 0) {
                    return;
                }
                startTime = event.timestamp + 1;
            }
            // Wait for a while before polling more
            await wait(1000);
        }
    }

    public async *iterateLogEvents(options: {logGroupName: string, startTime: number, maxCount?: number}) {
        const {logGroupName, startTime} = options;
        let {maxCount = Infinity} = options;
        const request = this.cloudWatch.filterLogEvents({
            logGroupName, startTime,
            interleaved: true,
        });
        for await (const page of retrievePages(request, 'events')) {
            if (!page) {
                continue;
            }
            for (const event of page) {
                yield {...event, logGroupName} as LogEvent;
                maxCount --;
                // Stop if yielded max number of events
                if (maxCount <= 0) {
                    return;
                }
            }
        }
    }
}
