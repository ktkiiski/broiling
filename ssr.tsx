import type { Location } from 'history';
import build from 'immuton/build';
import mapObject from 'immuton/mapObject';
import * as React from 'react';
import { renderToString } from 'react-dom/server';
import type { StaticRouterContext } from 'react-router';
import { StaticRouter } from 'react-router-dom';
import { Auth, authSerializer, DummyAuthClient } from './auth';
import {
    Client,
    CollectionCache,
    CollectionState,
    DummyClient,
    Listing,
    ResourceCache,
    ResourceState,
    Retrieval,
} from './client';
import { encodeSafeJSON, escapeHtml } from './html';
import { ApiResponse, HttpRequest, HttpResponse, HttpStatus, Redirect } from './http';
import { toJavaScript } from './javascript';
import { errorMiddleware } from './middleware';
import { ClientProvider } from './react/client';
import { MetaContextProvider } from './react/meta';
import type { Serializer } from './serializers';
import type { ApiService, Controller, ServerContext } from './server';
import { buildQuery, Url, UrlPattern } from './url';

export const RENDER_WEBSITE_ENDPOINT_NAME = 'renderWebsite' as const;

export class SsrController implements Controller {
    public readonly methods = ['GET' as const];

    public readonly pattern = new UrlPattern('/{path+}');

    constructor(
        private readonly apiService: ApiService,
        private readonly view: React.ComponentType,
        private readonly templateHtml$: Promise<string>,
    ) {}

    public async execute(request: HttpRequest, context: ServerContext): Promise<HttpResponse> {
        // TODO: Could be awaited inside renderView for a tiny performance boost?
        const templateHtml = await this.templateHtml$;
        return renderView(request, templateHtml, this.view, (apiRequest) =>
            this.apiService.execute(apiRequest, context),
        );
    }
}

async function renderView(
    request: HttpRequest,
    templateHtml: string,
    view: React.ComponentType,
    executeApiRequest: RequestHandler,
): Promise<HttpResponse> {
    const { serverOrigin, auth } = request;
    const clientAuth: Auth | null = auth && authSerializer.validate(auth);
    const requestQuery = buildQuery(request.queryParameters);
    const location: Location = {
        pathname: request.path,
        search: requestQuery ? `?${requestQuery}` : '',
        state: null,
        hash: '',
    };
    const retrievals: Retrieval[] = [];
    const listings: Listing[] = [];
    const authClient = new DummyAuthClient(clientAuth);
    let client = new DummyClient(authClient, retrievals, listings, {}, {});
    // On the first render, we just find out which resources the view requests
    let renderResult = render(view, client, location);
    // If at least one request was made, perform it and add to cache
    if (retrievals.length || listings.length) {
        const execute = errorMiddleware(executeApiRequest);
        // Perform the requests and populate the cache
        const [resourceCache, collectionCache] = await Promise.all([
            executeRetrievals(execute, retrievals, request),
            executeListings(execute, listings, request),
        ]);
        // Re-render, now with the cache populated in the Client
        client = new DummyClient(authClient, null, null, resourceCache, collectionCache);
        renderResult = render(view, client, location);
    }
    const { viewHtml, meta, routerContext } = renderResult;
    const { title } = meta;
    const styleTags = mapObject(meta.styles, (renderCss, id) => {
        const css = renderCss();
        if (!css) {
            return '';
        }
        // TODO: Need to be escaped somehow?
        return `\n<style type="text/css" id="${escapeHtml(id)}">${css}</style>`;
    });
    const metaHtml = styleTags.join('');

    const launchParams = [
        'document.getElementById("app")',
        encodePrettySafeJSON(serverOrigin),
        // Parameters for the AuthClient
        encodePrettyJavaScript(clientAuth),
        // Populate the state cache for the client
        encodePrettyJavaScript(client.resourceCache),
        encodePrettyJavaScript(client.collectionCache),
    ];
    const startupScript = `<script>\napp.start(${
        process.env.NODE_ENV === 'production' ? launchParams.join(',') : `\n${launchParams.join(',\n')}\n`
    });\n</script>`;
    const body = templateHtml
        // Inject the bootstrap script just before enclosing </body>
        .replace(/<\/body>/i, (end) => `${startupScript}\n${end}`)
        // Inject the view HTML to the div with the ID "app"
        .replace(/(<div\s+id="app">)[\s\S]*?(<\/div>)/i, (_, start, end) => `${start}${viewHtml}${end}`)
        // Replace the title
        .replace(/(<title>)([\s\S]*?)(<\/title>)/i, (match, start, _, end) =>
            title ? `${start}${escapeHtml(title)}${end}` : match,
        )
        // Inject any meta tags just before enclosing </head>
        .replace(/<\/head>/i, (end) => `${metaHtml}\n${end}`);
    // Return the HTML response
    return {
        statusCode: routerContext.statusCode || 200,
        headers: {
            'Content-Type': 'text/html; charset=UTF-8',
        },
        body,
    };
}

