#! /usr/bin/env node
import * as yargs from 'yargs';

import { Broiler } from './broiler';
import { IAppConfigOptions, readAppConfig$ } from './config';

// tslint:disable-next-line:no-unused-expression
yargs
    // Read the Webpack configuration
    .describe('webpackConfigPath', 'Path to the Webpack configuration file')
    .default('webpackConfigPath', './webpack.config.js')
    .alias('webpackConfigPath', 'webpackConfig')
    .normalize('webpackConfigPath')
    // Read the TypeScript configuration.
    .describe('tsconfigPath', 'Path to the TypeScript configuration file')
    .default('tsconfigPath', './tsconfig.json')
    .alias('tsconfigPath', 'tsconfig')
    .normalize('tsconfigPath')
    // Read the app configuration
    .describe('appConfigPath', 'Path to the app configuration')
    .default('appConfigPath', './site.config.js')
    .alias('appConfigPath', 'appConfig')
    .normalize('appConfigPath')

    .boolean('debug')
    .describe('debug', 'Compile assets for debugging')

    /**** Commands ****/
    .command({
        command: 'deploy <stage>',
        describe: 'Deploy the web app for the given stage.',
        handler: (argv: IAppConfigOptions) => {
            readAppConfig$(argv)
                .switchMap((config) => new Broiler(config).deploy$())
                .subscribe()
            ;
        },
    })
    .command({
        command: 'undeploy <stage>',
        describe: 'Deletes the previously deployed web app for the given stage.',
        handler: (argv: IAppConfigOptions) => {
            readAppConfig$(argv)
                .switchMap((config) => new Broiler(config).undeploy$())
                .subscribe()
            ;
        },
    })
    .command({
        command: 'compile <stage>',
        aliases: ['build'],
        describe: 'Compile the web app for the given stage.',
        handler: (argv) => {
            readAppConfig$(argv)
                .switchMap((config) => new Broiler(config).compile$())
                .subscribe()
            ;
        },
    })
    .command({
        command: 'describe <stage>',
        describe: 'Describes the deployed resources of the given stage.',
        handler: (argv) => {
            readAppConfig$(argv)
                .switchMap((config) => new Broiler(config).printStack$())
                .subscribe()
            ;
        },
    })
    .command({
        command: 'serve',
        describe: 'Run the local development server',
        handler: (argv) => {
            readAppConfig$(argv)
                .switchMap((config) => new Broiler(config).serve$())
                .subscribe()
            ;
        },
    })
    .demandCommand(1)
    .wrap(Math.min(yargs.terminalWidth(), 140))
    .help()
    .argv
;
