import { RDSDataService } from 'aws-sdk';
import { Client, ClientBase, ClientConfig, Pool, PoolClient } from 'pg';
import { Identity, PartialUpdate, Query, VersionedModel } from './db';
import { NotFound, PreconditionFailed } from './http';
import { OrderedQuery, Page, prepareForCursor } from './pagination';
import { scanCursor } from './postgres-cursor';
import { Resource } from './resources';
import { nestedList } from './serializers';
import { hasProperties, isNotNully } from './utils/compare';
import { Exact, Key, keys } from './utils/objects';

interface SqlRequest {
    text: string;
    values: any[];
}

interface SqlResult<R> {
    rows: R[];
    rowCount: number;
}

export interface SqlConnection {
    query<R>(sql: string, params?: any[]): Promise<SqlResult<R>>;
    scan<R>(chunkSize: number, sql: string, params?: any[]): AsyncIterableIterator<R[]>;
    disconnect(error?: any): Promise<void>;
}

abstract class BasePostgreSqlConnection {
    public async query<R>(sql: string, params?: any[]): Promise<SqlResult<R>> {
        const client = await this.connect();
        return client.query<R>(sql, params);
    }
    public async *scan<R>(chunkSize: number, sql: string, params?: any[]): AsyncIterableIterator<R[]> {
        const client = await this.connect();
        yield *scanCursor<R>(client, chunkSize, sql, params);
    }
    public abstract disconnect(error?: any): Promise<void>;
    protected abstract async connect(): Promise<ClientBase>;
}

export class PostgreSqlConnection extends BasePostgreSqlConnection implements SqlConnection {
    private clientPromise?: Promise<Client>;
    constructor(private config: string | ClientConfig) {
        super();
    }
    public async disconnect(): Promise<void> {
        const { clientPromise } = this;
        if (!clientPromise) {
            // Not connected -> nothing to release
            return;
        }
        const client = await clientPromise;
        if (this.clientPromise === clientPromise) {
            await client.end();
            delete this.clientPromise;
        }
    }
    protected async connect(): Promise<Client> {
        let { clientPromise } = this;
        if (clientPromise) {
            // Use a cached client
            return clientPromise;
        }
        const client = new Client(this.config);
        clientPromise = client.connect().then(() => client);
        this.clientPromise = clientPromise;
        clientPromise.catch(() => {
            // Failed to connect to the database -> uncache
            if (this.clientPromise === clientPromise) {
                delete this.clientPromise;
            }
        });
        return clientPromise;
    }
}

export class PostgreSqlPoolConnection extends BasePostgreSqlConnection implements SqlConnection {
    private clientPromise?: Promise<PoolClient>;
    constructor(private readonly pool: Pool) {
        super();
    }
    public async disconnect(error?: any): Promise<void> {
        const { clientPromise } = this;
        if (!clientPromise) {
            // Not connected -> nothing to release
            return;
        }
        const client = await clientPromise;
        if (this.clientPromise === clientPromise) {
            client.release(error);
            delete this.clientPromise;
        }
    }
    protected async connect(): Promise<PoolClient> {
        let { clientPromise } = this;
        if (clientPromise) {
            // Use a cached client
            return clientPromise;
        }
        clientPromise = this.pool.connect();
        this.clientPromise = clientPromise;
        clientPromise.catch(() => {
            // Failed to connect to the database -> uncache
            if (this.clientPromise === clientPromise) {
                delete this.clientPromise;
            }
        });
        return clientPromise;
    }
}

export class RemotePostgreSqlConnection implements SqlConnection {

    private rdsDataApi?: RDSDataService;