type RequestHandler = (request: HttpRequest) => Promise<HttpResponse | ApiResponse>;

function render(View: React.ComponentType, client: Client, location: Location) {
    const routerContext: StaticRouterContext = {};
    const meta = {
        title: undefined as string | undefined,
        styles: {} as Record<string, () => string | null>,
        idCounter: 0,
    };
    const viewHtml = renderToString(
        <MetaContextProvider context={meta}>
            <ClientProvider client={client}>
                <StaticRouter location={location} context={routerContext}>
                    <View />
                </StaticRouter>
            </ClientProvider>
        </MetaContextProvider>,
    );
    if (routerContext.url) {
        // Redirect
        let { statusCode } = routerContext;
        if (statusCode !== HttpStatus.Found && statusCode !== HttpStatus.MovedPermanently) {
            statusCode = HttpStatus.Found;
        }
        throw new Redirect(routerContext.url, statusCode);
    }
    return { viewHtml, routerContext, meta };
}

async function executeRetrievals(
    execute: RequestHandler,
    retrievals: Retrieval[],
    request: HttpRequest,
): Promise<ResourceCache> {
    const distinctRetrievals = getActionUrls(retrievals);
    const cache: ResourceCache = {};
    await Promise.all(
        mapObject(distinctRetrievals, async ([url, retrieval], urlStr) => {
            const { operation } = retrieval;
            const resourceName = operation.endpoint.resource.name;
            const [resource, error] = await executeRenderRequest(execute, url, request, operation.responseSerializer);
            const state: ResourceState = {
                resource,
                error,
                isLoading: false,
                isLoaded: false, // Causes to reload once initialized
            };
            cache[resourceName] = Object.assign(cache[resourceName] || {}, { [urlStr]: state });
        }),
    );
    return cache;
}

async function executeListings(
    execute: RequestHandler,
    listings: Listing[],
    request: HttpRequest,
): Promise<CollectionCache> {
    const distinctListings = getActionUrls(listings);
    const cache: CollectionCache = {};
    await Promise.all(
        mapObject(distinctListings, async ([url, listing], urlStr) => {
            const { operation } = listing;
            const resourceName = operation.endpoint.resource.name;
            const [page, error] = await executeRenderRequest(execute, url, request, operation.responseSerializer);
            const { ordering, direction, since, ...filters } = listing.input;
            const state: CollectionState = {
                resources: page ? page.results : [],
                count: page ? page.results.length : 0,
                isLoading: false,
                isLoaded: false, // Causes to reload once initialized
                isComplete: !!page && !page.next,
                error,
                ordering,
                direction,
                filters,
            };
            cache[resourceName] = Object.assign(cache[resourceName] || {}, { [urlStr]: state });
        }),
    );
    return cache;
}

function getActionUrls<T extends Retrieval | Listing>(actions: T[]): Record<string, [Url, T]> {
    return build(actions, (action) => {
        try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const url = action.operation.route.compile(action.input as any);
            return [url.toString(), [url, action] as [Url, T]];
        } catch {
            // Omit on error (e.g. invalid input)
            return null;
        }
    });
}

async function executeRenderRequest<T>(
    execute: (request: HttpRequest) => Promise<HttpResponse | ApiResponse>,
    url: Url,
    origRequest: HttpRequest,
    serializer: Serializer<T>,
): Promise<[T | null, ApiResponse | null]> {
    const response = await execute({
        // Copy the properties from the original request
        ...origRequest,
        // Set up properties for the render request
        method: 'GET',
        path: url.path,
        queryParameters: url.queryParams,
        body: undefined,
        headers: {
            Accept: 'application/json',
        },
    });
    // Only API responses are supported on the server-side
    if ('data' in response) {
        const responseData = response.data?.data;
        if (response.statusCode === HttpStatus.OK && responseData != null) {
            return [serializer.deserialize(responseData), null];
        }
        if (response.statusCode >= 400) {
            return [null, response];
        }
    }
    return [null, null];
}

function encodePrettySafeJSON(value: unknown) {
    return encodeSafeJSON(value, null, process.env.NODE_ENV === 'production' ? undefined : 2);
}

function encodePrettyJavaScript(value: unknown) {
    return toJavaScript(value, process.env.NODE_ENV === 'production' ? undefined : 2);
}
