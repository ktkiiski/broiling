import { Subscribable } from 'rxjs/Observable';
import { defer } from 'rxjs/observable/defer';
import { of } from 'rxjs/observable/of';
import { Api } from './api';
import { HttpCallback, HttpStatus } from './http';
import { IHttpHeaders, IHttpResponse } from './http';
import { IHttpRequest, IHttpRequestContext } from './http';
import { isReadHttpMethod, isWriteHttpMethod } from './http';
import includes = require('lodash/includes');
import isNumber = require('lodash/isNumber');
import isObject = require('lodash/isObject');
import isString = require('lodash/isString');
import mapValues = require('lodash/mapValues');
import sortBy = require('lodash/sortBy');
// tslint:disable:max-classes-per-file

export interface IApiResponse<T> {
    statusCode: HttpStatus;
    data?: T;
    headers: IHttpHeaders;
}

export class ApiResponse<T> implements IApiResponse<T> {
    constructor(public readonly statusCode: HttpStatus, public readonly data?: T, public readonly headers: IHttpHeaders = {}) {}
}

export type ApiEndpointHandler<I extends object, O> = (input: I, event: IHttpRequest, context: IHttpRequestContext) => Subscribable<IApiResponse<O>>;

class ApiError extends Error implements IHttpResponse {
    public readonly body: string;
    constructor(public statusCode: HttpStatus, message: string, public headers: IHttpHeaders = {}) {
        super(message);
        this.body = JSON.stringify({message});
    }
}

export interface IPage<T> {
    next: string | null;
    results: T[];
}

export class ApiEndpoint<I extends object, O> implements IApiEndpoint<I> {

    public readonly path: string[];

    constructor(public api: Api<I>, private run: ApiEndpointHandler<I, O>) {
        this.path = api.url.replace(/^\/|\/$/, '').split('/');
    }

    public deserialize(event: IHttpRequest): Subscribable<I> {
        const {httpMethod, queryStringParameters, body, pathParameters} = event;
        const decodedPathParameters = mapValues(pathParameters, (value) => {
            if (!value) {
                return value;
            }
            try {
                return decodeURIComponent(value);
            } catch (e) {
                throw new ApiError(HttpStatus.BadRequest, `Invalid URL component`);
            }
        });
        if (!includes(this.api.methods, httpMethod)) {
            throw new ApiError(HttpStatus.MethodNotAllowed, `Method ${httpMethod} is not allowed`);
        }
        let input = {...queryStringParameters, ...decodedPathParameters};
        if (body) {
            let payload;
            try {
                payload = JSON.parse(body);
            } catch (e) {
                throw new ApiError(HttpStatus.BadRequest, `Request payload is not valid JSON`);
            }
            if (!isObject(payload)) {
                throw new ApiError(HttpStatus.BadRequest, `Request payload is not a JSON object`);
            }
            input = {...queryStringParameters, payload};
        }
        return of(
            mapValues(this.api.params, (field, name) => field.validate(input[name])),
        );
    }

    public execute(event: IHttpRequest, context: IHttpRequestContext, callback: HttpCallback) {
        event = this.normalizeRequest(event);
        defer(() => this.deserialize(event))
            .switchMap((input) => this.run(input, event, context))
            .map(({statusCode, data, headers}) => {
                const body = data === undefined ? '' : JSON.stringify(data);
                return {
                    statusCode, body,
                    headers: {
                        ...headers,
                        'Content-Type': 'application/json',
                        'Content-Length': String(body.length),
                    },
                } as IHttpResponse;
            })
            .single()
            .subscribe({
                next: (result) => callback(null, result),
                error: (error) => {
                    // Determine if the error was a HTTP method
                    const {statusCode, body, headers} = error || {} as any;
                    if (isNumber(statusCode) && isString(body) && isObject(headers)) {
                        // This was an intentional HTTP error, so it should be considered
                        // a successful execution of the lambda function.
                        callback(null, error);
                    } else {
                        // Something went wrong when handling the request.
                        // This will be a 500 Internal server error.
                        callback(error);
                    }
                },
            })
        ;
    }

    protected normalizeRequest(request: IHttpRequest): IHttpRequest {
        let {httpMethod} = request;
        const {queryStringParameters = {}} = request;
        const {method} = queryStringParameters;
        if (method) {
            // Allow changing the HTTP method with 'method' query string parameter
            if (httpMethod === 'GET' && isReadHttpMethod(method)) {
                httpMethod = method;
            } else if (httpMethod === 'POST' && isWriteHttpMethod(method)) {
                httpMethod = method;
            } else {
                throw new ApiError(HttpStatus.BadRequest, `Cannot perform ${httpMethod} as ${method} request`);
            }
        }
        // Return with possible changed HTTP method
        return { ...request, httpMethod };
    }
}

export interface IApiEndpoint<I extends object> {
    api: Api<I>;
    path: string[];
}

export class ApiRequestHandler<T extends {[endpoint: string]: IApiEndpoint<any>}> {

    private readonly sortedEndpoints: Array<IApiEndpoint<any>>;

    constructor(public readonly endpoints: T) {
        this.sortedEndpoints = sortBy(endpoints, (endpoint) => endpoint.api.url);
    }

    public request(_request: IHttpRequest, _context: IHttpRequestContext, callback: HttpCallback): void {
        // const endpoint = this.findMatchingEndpoint(request);
        // TODO
        callback(null, {
            statusCode: 200,
            body: JSON.stringify({message: 'Hello, world!'}),
            headers: {
                'Content-Type': 'text/plain',
            },
        });
    }
}
