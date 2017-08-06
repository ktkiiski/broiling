import { CloudFormation, CloudFront, S3 } from 'aws-sdk';
import { bold, green, underline } from 'chalk';
import { fromPairs, map } from 'lodash';
import { Observable } from 'rxjs';
import { Stats as WebpackStats } from 'webpack';
import { emptyBucket$ } from './aws';
import { compile$ } from './compile';
import { IAppConfig } from './config';
import { serve$ } from './server';
import { convertStackParameters, formatS3KeyName, formatStatus, retrievePage$, sendRequest$ } from './utils/aws';
import { isDoesNotExistsError, isUpToDateError } from './utils/aws';
import { readFile$, searchFiles$ } from './utils/fs';

import * as _ from 'lodash';
import * as mime from 'mime';
import * as path from 'path';
import * as File from 'vinyl';

export interface IStackOutput {
    [key: string]: string;
}

export interface IStackWithResources extends CloudFormation.Stack {
    StackResources: CloudFormation.StackResource[];
}

export interface IFileUpload {
    file: File;
    bucketName: string;
    result: S3.PutObjectOutput;
}

// Static assets are cached for a year
const staticAssetsCacheDuration = 31556926;
// HTML pages are cached for an hour
const staticHtmlCacheDuration = 3600;

export class Broiler {

    private cloudFormation = new CloudFormation({
        region: this.options.region,
        apiVersion: '2010-05-15',
    });
    private cloudFront = new CloudFront({
        region: this.options.region,
        apiVersion: '2017-03-25',
    });
    private s3 = new S3({
        region: this.options.region,
        apiVersion: '2006-03-01',
    });

    /**
     * Creates a new Broiler utility with the given options.
     * @param options An object of options
     */
    constructor(private options: IAppConfig) { }

