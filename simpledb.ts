import { AmazonSimpleDB, escapeQueryIdentifier, escapeQueryParam } from './aws/simpledb';
import { Identity, PartialUpdate, Query, TableOptions, VersionedModel } from './db';
import { NotFound } from './http';
import { Page, prepareForCursor } from './pagination';
import { EncodedResource, Resource, Serializer } from './resources';
import { buildQuery } from './url';
import { mapCached } from './utils/arrays';
import { hasAttributes } from './utils/compare';
import { forEachKey, Key, keys, mapObject, omit, pick, spread } from './utils/objects';

export class SimpleDbModel<S, PK extends Key<S>, V extends Key<S>> implements VersionedModel<S, PK, V, Query<S>> {

    private updateSerializer = this.resource.partial([this.options.versionBy]);
    private identitySerializer = this.resource.pick([...this.options.identifyBy, this.options.versionBy]).partial(this.options.identifyBy);
    private readonly decoder: Serializer<any, S>;

    constructor(private domainName: string, private region: string, private resource: Resource<S>, private options: TableOptions<S, PK, V>) {
        this.decoder = options.defaults ?
            // Decode by migrating the defaults
            this.resource.optional({
                required: [...options.identifyBy, options.versionBy],
                optional: [],
                defaults: options.defaults,
            }) as Serializer<any, S> :
            // Otherwise migrate with a possibility that there are missing properties
            this.resource
        ;
    }

    public async retrieve(query: Identity<S, PK, V>, notFoundError?: Error) {
        const {identitySerializer, decoder} = this;
        const encodedQuery = identitySerializer.encodeSortable(query);
        const itemName = this.getItemName(encodedQuery);
        const sdb = new AmazonSimpleDB(this.region);
        const encodedItem = await sdb.getAttributes<EncodedResource>({
            DomainName: this.domainName,
            ItemName: itemName,
            ConsistentRead: true,
        });
        if (!hasAttributes(encodedItem, encodedQuery)) {
            throw notFoundError || new NotFound(`Item was not found.`);
        }
        return decoder.decodeSortable(encodedItem);
    }

    // TODO: Already exists exception??
    public async create(item: S, alreadyExistsError?: Error) {
        const {resource} = this;
        const primaryKey = this.options.identifyBy;
        const encodedItem = resource.encodeSortable(item);
        const itemName = this.getItemName(encodedItem);
        const sdb = new AmazonSimpleDB(this.region);
        try {
            await sdb.putAttributes({
                DomainName: this.domainName,
                ItemName: itemName,
                Expected: {
                    Name: primaryKey[0],
                    Exists: false,
                },
                Attributes: mapObject(encodedItem, (value, attr) => ({
                    Name: attr,
                    Value: value,
                    Replace: true,
                })),
            });
        } catch (error) {
            if (error.code === 'ConditionalCheckFailed') {
                throw alreadyExistsError || new NotFound(`Item was not found.`);
            }
            throw error;
        }
        return item;
    }

    public replace(identity: Identity<S, PK, V>, item: S, notFoundError?: Error) {
        // TODO: Implement separately
        const update = omit(item, this.options.identifyBy);
        return this.update(identity, update as PartialUpdate<S, V>, notFoundError);
    }

    public async update(identity: Identity<S, PK, V>, changes: PartialUpdate<S, V>, notFoundError?: Error): Promise<S> {
        // TODO: Patch specific version!
        const {decoder, identitySerializer, updateSerializer} = this;
        const versionAttr = this.options.versionBy;
        const encodedIdentity = identitySerializer.encodeSortable(identity);
        const encodedId = this.getItemName(encodedIdentity);
        const sdb = new AmazonSimpleDB(this.region);
        const encodedChanges = updateSerializer.encodeSortable(changes);
        // Get the current item's state
        const encodedItem = await sdb.getAttributes<EncodedResource>({
            DomainName: this.domainName,
            ItemName: encodedId,
        });
        if (!hasAttributes(encodedItem, encodedIdentity)) {
            throw notFoundError || new NotFound(`Item was not found.`);
        }
        const encodedVersion: string = encodedItem[versionAttr];
        const existingItem = decoder.decodeSortable(encodedItem);
        try {
            await sdb.putAttributes({
                DomainName: this.domainName,
                ItemName: encodedId,
                Expected: {
                    Name: versionAttr,
                    Value: encodedVersion,
                    Exists: true,
                },
                Attributes: mapObject(encodedChanges, (value, attr) => ({
                    Name: attr,
                    Value: value,
                    Replace: true,
                })),
            });
        } catch (error) {
            if (error.code === 'ConditionalCheckFailed') {
                // Item was modified after it was read
                // TODO: Need to retry!?!
            }
            throw error;
        }
        return spread(existingItem, changes) as S;
    }

    public async amend<C extends PartialUpdate<S, V>>(identity: Identity<S, PK, V>, changes: C, notFoundError?: Error): Promise<C> {
        // TODO: Better performing implementation
        await this.update(identity, changes, notFoundError);
        return changes;
    }

