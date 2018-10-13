import { BehaviorSubject, Subject } from 'rxjs';
import { ResourceAddition, ResourceRemoval, ResourceUpdate } from './collections';

/**
 * Provides the caching and streaming functionality
 * for the client-side API usage.
 */
export class Client {
    public resourceAddition$ = new Subject<ResourceAddition<any, any>>();
    public resourceUpdate$ = new Subject<ResourceUpdate<any, any>>();
    public resourceRemoval$ = new Subject<ResourceRemoval<any, any>>();
    public optimisticAdditions$ = new BehaviorSubject<Array<ResourceAddition<any, any>>>([]);
    public optimisticUpdates$ = new BehaviorSubject<Array<ResourceUpdate<any, any>>>([]);
    public optimisticRemovals$ = new BehaviorSubject<Array<ResourceRemoval<any, any>>>([]);
}