    /**
     * Deploys the web app, creating/updating the stack
     * and uploading all the files to S3 buckets.
     */
    public deploy$() {
        return Observable.forkJoin(
            this.deployStack$(),
            this.compile$(),
        )
        .switchMapTo(
            this.deployFile$(),
        )
        .do({
            complete: () => this.log(`${green('Deployment complete!')} The web app is now available at ${underline(`https://${this.options.siteDomain}`)}`),
        });
    }

    /**
     * Removes (undeploys) the stack, first clearing the contents of the S3 buckets
     */
    public undeploy$(): Observable<CloudFormation.Stack> {
        this.log(`Removing the stack ${bold(this.options.stackName)} from region ${bold(this.options.region)}`);
        return this.getStackOutput$()
            .switchMap((output) => Observable.merge(
                emptyBucket$(this.s3, output.AssetsS3BucketName),
                emptyBucket$(this.s3, output.SiteS3BucketName),
            ))
            .do((item) => {
                if (item.VersionId) {
                    this.log(`Deleted ${bold(item.Key)} version ${bold(item.VersionId)} from bucket ${item.Bucket}`);
                } else {
                    this.log(`Deleted ${bold(item.Key)} from bucket ${item.Bucket}`);
                }
            })
            .count()
            .do((count) => this.log(`Deleted total of ${count} items`))
            .switchMapTo(this.describeStackWithResources$().concat(this.deleteStack$()))
            .scan((oldStack, newStack) => this.logStackChanges(oldStack, newStack))
            .do({
                complete: () => this.log(green('Undeployment complete!')),
            })
        ;
    }

    /**
     * Compiles the assets with Webpack to the build directory.
     */
    public compile$(): Observable<WebpackStats> {
        this.log(`Compiling the app for the stage ${bold(this.options.stage)}...`);
        return compile$({...this.options, baseUrl: `https://${this.options.assetsDomain}/`})
            .do((stats) => this.log(stats.toString({colors: true})))
        ;
    }

    /**
     * Runs the local development server.
     */
    public serve$(): Observable<any> {
        this.log(`Starting the local development server...`);
        return serve$({...this.options, baseUrl: `http://0.0.0.0:1111/`})
            .do((opts) => this.log(`Serving the local development website at ${underline(opts.baseUrl)}`))
        ;
    }

    /**
     * Outputs information about the stack.
     */
    public printStack$(): Observable<IStackWithResources> {
        return this.describeStackWithResources$()
            .do((stack) => {
                this.log(`Stack ${bold(stack.StackName)}`);
                this.log(`- Status: ${formatStatus(stack.StackStatus)}`);
                this.log('Resources:');
                for (const resource of stack.StackResources) {
                    const status = resource.ResourceStatus;
                    const colorizedStatus = formatStatus(status);
                    const statusReason = resource.ResourceStatusReason;
                    let msg = `- ${bold(resource.LogicalResourceId)}: ${colorizedStatus}`;
                    if (statusReason) {
                        msg += ` (${statusReason})`;
                    }
                    this.log(msg);
                }
                if (stack.Outputs) {
                    this.log('Outputs:');
                    stack.Outputs.forEach(({OutputKey, OutputValue}) => {
                        this.log(`- ${OutputKey} = ${bold(String(OutputValue))}`);
                    });
                }
            })
        ;
    }

    /**
     * Deploys the CloudFormation stack. If the stack already exists,
     * it will be updated. Otherwise, it will be created. Polls the stack
     * and its resources while the deployment is in progress.
     */
    public deployStack$(): Observable<IStackWithResources> {
        this.log(`Starting deployment of stack ${bold(this.options.stackName)} to region ${bold(this.options.region)}...`);
        return this.checkStackExists$()
            // Either create or update the stack
            .switchMap((stackExists) => {
                if (stackExists) {
                    this.log(`Updating existing stack...`);
                    return this.describeStackWithResources$().concat(this.updateStack$());
                } else {
                    this.log(`Creating a new stack...`);
                    return Observable.of({} as IStackWithResources).concat(this.createStack$());
                }
            })
            .scan((oldStack, newStack) => this.logStackChanges(oldStack, newStack))
            .last()
            .defaultIfEmpty(null)
            .switchMapTo(this.describeStackWithResources$())
        ;
    }

    /**
     * Deploys the compiled asset files from the build directory to the
     * Amazon S3 buckets in the deployed stack.
     */
    public deployFile$(): Observable<IFileUpload> {
        const asset$ = searchFiles$(this.options.buildDir, ['!**/*.html']);
        const page$ = searchFiles$(this.options.buildDir, ['**/*.html']);
        return this.getStackOutput$().switchMap((output) =>
            Observable.concat(
                this.uploadFilesToS3Bucket$(output.AssetsS3BucketName, asset$, staticAssetsCacheDuration),
                this.uploadFilesToS3Bucket$(output.SiteS3BucketName, page$, staticHtmlCacheDuration),
            ),
        );
    }

    /**
     * Returns the parameters that are given to the CloudFormation template.
     */
    public getStackParameters() {
        return convertStackParameters({
            ServiceName: this.options.stackName,
            SiteDomainName: this.options.siteDomain,
            SiteHostedZoneName: getHostedZone(this.options.siteDomain),
            AssetsDomainName: this.options.assetsDomain,
            AssetsHostedZoneName: getHostedZone(this.options.assetsDomain),
        });
    }

    /**
     * Describes the CloudFormation stack, or fails if does not exist.
     * @returns Observable for the stack description
     */
    public describeStack$(): Observable<CloudFormation.Stack> {
        return sendRequest$(
            this.cloudFormation.describeStacks({ StackName: this.options.stackName }),
        ).map((stack) => (stack.Stacks || [])[0]);
    }

    /**
     * Describes all the resources in the CloudFormation stack.
     * @returns Observable for a list of stack resources
     */
    public describeStackResources$(): Observable<CloudFormation.StackResource> {
        return retrievePage$(
            this.cloudFormation.describeStackResources({ StackName: this.options.stackName }),
            'StackResources',
        )
        .concatMap((resources) => resources || []);
    }

    /**
     * Like describeStack$ but the stack will also contain the 'StackResources'
     * attribute, containing all the resources of the stack, like from
     * describeStackResources$.
     * @returns Observable for a stack including its resources
     */
    public describeStackWithResources$(): Observable<IStackWithResources> {
        return Observable.combineLatest(
            this.describeStack$(),
            this.describeStackResources$().toArray(),
            (Stack, StackResources) => ({...Stack, StackResources}),
        );
    }

    /**
     * Retrieves the outputs of the CloudFormation stack.
     * The outputs are represented as an object, where keys are the
     * output keys, and values are the output values.
     * @returns Observable for the stack output object
     */
    public getStackOutput$(): Observable<IStackOutput> {
        return this.describeStack$()
            .map((stack) => fromPairs(map(
                stack.Outputs,
                ({OutputKey, OutputValue}) => [OutputKey, OutputValue]),
            ))
        ;
    }

    /**
     * Checks whether or not the CloudFormation stack exists,
     * resulting to a boolean value.
     * @returns Observable for a boolean value
     */
    public checkStackExists$(): Observable<boolean> {
        return this.describeStack$()
            .mapTo(true)
            .catch<boolean, boolean>((error: Error) => {
                // Check if the message indicates that the stack was not found
                if (isDoesNotExistsError(error)) {
                    return Observable.of(false);
                }
                // Pass the error through
                throw error;
            })
        ;
    }

    /**
     * Creating a new CloudFormation stack using the template.
     * This will fail if the stack already exists.
     * @returns Observable for the starting of stack creation
     */
    public createStack$() {
        return this.readTemplate$()
            .switchMap((template) => sendRequest$(
                this.cloudFormation.createStack({
                    StackName: this.options.stackName,
                    TemplateBody: template,
                    OnFailure: 'ROLLBACK',
                    Capabilities: [
                        'CAPABILITY_IAM',
                        'CAPABILITY_NAMED_IAM',
                    ],
                    Parameters: this.getStackParameters(),
                }),
            ))
            .do(() => this.log('Stack creation has started.'))
            .switchMapTo(this.waitForDeployment$(2000))
        ;
    }

    /**
     * Updating an existing CloudFormation stack using the given template.
     * This will fail if the stack does not exist.
     * NOTE: If no update is needed, the observable completes without emitting any value!
     * @returns Observable for the starting of stack update
     */
    public updateStack$() {
        return this.readTemplate$()
            .switchMap((template) => sendRequest$(
                this.cloudFormation.updateStack({
                    StackName: this.options.stackName,
                    TemplateBody: template,
                    Capabilities: [
                        'CAPABILITY_IAM',
                        'CAPABILITY_NAMED_IAM',
                    ],
                    Parameters: this.getStackParameters(),
                }),
            ).catch((error: Error) => {
                if (isUpToDateError(error)) {
                    // Let's not consider this an error. Just do not emit anything.
                    this.log('Stack is up-to-date! No updates are to be performed.');
                    return Observable.empty() as Observable<CloudFormation.UpdateStackOutput>;
                }
                throw error;
            }))
            .do(() => this.log('Stack update has started.'))
            .switchMapTo(this.waitForDeployment$(2000))
        ;
    }

    /**
     * Deletes the existing CloudFormation stack.
     * This will fail if the stack does not exist.
     */
    public deleteStack$() {
        return sendRequest$(
            this.cloudFormation.deleteStack({ StackName: this.options.stackName }),
        )
        .do(() => this.log('Stack deletion has started.'))
        .switchMapTo(this.waitForDeletion$(2000));
    }

    /**
     * Polls the state of the CloudFormation stack until it changes to
     * a complete state, or fails, in which case the observable fails.
     * @returns Observable emitting the stack and its resources until complete
     */
    public waitForDeployment$(minInterval: number): Observable<IStackWithResources> {
        return new Observable<IStackWithResources>((subscriber) =>
            Observable.timer(0, minInterval)
                .exhaustMap(() => this.describeStackWithResources$())
                .subscribe((stack) => {
                    const stackStatus = stack.StackStatus;
                    if (stackStatus.endsWith('_IN_PROGRESS')) {
                        subscriber.next(stack);
                    } else if (stackStatus.endsWith('_FAILED')) {
                        subscriber.next(stack);
                        subscriber.error(new Error(`Stack deployment failed: ${stack.StackStatusReason}`));
                    } else {
                        subscriber.next(stack);
                        subscriber.complete();
                    }
                }),
        );
    }

    /**
     * Polls the state of the CloudFormation stack until the stack no longer exists.
     * @returns Observable emitting the stack and its resources until deleted
     */
    public waitForDeletion$(minInterval: number): Observable<IStackWithResources> {
        return new Observable<IStackWithResources>((subscriber) =>
            Observable.timer(0, minInterval)
                .exhaustMap(() => this.describeStackWithResources$())
                .subscribe((stack) => {
                    const stackStatus = stack.StackStatus;
                    if (stackStatus.endsWith('_IN_PROGRESS')) {
                        subscriber.next(stack);
                    } else if (stackStatus.endsWith('_FAILED')) {
                        subscriber.next(stack);
                        subscriber.error(new Error(`Stack deployment failed: ${stack.StackStatusReason}`));
                    }
                }, () => {
                    // Error occurred: assume that the stack does not exist!
                    subscriber.complete();
                }),
        );
    }

    /**
     * Uploads all of the files from the observable to a S3 bucket.
     * @param bucketName Name of the S3 bucket to upload the files
     * @param file$ Observable of vinyl files
     * @param cacheDuration How long the files should be cached
     */
    public uploadFilesToS3Bucket$(bucketName: string, file$: Observable<File>, cacheDuration: number) {
        return file$.mergeMap((file) => this.uploadFileToS3Bucket$(
            bucketName, file, 'public-read', cacheDuration,
        ), 3);
    }

    /**
     * Uploads the given Vinyl file to a Amazon S3 bucket.
     * @param bucketName Name of the S3 bucket to upload the files
     * @param file The Vinyl file to upload
     * @param acl The ACL parameter used for the object PUT operation
     * @param cacheDuration Number of seconds for caching the files
     */
    public uploadFileToS3Bucket$(bucketName: string, file: File, acl: S3.ObjectCannedACL, cacheDuration: number) {
        return sendRequest$(
            this.s3.putObject({
                Bucket: bucketName,
                Key: formatS3KeyName(file.relative),
                Body: file.contents as Buffer,
                ACL: acl,
                CacheControl: `max-age=${cacheDuration}`,
                ContentType: mime.lookup(file.relative),
                ContentLength: file.isStream() && file.stat ? file.stat.size : undefined,
            }),
        )
        .map((data) => ({file, bucketName, result: data} as IFileUpload))
        .do(() => this.log('Uploaded', bold(file.relative), 'to bucket', bucketName, green('✔︎')));
    }

    /**
     * Invalidates items at a CloudFront distribution.
     * @param distributionId CloudFront distribution ID
     * @param items Item patterns to invalidate
     */
    public invalidateCloudFront$(distributionId: string, items = ['/*']) {
        return sendRequest$(
            this.cloudFront.createInvalidation({
                DistributionId: distributionId,
                InvalidationBatch: { /* required */
                    CallerReference: new Date().toISOString(),
                    Paths: {
                        Quantity: items.length,
                        Items: items,
                    },
                },
            }),
        ).do(() => this.log(`Invalidated CloudFront distribution ${distributionId} items:`, items));
    }

    private readTemplate$() {
        return readFile$(path.resolve(__dirname, '../res/cloudformation.yml'));
    }

    private log(message: any, ...params: any[]) {
        // tslint:disable-next-line:no-console
        console.log(message, ...params);
    }

    private logStackChanges(oldStack: IStackWithResources, newStack: IStackWithResources): IStackWithResources {
        const oldResources = oldStack.StackResources || [];
        const newResources = newStack.StackResources || [];
        const alteredResources = _.differenceBy(newResources, oldResources, (resource) => `${resource.LogicalResourceId}:${resource.ResourceStatus}`);
        for (const resource of alteredResources) {
            const status = resource.ResourceStatus;
            const colorizedStatus = formatStatus(status);
            const statusReason = resource.ResourceStatusReason;
            let msg = `Resource ${bold(resource.LogicalResourceId)} => ${colorizedStatus}`;
            if (statusReason) {
                msg += ` (${statusReason})`;
            }
            this.log(msg);
        }
        return newStack;
    }
}

function getHostedZone(domain: string) {
    const match = /([^.]+\.[^.]+)$/.exec(domain);
    return match && match[0];
}