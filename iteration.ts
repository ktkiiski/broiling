class SharedAsyncIterable<T> implements AsyncIterable<T> {
    private buffer: Array<Promise<IteratorResult<T>>> = [];
    constructor(private iterator: AsyncIterator<T>) {}

    public [Symbol.asyncIterator](): AsyncIterator<T> {
        return new SharedIterator(this.buffer, this.iterator);
    }
}

class SharedIterator<T> implements AsyncIterator<T> {
    private index = 0;
    constructor(private buffer: Array<Promise<IteratorResult<T>>>, private iterator: AsyncIterator<T>) {}

    public next(value?: any): Promise<IteratorResult<T>> {
        // TODO: Do not cache anything called after completion
        const index = (this.index ++);
        const {buffer} = this;
        let promise = buffer[index];
        if (promise == null) {
            promise = buffer[index] = this.iterator.next(value);
            // TODO: Forget the reference to the original iterator when complete!
        }
        return promise;
    }
}

/**
 * Wraps an iterator so that it can be iterated multiple times,
 * even at the same time, consuming the original iterator once,
 * cachiing the results, and yielding them to any new iterators.
 */
export function shareIterator<T>(iterator: AsyncIterator<T>): AsyncIterable<T> {
    return new SharedAsyncIterable(iterator);
}