    constructor(
        private readonly region: string,
        private readonly resourceArn: string,
        private readonly secretArn: string,
        private readonly database: string,
    ) {}
    public async query<R>(sql: string, params?: any[]): Promise<SqlResult<R>> {
        const { resourceArn, secretArn, database } = this;
        const rdsDataApi = this.connect();
        const parameters = buildDataApiParameters(params || []);
        const request = rdsDataApi.executeStatement({
            resourceArn, secretArn, database, sql, parameters,
            includeResultMetadata: true,
        });
        const { columnMetadata, numberOfRecordsUpdated, records } = await request.promise();
        const rowCount = numberOfRecordsUpdated || 0;
        const columns = (columnMetadata || [])
            .map(({ name }) => name)
            .filter(isNotNully);
        const rows = (records || []).map((fields) => {
            const row: Record<string, any> = {};
            columns.forEach((name, index) => {
                row[name] = decodeDataApiFieldValue(fields[index]);
            });
            return row as R;
        });
        return { rowCount, rows };
    }
    public async *scan<R>(chunkSize: number, sql: string, params?: any[]): AsyncIterableIterator<R[]> {
        // The RDSDataService does not support cursors. For now, we just attempt
        // to retrieve everything, but this will fail when the data masses increase.
        const result = await this.query<R>(sql, params);
        const rows = result.rows.slice();
        while (rows.length) {
            yield rows.splice(0, chunkSize);
        }
    }
    public async disconnect(): Promise<void> {
        delete this.rdsDataApi;
    }
    private connect() {
        let { rdsDataApi } = this;
        if (rdsDataApi) {
            return rdsDataApi;
        }
        rdsDataApi = new RDSDataService({
            apiVersion: '2018-08-01',
            region: this.region,
        });
        this.rdsDataApi = rdsDataApi;
        return rdsDataApi;
    }
}