    public async write(item: S): Promise<S> {
        const {resource} = this;
        const encodedItem = resource.encodeSortable(item);
        const itemName = this.getItemName(encodedItem);
        const sdb = new AmazonSimpleDB(this.region);
        await sdb.putAttributes({
            DomainName: this.domainName,
            ItemName: itemName,
            Attributes: mapObject(encodedItem, (value, attr) => ({
                Name: attr,
                Value: value,
                Replace: true,
            })),
        });
        return item;
    }

    public async destroy(identity: Identity<S, PK, V>, notFoundError?: Error) {
        const {identitySerializer} = this;
        const primaryKey = this.options.identifyBy;
        const versionAttr = this.options.versionBy;
        const encodedIdentity = identitySerializer.encodeSortable(identity);
        const itemName = this.getItemName(encodedIdentity);
        let encodedVersion = encodedIdentity[versionAttr];
        const otherFilters = omit(encodedIdentity, [...primaryKey, versionAttr]);
        const sdb = new AmazonSimpleDB(this.region);
        // If there are other filters, then we first need to check if the
        // instance matches these filtering criteria.
        if (keys(otherFilters).length) {
            // Get the current item's state
            const encodedItem = await sdb.getAttributes<EncodedResource>({
                DomainName: this.domainName,
                ItemName: itemName,
            });
            if (!hasAttributes(encodedItem, encodedIdentity)) {
                throw notFoundError || new NotFound(`Item was not found.`);
            }
            // For the next deletion, use the given version ID
            // TODO: Retry conflicts?
            encodedVersion = encodedItem[versionAttr];
        }
        try {
            await sdb.deleteAttributes({
                DomainName: this.domainName,
                ItemName: itemName,
                Expected: {
                    Name: encodedVersion == null ? primaryKey[0] : versionAttr,
                    Value: encodedVersion == null ? encodedIdentity[primaryKey[0]] : encodedVersion,
                    Exists: true,
                },
            });
        } catch (error) {
            if (error.code === 'AttributeDoesNotExist' || error.code === 'MultiValuedAttribute' || error.code === 'ConditionalCheckFailed') {
                throw notFoundError || new NotFound(`Item was not found.`);
            }
            throw error;
        }
    }

    public async clear(identity: Identity<S, PK, V>) {
        // TODO: Better implementation!
        const notFound = new Error(`Not found`);
        try {
            return await this.destroy(identity, notFound);
        } catch (error) {
            if (error !== notFound) {
                throw error;
            }
        }
    }

    public async list<Q extends Query<S>>(query: Q): Promise<Page<S, Q>> {
        const { decoder } = this;
        const { fields } = this.resource;
        const { ordering, direction, since } = query;
        const filterAttrs = omit(query as {[key: string]: any}, ['ordering', 'direction', 'since']) as Partial<S>;
        const domain = this.domainName;
        const filters = [
            `${escapeQueryIdentifier(ordering)} is not null`,
        ];
        forEachKey(filterAttrs, (key: any, value: any) => {
            const field = (fields as any)[key];
            const encodedValue = field.encodeSortable(value);
            filters.push(
                `${escapeQueryIdentifier(key)} = ${escapeQueryParam(encodedValue)}`,
            );
        });
        if (since !== undefined) {
            const field = fields[ordering];
            const encodedValue = field.encodeSortable(since);
            filters.push([
                escapeQueryIdentifier(ordering),
                direction === 'asc' ? '>' : '<',
                escapeQueryParam(encodedValue),
            ].join(' '));
        }
        // TODO: Only select known fields
        const sql = `select * from ${escapeQueryIdentifier(domain)} where ${filters.join(' and ')} order by ${escapeQueryIdentifier(ordering)} ${direction} limit 100`;
        const sdb = new AmazonSimpleDB(this.region);
        const results: S[] = [];
        for await (const items of sdb.select(sql, true)) {
            results.push(...items.map((item) => decoder.decodeSortable(item.attributes)));
            const cursor = prepareForCursor(results, ordering, direction);
            if (cursor) {
                return {
                    results: cursor.results,
                    next: spread(query, {since: cursor.since}),
                };
            }
        }
        // No more items
        return {results, next: null};
    }

    public batchRetrieve(identities: Array<Identity<S, PK, V>>) {
        const notFoundError = new NotFound(`Item was not found`);
        const promises = mapCached(identities, (identity) => (
            this.retrieve(identity, notFoundError).catch((error) => {
                if (error === notFoundError) {
                    return null;
                }
                throw error;
            })
        ));
        return Promise.all(promises);
    }

    private getItemName(encodedQuery: EncodedResource): string {
        const key = this.options.identifyBy;
        if (key.length === 1) {
            return encodedQuery[key[0]];
        }
        return buildQuery(pick(encodedQuery, key));
    }
}
