/**
 * IMPORTANT: Do not import this file directly!
 * This is used as an endpoint file for a webpack bundle!
 */
// @ts-ignore: Webpack bundler loads the configured app site module aliased as '_site'
import View from '_site';
import * as React from 'react';
import { hydrate } from 'react-dom';
import { BrowserRouter } from 'react-router-dom';
import { Auth, BrowserAuthClient } from '../auth';
import { BrowserClient, CollectionCache, ResourceCache } from '../client';
import { ClientProvider } from '../react/client';
import LocalAuthRouter from '../react/components/LocalAuthRouter';

/**
 * Launches the application with the given configuration, to the given element.
 * It assumes that the view has been server-side rendered to the element.
 */
export function start(
    element: Element,
    apiRoot: string,
    auth: Auth | null,
    resourceCache?: ResourceCache,
    collectionCache?: CollectionCache,
): void {
    const client = new BrowserClient(apiRoot, new BrowserAuthClient(auth), resourceCache, collectionCache);
    hydrate(
        <ClientProvider client={client}>
            <BrowserRouter>
                <LocalAuthRouter component={View} />
            </BrowserRouter>
        </ClientProvider>,
        element,
    );
}