export class PostgreSqlDbModel<S, PK extends Key<S>, V extends Key<S>, D>
implements VersionedModel<S, PK, V, D> {

    private readonly updateSerializer = this.serializer.partial([this.serializer.versionBy]);
    private readonly identitySerializer = this.serializer.pick([
        ...this.serializer.identifyBy,
        this.serializer.versionBy,
    ]).partial(this.serializer.identifyBy);

    constructor(
        private readonly connection: SqlConnection,
        private readonly tableName: string,
        public readonly serializer: Resource<S, PK, V>,
    ) {}

    public async retrieve(query: Identity<S, PK, V>) {
        const { identitySerializer } = this;
        const filters = identitySerializer.validate(query);
        const queryConfig = this.selectQuery(filters, 1);
        const { rows } = await this.executeQuery(queryConfig);
        if (rows.length) {
            return rows[0];
        }
        throw new NotFound(`Item was not found.`);
    }

    public async create(item: S) {
        const { serializer } = this;
        const values = serializer.validate(item);
        const query = this.insertQuery(values);
        const { rows } = await this.executeQuery(query);
        if (!rows.length) {
            throw new PreconditionFailed(`Item already exists.`);
        }
        return rows[0];
    }

    public async replace(identity: Identity<S, PK, V>, item: S) {
        const { identitySerializer, serializer } = this;
        const filters = identitySerializer.validate(identity);
        const values = serializer.validate(item);
        const query = this.updateQuery(filters, values);
        const { rows } = await this.executeQuery(query);
        if (!rows.length) {
            throw new NotFound(`Item was not found.`);
        }
        return rows[0];
    }

    public async update(identity: Identity<S, PK, V>, changes: PartialUpdate<S, V>): Promise<S> {
        const { identitySerializer, updateSerializer } = this;
        const filters = identitySerializer.validate(identity);
        const values = updateSerializer.validate(changes);
        const query = this.updateQuery(filters, values);
        const { rows } = await this.executeQuery(query);
        if (!rows.length) {
            throw new NotFound(`Item was not found.`);
        }
        return rows[0];
    }

    public async amend<C extends PartialUpdate<S, V>>(identity: Identity<S, PK, V>, changes: C): Promise<C> {
        // TODO: Better performing implementation
        await this.update(identity, changes);
        return changes;
    }

    public async write(item: S): Promise<S> {
        return this.upsert(item, item);
    }

    public async upsert(creation: S, update: PartialUpdate<S, V>): Promise<S> {
        const { serializer, updateSerializer } = this;
        const insertValues = serializer.validate(creation);
        const updateValues = updateSerializer.validate(update);
        const query = this.insertQuery(insertValues, updateValues);
        const { rows } = await this.executeQuery(query);
        return rows[0];
    }

    public async destroy(identity: Identity<S, PK, V>): Promise<void> {
        const { identitySerializer } = this;
        const filters = identitySerializer.validate(identity);
        const query = this.deleteQuery(filters);
        const result = await this.executeQuery(query);
        if (!result.rowCount) {
            throw new NotFound(`Item was not found.`);
        }
    }

    public async clear(identity: Identity<S, PK, V>) {
        const { identitySerializer } = this;
        const filters = identitySerializer.validate(identity);
        const query = this.deleteQuery(filters);
        await this.executeQuery(query);
    }

    public async list<Q extends D & OrderedQuery<S, Key<S>>>(query: Exact<Q, D>): Promise<Page<S, Q>> {
        const { ordering, direction, since, ...filters } = query;
        const results: S[] = [];
        const chunkSize = 100;
        for await (const items of this.scanChunks(chunkSize, filters, ordering, direction, since)) {
            results.push(...items);
            if (items.length < chunkSize) {
                return { results: items, next: null };
            }
            const cursor = prepareForCursor(results, ordering, direction);
            if (cursor) {
                return {
                    results: cursor.results,
                    next: { ...query, since: cursor.since as any },
                };
            }
        }
        // No more items
        return { results, next: null };
    }

    public scan(query?: Query<S>): AsyncIterableIterator<S[]> {
        const chunkSize = 100;
        if (query) {
            const { ordering, direction, since, ...filters } = query;
            return this.scanChunks(chunkSize, filters, ordering, direction, since);
        } else {
            return this.scanChunks(chunkSize, {});
        }
    }

    public async batchRetrieve(identities: Array<Identity<S, PK, V>>): Promise<Array<S | null>> {
        if (!identities.length) {
            return [];
        }
        const { identitySerializer } = this;
        const identityListSerializer = nestedList(identitySerializer);
        const filtersList = identityListSerializer.validate(identities);
        const query = this.batchSelectQuery(filtersList);
        const { rows } = await this.executeQuery(query);
        return filtersList.map((identity) => (
            rows.find((item) => hasProperties(item, identity)) || null
        ));
    }

    private executeQuery({ text, values }: SqlRequest) {
        return this.connection.query<S>(text, values);
    }

    private scanChunks(chunkSize: number, filters: Record<string, any>, ordering?: string, direction?: 'asc' | 'desc', since?: any) {
        const { text, values } = this.selectQuery(filters, undefined, ordering, direction, since);
        return this.connection.scan<S>(chunkSize, text, values);
    }

    private selectQuery(
        filters: Record<string, any>,
        limit?: number,
        ordering?: string,
        direction?: 'asc' | 'desc',
        since?: any,
    ) {
        const params: any[] = [];
        const columnNames = Object.keys(this.serializer.fields).map(escapeRef);
        let sql = `SELECT ${columnNames.join(', ')} FROM ${escapeRef(this.tableName)}`;
        const conditions = Object.keys(filters).map((filterKey) => {
            const filterValue = filters[filterKey];
            return makeComparison(filterKey, filterValue, params);
        });
        if (ordering && direction && since != null) {
            params.push(since);
            const dirOp = direction === 'asc' ? '>' : '<';
            conditions.push(`${escapeRef(ordering)} ${dirOp} $${params.length}`);
        }
        if (conditions.length) {
            sql += ` WHERE ${conditions.join(' AND ')}`;
        }
        if (ordering && direction) {
            sql += ` ORDER BY ${escapeRef(ordering)} ${direction.toUpperCase()}`;
        }
        if (limit != null) {
            params.push(limit);
            sql += ` LIMIT $${params.length}`;
        }
        sql += ';';
        return { text: sql, values: params };
    }

    private batchSelectQuery(filtersList: Array<Record<string, any>>) {
        const params: any[] = [];
        const columnNames = Object.keys(this.serializer.fields).map(escapeRef);
        let sql = `SELECT ${columnNames.join(', ')} FROM ${escapeRef(this.tableName)}`;
        const orConditions = filtersList.map((filters) => {
            const andConditions = keys(filters).map((filterKey) => {
                const filterValue = filters[filterKey];
                return makeComparison(filterKey, filterValue, params);
            });
            return `(${andConditions.join(' AND ')})`;
        });
        sql += ` WHERE ${orConditions.join(' OR ')};`;
        return { text: sql, values: params };
    }

    private updateQuery(
        filters: Record<string, any>,
        values: Record<string, any>,
    ) {
        const { serializer, tableName } = this;
        const params: any[] = [];
        const assignments: string[] = [];
        const { fields } = serializer;
        const columnNames = Object.keys(fields).map(escapeRef);
        const conditions = keys(filters).map((filterKey) => {
            const filterValue = filters[filterKey];
            return makeComparison(filterKey, filterValue, params);
        });
        keys(fields).forEach((key) => {
            if (!this.serializer.identifyBy.includes(key as PK)) {
                assignments.push(makeAssignment(key, values[key], params));
            }
        });
        const tblSql = escapeRef(tableName);
        const valSql = assignments.join(', ');
        const condSql = conditions.join(' AND ');
        const colSql = columnNames.join(', ');
        const sql = `UPDATE ${tblSql} SET ${valSql} WHERE ${condSql} RETURNING ${colSql};`;
        return { text: sql, values: params };
    }

    private insertQuery(
        insertValues: Record<string, any>,
        updateValues?: Record<string, any>,
    ) {
        const params: any[] = [];
        const columns: string[] = [];
        const placeholders: string[] = [];
        const updates: string[] = [];
        const { serializer, tableName } = this;
        const { fields, identifyBy } = serializer;
        keys(fields).forEach((key) => {
            columns.push(escapeRef(key));
            params.push(insertValues[key]);
            placeholders.push(`$${params.length}`);
        });
        if (updateValues) {
            keys(updateValues).forEach((key) => {
                updates.push(makeAssignment(key, updateValues[key], params));
            });
        }
        const tblSql = escapeRef(tableName);
        const colSql = columns.join(', ');
        const valSql = placeholders.join(', ');
        let sql = `INSERT INTO ${tblSql} (${colSql}) VALUES (${valSql})`;
        if (updates.length) {
            const pkSql = identifyBy.map(escapeRef).join(',');
            const upSql = updates.join(', ');
            sql += ` ON CONFLICT (${pkSql}) DO UPDATE SET ${upSql}`;
        } else {
            sql += ` ON CONFLICT DO NOTHING`;
        }
        sql += ` RETURNING ${colSql};`;
        return { text: sql, values: params };
    }

    private deleteQuery(filters: Record<string, any>) {
        const params: any[] = [];
        let sql = `DELETE FROM ${escapeRef(this.tableName)}`;
        const conditions = Object.keys(filters).map((filterKey) => {
            const filterValue = filters[filterKey];
            return makeComparison(filterKey, filterValue, params);
        });
        if (conditions.length) {
            sql += ` WHERE ${conditions.join(' AND ')}`;
        }
        sql += ';';
        return { text: sql, values: params };
    }
}

