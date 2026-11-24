// SPDX-License-Identifier: AGPL-3.0-or-later

import fs from 'node:fs';
import path from 'node:path';
import { InMemoryCassandraQueryExecutor } from '../test/InMemoryCassandraQueryExecutor';
import type { PreparedQuery } from './CassandraTypes';
import { Logger } from '../Logger';

function serializeReplacer(_key: string, value: unknown): unknown {
	if (typeof value === 'bigint') {
		return { __sync_type: 'bigint', value: value.toString() };
	}
	if (value instanceof Date) {
		return { __sync_type: 'date', value: value.toISOString() };
	}
	if (value instanceof Set) {
		return { __sync_type: 'set', value: Array.from(value) };
	}
	if (Buffer.isBuffer(value)) {
		return { __sync_type: 'buffer', value: value.toString('base64') };
	}
	if (value instanceof Map) {
		return { __sync_type: 'map', value: Array.from(value.entries()) };
	}
	return value;
}

function deserializeReviver(_key: string, value: unknown): unknown {
	if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/i.test(value)) {
		return new Date(value);
	}
	if (value && typeof value === 'object' && '__sync_type' in value) {
		const typed = value as { __sync_type: string; value: unknown };
		switch (typed.__sync_type) {
			case 'bigint':
				return BigInt(typed.value as string);
			case 'date':
				return new Date(typed.value as string);
			case 'set':
				return new Set(typed.value as Array<unknown>);
			case 'buffer':
				return Buffer.from(typed.value as string, 'base64');
			case 'map':
				return new Map(typed.value as Array<[unknown, unknown]>);
		}
	}
	if (value && typeof value === 'object' && (value as any).type === 'Buffer' && Array.isArray((value as any).data)) {
		return Buffer.from((value as any).data);
	}
	return value;
}

export class PersistentDevQueryExecutor extends InMemoryCassandraQueryExecutor {
	private readonly dataDir: string;
	private readonly dataFilePath: string;
	private saveTimer: NodeJS.Timeout | null = null;
	private isDirty = false;

	constructor(customDataDir?: string) {
		super();
		this.dataDir = customDataDir || process.env.SYNC_DATA_DIR || path.resolve(process.cwd(), '.sync_data');
		this.dataFilePath = path.join(this.dataDir, 'sync_tables.json');
		this.loadFromDisk();
		this.registerProcessHandlers();
	}

	private loadFromDisk(): void {
		try {
			if (!fs.existsSync(this.dataFilePath)) {
				return;
			}
			const raw = fs.readFileSync(this.dataFilePath, 'utf8');
			const parsed = JSON.parse(raw, deserializeReviver);
			const imported = new Map<string, Map<string, any>>();
			for (const [tableName, rows] of Object.entries(parsed)) {
				const rowMap = new Map<string, any>();
				for (const [rowKey, rowData] of Object.entries(rows as Record<string, any>)) {
					rowMap.set(rowKey, rowData);
				}
				imported.set(tableName, rowMap);
			}
			this.importState(imported);
			Logger.info(
				{ tableCount: imported.size, path: this.dataFilePath },
				'[SYNC Persistence] Successfully restored database from disk',
			);
		} catch (err) {
			Logger.warn({ error: err }, '[SYNC Persistence] Could not load database snapshot from disk');
		}
	}

	public saveToDisk(): void {
		try {
			if (!fs.existsSync(this.dataDir)) {
				fs.mkdirSync(this.dataDir, { recursive: true });
			}
			const exported = this.exportState();
			const plain: Record<string, Record<string, any>> = {};
			for (const [tableName, rowMap] of exported.entries()) {
				plain[tableName] = {};
				for (const [rowKey, rowData] of rowMap.entries()) {
					plain[tableName][rowKey] = rowData;
				}
			}
			const serialized = JSON.stringify(plain, serializeReplacer, 2);
			const tempPath = `${this.dataFilePath}.tmp`;
			fs.writeFileSync(tempPath, serialized, 'utf8');
			fs.renameSync(tempPath, this.dataFilePath);
			this.isDirty = false;
		} catch (err) {
			Logger.error({ error: err }, '[SYNC Persistence] Failed to save database snapshot');
		}
	}

	private scheduleSave(): void {
		this.isDirty = true;
		if (this.saveTimer) return;
		this.saveTimer = setTimeout(() => {
			this.saveTimer = null;
			if (this.isDirty) {
				this.saveToDisk();
			}
		}, 300);
	}

	private registerProcessHandlers(): void {
		const onExit = () => {
			if (this.isDirty) {
				this.saveToDisk();
			}
		};
		process.once('exit', onExit);
		process.once('SIGINT', () => {
			onExit();
			process.exit(0);
		});
		process.once('SIGTERM', () => {
			onExit();
			process.exit(0);
		});
	}

	override async executeQuery<T = any>(query: PreparedQuery): Promise<Array<T>> {
		const result = await super.executeQuery<T>(query);
		const cql = (query.cql || '').trim().toUpperCase();
		if (
			cql.startsWith('INSERT') ||
			cql.startsWith('UPDATE') ||
			cql.startsWith('DELETE') ||
			query.kvMeta?.action === 'upsert' ||
			query.kvMeta?.action === 'patch' ||
			query.kvMeta?.action === 'delete'
		) {
			this.scheduleSave();
		}
		return result;
	}

	public flush(): void {
		if (this.saveTimer) {
			clearTimeout(this.saveTimer);
			this.saveTimer = null;
		}
		this.saveToDisk();
	}
}