function makeAssignment(field: string, value: any, params: any[]): string {
    params.push(value);
    return `${escapeRef(field)} = $${params.length}`;
}

function makeComparison(field: string, value: any, params: any[]): string {
    if (value == null) {
        return `${escapeRef(field)} IS NULL`;
    }
    if (Array.isArray(value)) {
        if (!value.length) {
            // would result in `xxxx IN ()` which won't work
            return `FALSE`;
        }
        const placeholders = value.map((item) => {
            params.push(item);
            return `$${params.length}`;
        });
        return `${escapeRef(field)} IN (${placeholders.join(',')})`;
    }
    params.push(value);
    return `${escapeRef(field)} = $${params.length}`;
}

function escapeRef(identifier: string) {
    return JSON.stringify(identifier);
}

function buildDataApiParameters(values: unknown[]): RDSDataService.SqlParameter[] {
    return values.map(encodeDataApiFieldValue).map((value) => ({ value }));
}

function encodeDataApiFieldValue(value: unknown) {
    if (typeof value == null) {
        return { isNull: true };
    }
    if (typeof value === 'string') {
        return { stringValue: value };
    }
    if (typeof value === 'number') {
        return { doubleValue: value };
    }
    if (typeof value === 'boolean') {
        return { booleanValue: value };
    }
    throw new Error(`Unsupported parameter value ${value}`);
}

function decodeDataApiFieldValue(value: RDSDataService.Field) {
    if (value.isNull) {
        return null;
    }
    if (value.stringValue != null) {
        return value.stringValue;
    }
    if (value.doubleValue != null) {
        return value.doubleValue;
    }
    if (value.booleanValue != null) {
        return value.booleanValue;
    }
    if (value.longValue != null) {
        return value.longValue;
    }
    if (value.blobValue != null) {
        return value.blobValue.toString();
    }
    throw new Error(`Unsupported field value: ${JSON.stringify(value)}`);
}
