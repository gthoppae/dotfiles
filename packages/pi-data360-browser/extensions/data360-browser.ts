import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { BorderedLoader } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { getSfData360Transport, transportLabel, type Sfd360Transport } from "../lib/sf-data360-adapter.ts";

type Method = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
type ThemeLike = { bold: (s: string) => string; fg: (color: string, s: string) => string };
type Json = unknown;

type OperationKind = "read" | "safe-post" | "mutation" | "probe" | "query" | "gallery";

type Operation = {
	id: string;
	label: string;
	description: string;
	method: Method;
	path: string;
	kind: OperationKind;
	body?: Json;
	rowArrayKeys?: string[];
	detailPath?: (row: unknown) => string | undefined;
	rowLabel?: (row: unknown) => string;
	rowDescription?: (row: unknown) => string;
	sqlName?: (row: unknown) => string | undefined;
};

type Category = {
	id: string;
	label: string;
	description: string;
	operations: Operation[];
};

type ApiResult = {
	ok: boolean;
	method: Method;
	path: string;
	data?: Json;
	error?: string;
	rows?: unknown[];
	message?: string;
};

type QuerySqlResponse = {
	data?: unknown[][];
	metadata?: Array<{ name?: string; type?: string; nullable?: boolean }>;
	returnedRows?: number;
	status?: unknown;
};

const API_VERSION = "66.0";
const DEFAULT_ORG = "afdc-l3";

const CACHE_TTL_MS = 15 * 60 * 1000;

type CacheEntry<T> = { value: T; loadedAt: number; expiresAt: number };
const cache = new Map<string, CacheEntry<unknown>>();

function cacheKey(parts: Array<string | undefined>): string {
	return parts.map((p) => p ?? "").join("|");
}

function getCached<T>(key: string, force = false): { value: T; loadedAt: number } | undefined {
	if (force) return undefined;
	const entry = cache.get(key) as CacheEntry<T> | undefined;
	if (!entry) return undefined;
	if (Date.now() > entry.expiresAt) {
		cache.delete(key);
		return undefined;
	}
	return { value: entry.value, loadedAt: entry.loadedAt };
}

function setCached<T>(key: string, value: T): { value: T; loadedAt: number } {
	const loadedAt = Date.now();
	cache.set(key, { value, loadedAt, expiresAt: loadedAt + CACHE_TTL_MS });
	return { value, loadedAt };
}

function formatAge(ms: number): string {
	const sec = Math.max(0, Math.floor(ms / 1000));
	if (sec < 60) return `${sec}s`;
	const min = Math.floor(sec / 60);
	const rem = sec % 60;
	return rem ? `${min}m ${rem}s` : `${min}m`;
}

function cacheStatus(kind: string, cached: boolean, loadedAt: number): string {
	return cached
		? `Serving ${kind} from cache (age ${formatAge(Date.now() - loadedAt)}, TTL 15m). Use refresh to force reload.`
		: `Refreshed ${kind} cache at ${new Date(loadedAt).toLocaleTimeString()} (TTL 15m).`;
}

function fit(text: string, width: number): string {
	return truncateToWidth(text, Math.max(0, width), "…");
}

function pad(text: string, width: number): string {
	const fitted = fit(text, width);
	return fitted + " ".repeat(Math.max(0, width - visibleWidth(fitted)));
}

function stripAnsi(s: string): string {
	return s.replace(/\x1b\[[0-9;]*m/g, "");
}

function isBackspaceKey(data: string): boolean {
	// Terminals commonly send either DEL (\x7f) or BS (\b/\x08).
	return data === "\x7f" || data === "\b" || data === "\x08";
}

function normalizeApiPath(path: string): string {
	const trimmed = path.trim();
	const versionedPrefix = new RegExp(`^/services/data/v${API_VERSION.replace(".", "\\.")}`);
	if (versionedPrefix.test(trimmed)) return trimmed.replace(versionedPrefix, "") || "/";
	if (trimmed.startsWith("/services/data/")) return trimmed.replace(/^\/services\/data\/v[0-9.]+/, "") || "/";
	return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function parseJsonFromStdout(stdout: string): Json {
	const text = stdout.trim();
	const firstJsonChar = text.search(/[\[{]/);
	if (firstJsonChar < 0) throw new Error(`No JSON response in Salesforce CLI output: ${text.slice(0, 160)}`);
	const jsonText = text.slice(firstJsonChar);
	try {
		return JSON.parse(jsonText);
	} catch {
		// Try to find the end of the JSON block if there's trailing junk
		const lastJsonChar = Math.max(jsonText.lastIndexOf("}"), jsonText.lastIndexOf("]"));
		if (lastJsonChar > 0) {
			return JSON.parse(jsonText.slice(0, lastJsonChar + 1));
		}
		throw new Error(`Failed to parse JSON from Salesforce CLI output: ${text.slice(0, 160)}`);
	}
}

function extractErrorMessage(error: unknown): string {
	const msg = error instanceof Error ? error.message : String(error);
	try {
		const firstJsonChar = msg.search(/[\[{]/);
		if (firstJsonChar >= 0) {
			const data = JSON.parse(msg.slice(firstJsonChar));
			const list = Array.isArray(data) ? data : [data];
			const bits = list.map((e: any) => {
				if (typeof e.message === "string") {
					try {
						const inner = JSON.parse(e.message);
						let m = inner.primaryMessage || inner.errorMessage || e.message;
						if (inner.customerHint) m += ` · ${inner.customerHint}`;
						return m;
					} catch {
						return e.message;
					}
				}
				return e.errorCode || "Unknown error";
			});
			return bits.join(" · ");
		}
	} catch {
		// ignore
	}
	return stripAnsi(msg).split("\n")[0] ?? "Unknown error";
}

/**
 * Single chokepoint for every Data 360 REST call from the /d360-* TUIs.
 *
 * Uses the sf-data360 transport from the sf-pi pi-package. This browser package
 * is only a TUI layer; every Data 360 REST call goes through sf-pi's cached
 * @salesforce/core Connection, path builder, and target-org/api-version
 * resolution.
 */
async function sfApi<T>(pi: ExtensionAPI, org: string, method: Method, path: string, body?: Json, signal?: AbortSignal): Promise<T> {
	const transport = await getSfData360Transport(pi);
	return transport.call<T>(pi, org, method, path, body, signal);
}

function d360ToolCall(op: Operation, org: string, overrides: Partial<{ path: string; body: Json; dry_run: boolean }> = {}): string {
	const body = overrides.body !== undefined ? overrides.body : op.body;
	return JSON.stringify(
		{
			method: op.method,
			path: normalizeApiPath(overrides.path ?? op.path),
			...(body !== undefined ? { body } : {}),
			target_org: org,
			...(overrides.dry_run ? { dry_run: true } : {}),
		},
		null,
		2,
	);
}

function getPath(obj: unknown, dotted: string): unknown {
	let cur = obj as any;
	for (const key of dotted.split(".")) {
		if (cur == null || typeof cur !== "object") return undefined;
		cur = cur[key];
	}
	return cur;
}

function firstString(obj: unknown, keys: string[]): string | undefined {
	if (!obj || typeof obj !== "object") return undefined;
	const record = obj as Record<string, unknown>;
	for (const key of keys) {
		const value = record[key];
		if (typeof value === "string" && value.trim()) return value;
	}
	return undefined;
}

function inferLabel(row: unknown): string {
	if (typeof row === "string") return row;
	if (!row || typeof row !== "object") return String(row ?? "(empty)");
	return (
		firstString(row, ["label", "displayName", "name", "developerName", "apiName", "id", "recordId", "title"]) ?? JSON.stringify(row).slice(0, 80)
	);
}

function inferDescription(row: unknown): string {
	if (!row || typeof row !== "object") return "";
	const r = row as Record<string, unknown>;
	const bits = [
		firstString(row, ["name", "developerName", "apiName", "id", "recordId"]),
		firstString(row, ["status", "state", "category", "type", "connectorType", "dataAccessMode"]),
		firstString((r.dataLakeObjectInfo as unknown) ?? {}, ["name"]),
	]
		.filter(Boolean)
		.map(String);
	return Array.from(new Set(bits)).join(" · ");
}

function inferRows(data: unknown, preferredKeys: string[] = []): unknown[] {
	for (const key of preferredKeys) {
		const value = getPath(data, key);
		if (Array.isArray(value)) return value;
	}
	if (Array.isArray(data)) return data;
	if (!data || typeof data !== "object") return [];
	const record = data as Record<string, unknown>;
	const common = [
		"dataStreams",
		"dataLakeObjects",
		"dataModelObject",
		"metadata",
		"dataSpaces",
		"connections",
		"connectorInfoList",
		"collection",
		"segments",
		"identityResolutions",
		"activations",
		"activationTargets",
		"dataActions",
		"dataTransforms",
		"dataGraphMetadata",
		"items",
	];
	for (const key of common) if (Array.isArray(record[key])) return record[key] as unknown[];
	for (const value of Object.values(record)) if (Array.isArray(value)) return value;
	return [];
}

function quoteIdentifier(identifier: string): string {
	return /^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier) ? identifier : `"${identifier.replace(/"/g, '""')}"`;
}

function top5Sql(name: string): string {
	return `SELECT * FROM ${quoteIdentifier(name)} LIMIT 5`;
}

type DmoMeta = {
	name?: string;
	displayName?: string;
	category?: string;
	type?: string;
	/** Internal: tags whether this row originated from DMO or DLO catalog. Set when catalogs are merged in /d360-query-explorer. */
	entityType?: "DMO" | "DLO";
};

type DmoField = {
	name?: string;
	label?: string;
	type?: string;
	dataType?: string;
	isPrimaryKey?: boolean;
	isMapped?: boolean;
	keyQualifierName?: string;
	usageTag?: string;
	ciFieldType?: string;
};

type DmoDescribe = {
	name?: string;
	label?: string;
	category?: string;
	creationType?: string;
	dataSpaceName?: string;
	fields?: DmoField[];
};

type ProfileField = {
	name?: string;
	displayName?: string;
	type?: string;
	businessType?: string;
	keyQualifier?: string;
};

type ProfileRelationship = {
	fromEntity?: string;
	toEntity?: string;
	fromEntityAttribute?: string;
	toEntityAttribute?: string;
	cardinality?: string;
};

type ProfileMeta = {
	name?: string;
	displayName?: string;
	category?: string;
	primaryKeys?: { name?: string; displayName?: string; indexOrder?: string }[];
	fields?: ProfileField[];
	relationships?: ProfileRelationship[];
};

type SpaRow = Record<string, unknown>;

type RunResult = {
	rows: SpaRow[];
	columns: string[];
	totalReturned: number;
	raw: unknown;
};

type PreviewParams<TObject> = {
	selectedObject: TObject | undefined;
	selectedFieldNames: string[];
	whereClause: string;
	limit: number;
};

type CatalogLoad<TObject> = {
	value: TObject[];
	cached: boolean;
	loadedAt: number;
	kindLabel: string; // e.g. "DMO catalog", "Profile metadata"
};

type FieldsLoad<TField> = {
	value: TField[];
	cached: boolean;
	loadedAt: number;
	kindLabel: string; // e.g. "<obj> queryable fields"
};

interface SpaStrategy<TObject, TField> {
	whereLabel: string;       // e.g. "WHERE" or "filters"
	limitLabel: string;       // e.g. "LIMIT" or "batchSize"
	defaultLimit: number;
	title(org: string): string;
	objectKindLabel(): string;     // shown in title and toggle
	initialObjects(): TObject[];
	initialCacheLine(): string;
	loadCatalog(force: boolean): Promise<CatalogLoad<TObject>>;
	loadFields(obj: TObject, force: boolean): Promise<FieldsLoad<TField>>;
	defaultFieldSelections(fields: TField[]): string[];
	objectName(obj: TObject): string;
	objectDisplayName(obj: TObject): string;
	objectSubtitle(obj: TObject): string;
	objectRow?(obj: TObject, selected: boolean, active: boolean, width: number, theme: ThemeLike): string[];
	objectQueryHay(obj: TObject): string;
	fieldName(field: TField): string;
	fieldQueryHay(field: TField): string;
	fieldTypeLabel(field: TField): string;
	previewLines(state: PreviewParams<TObject>): string[];
	runQuery(state: PreviewParams<TObject>, signal?: AbortSignal): Promise<RunResult>;
	copyEditorPayload(state: PreviewParams<TObject>): string;
	// `m` toggle. null = no alternate catalog (Profile SPA).
	alternateCatalog: { label: string; toggle: () => Promise<void> } | null;
}

function apiNameFromChoice(choice: string): string {
	const paren = choice.match(/\(([^()]+)\)\s*$/);
	return paren?.[1] ?? choice.trim();
}

function slugifyApiName(label: string): string {
	const cleaned = label.trim().replace(/[^A-Za-z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
	const safe = cleaned || `Data_Graph_${Date.now()}`;
	return /^[A-Za-z]/.test(safe) ? safe : `DG_${safe}`;
}

function graphDataType(field: DmoField): string {
	const raw = (field.type ?? field.dataType ?? "Text").toUpperCase();
	if (["TEXT", "EMAIL", "PHONE", "URL", "PICKLIST", "VARCHAR", "STRING", "ID"].includes(raw)) return "TEXT";
	if (["DATETIME", "TIMESTAMP", "TIME"].includes(raw)) return "TIMESTAMP";
	if (["DATE"].includes(raw)) return "DATE";
	if (["NUMBER", "NUMERIC", "DOUBLE", "DECIMAL", "INTEGER", "INT", "LONG", "CURRENCY", "PERCENT"].includes(raw)) return "NUMBER";
	if (["BOOLEAN", "BOOL"].includes(raw)) return "BOOLEAN";
	return raw;
}

function graphUsageTag(field: DmoField): string {
	const tag = (field.usageTag ?? "").toLowerCase();
	if (tag.includes("key") && tag.includes("qual")) return "KEY_QUALIFIER";
	return "NONE";
}

function graphField(field: DmoField, forceKey = false): Record<string, unknown> {
	const usageTag = graphUsageTag(field);
	const out: Record<string, unknown> = {
		isKeyColumn: forceKey || field.isPrimaryKey === true,
		sourceFieldName: field.name,
		dataType: graphDataType(field),
		isProjected: true,
		keyQualifierName: field.keyQualifierName ?? "",
		usageTag,
	};
	if (field.ciFieldType) out.ciFieldType = field.ciFieldType;
	return out;
}

function inferGraphObjectType(name: string, dmo: DmoDescribe, root = false): string {
	if (root) return "derived";
	if (name.endsWith("__cio")) return "calculated";
	if (/Unified.*Link|IdentityLink/i.test(name)) return "bridge";
	if ((dmo.creationType ?? "").toLowerCase() === "standard" || name.startsWith("ssot__")) return "standard";
	return "custom";
}

function parseFieldNames(text: string): string[] {
	const names = text
		.split(/\n|,/)
		.map((line) => line.replace(/#.*/, "").trim())
		.filter(Boolean);
	return Array.from(new Set(names));
}

function autoFieldNames(fields: DmoField[], max = 8): string[] {
	const scored = fields
		.filter((f) => f.name)
		.map((f) => {
			const n = f.name!;
			const l = `${f.name ?? ""} ${f.label ?? ""}`.toLowerCase();
			let score = 0;
			if (f.isPrimaryKey) score += 100;
			if (graphUsageTag(f) === "KEY_QUALIFIER") score += 80;
			if (/\b(first|last|full)?name\b|email|birth|created|phone|account|contact|individual/i.test(l)) score += 30;
			if (/^DataSource|^InternalOrganization/i.test(n)) score -= 100;
			return { name: n, score };
		})
		.sort((a, b) => b.score - a.score);
	const selected = scored.filter((s) => s.score > 0).slice(0, max).map((s) => s.name);
	if (selected.length === 0 && fields[0]?.name) selected.push(fields[0].name);
	return selected;
}

function selectFields(fields: DmoField[], names: string[]): DmoField[] {
	const byName = new Map(fields.filter((f) => f.name).map((f) => [f.name!, f]));
	const selected: DmoField[] = [];
	for (const name of names) {
		const field = byName.get(name);
		if (field) selected.push(field);
	}
	// Always include API-required key qualifier / primary-key fields if present.
	for (const field of fields) {
		if (!field.name) continue;
		if (field.isPrimaryKey || graphUsageTag(field) === "KEY_QUALIFIER") {
			if (!selected.some((f) => f.name === field.name)) selected.unshift(field);
		}
	}
	return selected;
}

function recencyCriteriaFor(dmo: DmoDescribe, fields: DmoField[]): Array<Record<string, unknown>> {
	if ((dmo.category ?? "").toLowerCase() !== "engagement") return [];
	const dateField = fields.find((f) => /date|time/i.test(f.name ?? "") && ["DATE", "TIMESTAMP"].includes(graphDataType(f)))?.name;
	if (!dateField) return [];
	return [
		{ fieldName: dateField, valueUnit: "DAY", value: 30, valueType: "time" },
		{ fieldName: dateField, valueUnit: "RECORD", value: 10, valueType: "record" },
	];
}

async function loadEntityMetadata(
	pi: ExtensionAPI,
	org: string,
	entityType: "DataModelObject" | "DataLakeObject",
	force = false,
): Promise<{ value: DmoMeta[]; cached: boolean; loadedAt: number }> {
	const key = cacheKey(["metadata", org, entityType]);
	const cached = getCached<DmoMeta[]>(key, force);
	if (cached) return { value: cached.value, cached: true, loadedAt: cached.loadedAt };
	const result = await sfApi<{ metadata?: DmoMeta[] }>(pi, org, "GET", `/ssot/metadata-entities?entityType=${entityType}`);
	const stored = setCached(key, result.metadata ?? []);
	return { value: stored.value, cached: false, loadedAt: stored.loadedAt };
}

async function loadDmoMetadata(pi: ExtensionAPI, org: string, force = false): Promise<{ value: DmoMeta[]; cached: boolean; loadedAt: number }> {
	return loadEntityMetadata(pi, org, "DataModelObject", force);
}

async function loadEntityDescribe(
	pi: ExtensionAPI,
	org: string,
	entityType: "DataModelObject" | "DataLakeObject",
	apiName: string,
	force = false,
): Promise<{ value: DmoDescribe; cached: boolean; loadedAt: number }> {
	const key = cacheKey(["describe", org, entityType, apiName]);
	const cached = getCached<DmoDescribe>(key, force);
	if (cached) return { value: cached.value, cached: true, loadedAt: cached.loadedAt };
	const base = entityType === "DataLakeObject" ? "/ssot/data-lake-objects" : "/ssot/data-model-objects";
	const value = await sfApi<DmoDescribe>(pi, org, "GET", `${base}/${encodeURIComponent(apiName)}`);
	const stored = setCached(key, value);
	return { value: stored.value, cached: false, loadedAt: stored.loadedAt };
}

async function loadDmoDescribe(pi: ExtensionAPI, org: string, apiName: string, force = false): Promise<{ value: DmoDescribe; cached: boolean; loadedAt: number }> {
	return loadEntityDescribe(pi, org, "DataModelObject", apiName, force);
}

function fieldsFromDescribe(description: any): DmoField[] {
	return description?.fields ?? description?.dataLakeFieldInfoRepresentation ?? description?.dataLakeObjectInfo?.fields ?? [];
}

function hasMappingInfo(fields: DmoField[]): boolean {
	return fields.some((field) => Object.prototype.hasOwnProperty.call(field, "isMapped"));
}

function mappedFieldsOnly(fields: DmoField[]): DmoField[] {
	if (!hasMappingInfo(fields)) return fields;
	return fields.filter((field) => field.isMapped === true);
}

function queryDefaultFieldNames(fields: DmoField[], max = 6): string[] {
	const selected = autoFieldNames(fields, max).filter((name) => {
		const field = fields.find((f) => f.name === name);
		return graphUsageTag(field ?? {}) !== "KEY_QUALIFIER";
	});
	if (selected.length > 0) return selected;
	return fields.filter((f) => f.name && graphUsageTag(f) !== "KEY_QUALIFIER").slice(0, max).map((f) => f.name!);
}

async function loadQueryableFields(
	pi: ExtensionAPI,
	org: string,
	objectName: string,
	force = false,
): Promise<{ value: DmoField[]; cached: boolean; loadedAt: number }> {
	const key = cacheKey(["queryable-fields", org, objectName]);
	const cached = getCached<DmoField[]>(key, force);
	if (cached) return { value: cached.value, cached: true, loadedAt: cached.loadedAt };
	const sql = `SELECT * FROM ${quoteIdentifier(objectName)} LIMIT 0`;
	const response = await sfApi<QuerySqlResponse>(pi, org, "POST", "/ssot/query-sql", { sql });
	const fields = (response.metadata ?? [])
		.filter((m) => m.name)
		.map((m) => ({ name: m.name, label: m.name, type: m.type, dataType: m.type, isMapped: true }) as DmoField);
	const stored = setCached(key, fields);
	return { value: stored.value, cached: false, loadedAt: stored.loadedAt };
}

async function loadProfileMetadata(pi: ExtensionAPI, org: string, force = false): Promise<{ value: ProfileMeta[]; cached: boolean; loadedAt: number }> {
	const key = cacheKey(["profile-metadata", org]);
	const cached = getCached<ProfileMeta[]>(key, force);
	if (cached) return { value: cached.value, cached: true, loadedAt: cached.loadedAt };
	const result = await sfApi<{ metadata?: ProfileMeta[] }>(pi, org, "GET", "/ssot/profile/metadata");
	const stored = setCached(key, (result.metadata ?? []).filter((m) => m.name));
	return { value: stored.value, cached: false, loadedAt: stored.loadedAt };
}

type SearchIndex = {
	id: string;
	label: string;
	developerName: string;
	chunkDmoDeveloperName: string;
	vectorDmoDeveloperName: string;
	searchType: string;
	dataspace: string;
};

async function loadSearchIndexes(pi: ExtensionAPI, org: string, force = false): Promise<{ value: SearchIndex[]; cached: boolean; loadedAt: number }> {
	const key = cacheKey(["search-indexes", org]);
	const cached = getCached<SearchIndex[]>(key, force);
	if (cached) return { value: cached.value, cached: true, loadedAt: cached.loadedAt };
	const result = await sfApi<{ semanticSearchDefinitionDetails?: any[] }>(pi, org, "GET", "/ssot/search-index");
	const indexes: SearchIndex[] = (result.semanticSearchDefinitionDetails ?? []).map((idx) => ({
		id: idx.id,
		label: idx.label,
		developerName: idx.developerName,
		chunkDmoDeveloperName: idx.chunkDmoDeveloperName,
		vectorDmoDeveloperName: idx.vectorDmoDeveloperName,
		searchType: idx.searchType,
		dataspace: idx.dataspace,
	}));
	const stored = setCached(key, indexes);
	return { value: stored.value, cached: false, loadedAt: stored.loadedAt };
}

function buildSemanticSearchSql(index: SearchIndex, state: PreviewParams<SearchIndex>): string {
	const idxTable = index.vectorDmoDeveloperName;
	const chunkTable = index.chunkDmoDeveloperName;
	const query = state.whereClause.trim() || "sample query";
	const topK = state.limit;
	const fields = state.selectedFieldNames.length > 0 ? state.selectedFieldNames.map((f) => `c.${quoteIdentifier(f)}`).join(", ") : 'c."Chunk__c"';
	return `SELECT ${fields}, v."score__c", v."SourceRecordId__c"\n` +
		`FROM vector_search(TABLE(${quoteIdentifier(idxTable)}), '${query.replace(/'/g, "''")}', '', ${topK}) AS v\n` +
		`JOIN ${quoteIdentifier(chunkTable)} AS c ON v."SourceRecordId__c" = c."RecordId__c"\n` +
		`ORDER BY v."score__c" DESC\n` +
		`LIMIT ${topK}`;
}

function createSemanticStrategy(
	pi: ExtensionAPI,
	org: string,
	initial: { objects: SearchIndex[]; cacheLine: string },
): SpaStrategy<SearchIndex, DmoField> {
	return {
		whereLabel: "Query",
		limitLabel: "Top K",
		defaultLimit: 5,
		title: (o) => ` Data 360 Semantic Explorer · ${o} `,
		objectKindLabel: () => "Search Index",
		initialObjects: () => initial.objects,
		initialCacheLine: () => initial.cacheLine,
		loadCatalog: async (force) => {
			const r = await loadSearchIndexes(pi, org, force);
			return { value: r.value, cached: r.cached, loadedAt: r.loadedAt, kindLabel: "Search Index catalog" };
		},
		loadFields: async (obj, force) => {
			const r = await loadEntityDescribe(pi, org, "DataModelObject", obj.chunkDmoDeveloperName, force);
			return { value: fieldsFromDescribe(r.value), cached: r.cached, loadedAt: r.loadedAt, kindLabel: `${obj.chunkDmoDeveloperName} fields` };
		},
		defaultFieldSelections: (fields) => {
			const names = fields.map((f) => f.name).filter((n): n is string => !!n);
			const defaults = ["Chunk__c", "MediaSource__c", "SourceRecordId__c"];
			return names.filter((n) => defaults.some((d) => n.toLowerCase().includes(d.toLowerCase()))).slice(0, 6);
		},
		objectName: (o) => o.developerName,
		objectDisplayName: (o) => o.label || o.developerName,
		objectRow: (o, selected, active, width, theme) => {
			const status = theme.fg("success", pad("ACTIVE", 7));
			const type = pad(theme.fg("borderAccent", o.searchType || "HYBRID"), 11);
			const label = o.label || o.developerName;
			const name = o.developerName;
			const ds = o.dataspace || "default";
			const row = `${status} ${type} ${label} ${theme.fg("dim", `(${name})`)} ${theme.fg("muted", ds)}`;
			return [selected ? theme.bold(row) : row];
		},
		objectQueryHay: (o) => `${o.label} ${o.developerName} ${o.searchType} ${o.dataspace}`,
		fieldName: (f) => f.name ?? "",
		fieldQueryHay: (f) => `${f.name} ${f.label} ${f.type}`,
		fieldTypeLabel: (f) => f.type ?? "",
		previewLines: (state) => {
			if (!state.selectedObject) return ["-- select a search index"];
			return ["Semantic Vector Search", ...buildSemanticSearchSql(state.selectedObject, state).split("\n")];
		},
		runQuery: async (state, signal) => {
			if (!state.selectedObject) throw new Error("Pick a Search Index first.");
			const sql = buildSemanticSearchSql(state.selectedObject, state);
			const r = await sfApi<QuerySqlResponse>(pi, org, "POST", "/ssot/query-sql", { sql }, signal);
			const cols = (r.metadata ?? []).map((m, i) => m.name || `col_${i + 1}`);
			const rows: SpaRow[] = (r.data ?? []).map((row) => {
				const o: SpaRow = {};
				cols.forEach((c, i) => { o[c] = row[i]; });
				return o;
			});
			return { rows, columns: cols, totalReturned: r.returnedRows ?? rows.length, raw: r };
		},
		copyEditorPayload: (state) => (state.selectedObject ? buildSemanticSearchSql(state.selectedObject, state) : ""),
		alternateCatalog: null,
	};
}

async function runQueryBuilder(pi: ExtensionAPI, ctx: any, org: string, forceRefresh = false): Promise<void> {
	const objectKind = await ctx.ui.select("Object type", ["Data Model Objects (DMO)", "Data Lake Objects (DLO)"]);
	if (!objectKind) return;
	const isDlo = objectKind.includes("DLO");
	const entityType = isDlo ? "DataLakeObject" : "DataModelObject";
	const listResult = await runWithLoader(ctx, `${forceRefresh ? "Refreshing" : "Loading"} ${entityType} catalog for ${org}…`, () => loadEntityMetadata(pi, org, entityType, forceRefresh));
	if (!listResult || (listResult as any).error) return ctx.ui.notify(`Could not load ${entityType} catalog: ${(listResult as any)?.error ?? "cancelled"}`, "error");
	const cacheLine = cacheStatus(`${isDlo ? "DLO" : "DMO"} catalog`, (listResult as any).cached, (listResult as any).loadedAt);
	ctx.ui.notify(cacheLine, (listResult as any).cached ? "success" : "info");
	const objects = ((listResult as { value?: DmoMeta[] }).value ?? []).filter((m) => m.name);
	if (!objects.length) return ctx.ui.notify(`No ${entityType} records found.`, "warning");
	const pickedObject = await pickObjectMc(ctx, isDlo ? "Choose DLO" : "Choose DMO", objects, cacheLine);
	if (!pickedObject?.name) return;
	const objectName = pickedObject.name;
	const queryable = await runWithLoader(ctx, `${forceRefresh ? "Refreshing" : "Loading"} queryable fields for ${objectName}…`, () => loadQueryableFields(pi, org, objectName, forceRefresh));
	if (!queryable || (queryable as any).error) return ctx.ui.notify(`Could not load queryable fields for ${objectName}: ${(queryable as any)?.error ?? "cancelled"}`, "error");
	ctx.ui.notify(cacheStatus(`${objectName} queryable fields`, (queryable as any).cached, (queryable as any).loadedAt), (queryable as any).cached ? "success" : "info");
	const fields = (queryable as { value?: DmoField[] }).value ?? [];
	if (!fields.length) return ctx.ui.notify(`${objectName} has no queryable fields from SELECT * LIMIT 0.`, "warning");
	const picked = await pickFieldsMc(ctx, `Queryable fields · ${objectName}`, fields, queryDefaultFieldNames(fields, 6));
	if (!picked || picked.fieldNames.length === 0) return;
	const sql = `SELECT\n  ${picked.fieldNames.map(quoteIdentifier).join(",\n  ")}\nFROM ${quoteIdentifier(objectName)}\nLIMIT 5`;
	ctx.ui.setEditorText(sql);
	const run = await ctx.ui.confirm("Run SQL now?", "The query was copied to the editor. Run it with /ssot/query-sql now?", { timeout: 30_000 });
	if (!run) return;
	const result = await runWithLoader(ctx, `Running top-5 query on ${objectName}…`, (signal) => sfApi<Json>(pi, org, "POST", "/ssot/query-sql", { sql }, signal));
	if (result) await ctx.ui.custom<void>((_tui: any, theme: ThemeLike, _kb: any, done: () => void) => new ResultViewer("Query result", JSON.stringify(result, null, 2), theme, done));
}


async function runDataGraphWizard(pi: ExtensionAPI, ctx: any, org: string, forceRefresh = false): Promise<void> {
	const metaResult = await runWithLoader(ctx, `${forceRefresh ? "Refreshing" : "Loading"} DMO catalog from ${org}…`, () => loadDmoMetadata(pi, org, forceRefresh));
	if (!metaResult) return;
	if ((metaResult as any).error) return ctx.ui.notify(`Could not load DMO catalog: ${(metaResult as any).error}`, "error");
	const catalogCacheLine = cacheStatus("DMO catalog", (metaResult as any).cached, (metaResult as any).loadedAt);
	ctx.ui.notify(catalogCacheLine, (metaResult as any).cached ? "success" : "info");
	const metadata = (metaResult as { value?: DmoMeta[] }).value ?? [];
	const profileDmos = metadata.filter((m) => (m.category ?? "").toLowerCase() === "profile" && m.name);
	const allDmos = metadata.filter((m) => m.name);
	if (!profileDmos.length) return ctx.ui.notify("No Profile DMOs found for data graph root selection.", "warning");

	const pickedPrimary = await pickObjectMc(ctx, "Primary Profile DMO", profileDmos, catalogCacheLine);
	if (!pickedPrimary?.name) return;
	const primaryName = pickedPrimary.name;
	const primaryDescribeResult = await runWithLoader(ctx, `${forceRefresh ? "Refreshing" : "Loading"} ${primaryName} fields…`, () => loadDmoDescribe(pi, org, primaryName, forceRefresh));
	if (!primaryDescribeResult || (primaryDescribeResult as any).error) return ctx.ui.notify(`Could not describe ${primaryName}`, "error");
	ctx.ui.notify(cacheStatus(`${primaryName} fields`, (primaryDescribeResult as any).cached, (primaryDescribeResult as any).loadedAt), (primaryDescribeResult as any).cached ? "success" : "info");
	const primaryDescribe = (primaryDescribeResult as { value: DmoDescribe }).value;
	const allPrimaryFields = primaryDescribe.fields ?? [];
	const primaryFields = mappedFieldsOnly(allPrimaryFields);
	if (primaryFields.length < allPrimaryFields.length) {
		ctx.ui.notify(`Hiding ${allPrimaryFields.length - primaryFields.length} unmapped primary DMO field(s).`, "warning");
	}

	const label = (await ctx.ui.input("Data Graph label", `${primaryName.replace(/__dlm$/, "")} Graph`))?.trim();
	if (!label) return;
	const apiName = (await ctx.ui.input("Data Graph API name", slugifyApiName(label)))?.trim() || slugifyApiName(label);
	const description = (await ctx.ui.input("Description", `Created from pi Data 360 TUI for ${primaryName}`)) ?? "";
	const dataspaceName = (await ctx.ui.input("Data Space", "default"))?.trim() || "default";

	const primaryPick = await pickFieldsMc(ctx, `Primary fields · ${primaryName}`, primaryFields, autoFieldNames(primaryFields));
	if (!primaryPick) return;
	const selectedPrimaryFields = selectFields(primaryFields, primaryPick.fieldNames);
	if (!selectedPrimaryFields.length) return ctx.ui.notify("No valid primary fields selected.", "warning");

	const relatedObjects: Array<Record<string, unknown>> = [];
	const addRelated = await ctx.ui.confirm("Add a related DMO?", "Add one related object now? You can edit/add more in the JSON review step.");
	if (addRelated) {
		const pickedRelated = await pickObjectMc(ctx, "Related DMO", allDmos.filter((m) => m.name !== primaryName), catalogCacheLine);
		if (pickedRelated?.name) {
			const relatedName = pickedRelated.name;
			const relatedDescribeResult = await runWithLoader(ctx, `${forceRefresh ? "Refreshing" : "Loading"} ${relatedName} fields…`, () => loadDmoDescribe(pi, org, relatedName, forceRefresh));
			if (relatedDescribeResult && !(relatedDescribeResult as any).error) {
				ctx.ui.notify(cacheStatus(`${relatedName} fields`, (relatedDescribeResult as any).cached, (relatedDescribeResult as any).loadedAt), (relatedDescribeResult as any).cached ? "success" : "info");
				const relatedDescribe = (relatedDescribeResult as { value: DmoDescribe }).value;
				const allRelatedFields = relatedDescribe.fields ?? [];
				const relatedFields = mappedFieldsOnly(allRelatedFields);
				if (relatedFields.length < allRelatedFields.length) {
					ctx.ui.notify(`Hiding ${allRelatedFields.length - relatedFields.length} unmapped related DMO field(s).`, "warning");
				}
				const relatedPick = await pickFieldsMc(ctx, `Related fields · ${relatedName}`, relatedFields, autoFieldNames(relatedFields, 8));
				if (relatedPick) {
					const parentDefault = selectedPrimaryFields.find((f) => f.isPrimaryKey)?.name ?? selectedPrimaryFields[0]?.name ?? "ssot__Id__c";
					const childDefault =
						relatedFields.find((f) => /individual|contact|account|parent/i.test(f.name ?? "") && !f.isPrimaryKey)?.name ??
						relatedFields.find((f) => f.isPrimaryKey)?.name ??
						relatedFields[0]?.name ??
						"Id__c";
					const parentFieldName = (await ctx.ui.input("Parent field on primary DMO", parentDefault))?.trim() || parentDefault;
					const fieldName = (await ctx.ui.input("Join field on related DMO", childDefault))?.trim() || childDefault;
					const selectedRelatedFields = selectFields(relatedFields, [...relatedPick.fieldNames, fieldName]);
					relatedObjects.push({
						name: relatedName,
						type: inferGraphObjectType(relatedName, relatedDescribe),
						recencyCriteria: recencyCriteriaFor(relatedDescribe, relatedFields),
						fields: selectedRelatedFields.map((f) => graphField(f, f.name === fieldName && f.isPrimaryKey === true)),
						relatedObjects: [],
						path: [{ fieldName, parentFieldName }],
						jsonPath: `$.${relatedName}`,
					});
				}
			}
		}
	}

	const payload: Record<string, unknown> = {
		dataspaceName,
		description,
		label,
		name: apiName,
		primaryObjectName: primaryName,
		type: "NONE",
		sourceObject: {
			name: primaryName,
			type: inferGraphObjectType(primaryName, primaryDescribe, true),
			recencyCriteria: [],
			path: [],
			jsonPath: "$",
			fields: selectedPrimaryFields.map((f) => graphField(f)),
			relatedObjects,
		},
	};

	const reviewed = await ctx.ui.editor("Review/edit Data Graph create JSON", `${JSON.stringify(payload, null, 2)}\n`);
	if (reviewed === undefined) return;
	let finalPayload: Record<string, unknown>;
	try {
		finalPayload = JSON.parse(reviewed);
	} catch (error) {
		return ctx.ui.notify(`Invalid JSON: ${error instanceof Error ? error.message : String(error)}`, "error");
	}

	const dryRun = await ctx.ui.confirm("Dry run first?", "Copy d360_api dry-run JSON to the editor instead of creating now?", { timeout: 30_000 });
	if (dryRun) {
		ctx.ui.setEditorText(JSON.stringify({ method: "POST", path: "/ssot/data-graphs", body: finalPayload, target_org: org, dry_run: true }, null, 2));
		ctx.ui.notify("Data graph dry-run JSON copied to editor.", "info");
		return;
	}

	const create = await ctx.ui.confirm("Create Data Graph?", `POST /ssot/data-graphs as ${org}\n\nName: ${String(finalPayload.name ?? apiName)}\nPrimary DMO: ${primaryName}`, { timeout: 30_000 });
	if (!create) return;
	const createResult = await runWithLoader(ctx, `Creating data graph ${String(finalPayload.name ?? apiName)}…`, (signal) => sfApi<Json>(pi, org, "POST", "/ssot/data-graphs", finalPayload, signal));
	if (!createResult) return;
	await ctx.ui.custom<void>((_tui: any, theme: ThemeLike, _kb: any, done: () => void) => new ResultViewer("Data Graph create result", JSON.stringify(createResult, null, 2), theme, done));

	const refresh = await ctx.ui.confirm("Build/refresh now?", "Trailhead's Save and Build corresponds to refreshing/building the graph. This can take minutes.");
	if (refresh) {
		const name = encodeURIComponent(String(finalPayload.name ?? apiName));
		const refreshResult = await runWithLoader(ctx, `Refreshing data graph ${name}…`, (signal) => sfApi<Json>(pi, org, "POST", `/ssot/data-graphs/${name}/actions/refresh`, undefined, signal));
		if (refreshResult) await ctx.ui.custom<void>((_tui: any, theme: ThemeLike, _kb: any, done: () => void) => new ResultViewer("Data Graph refresh result", JSON.stringify(refreshResult, null, 2), theme, done));
	}
}

function formatValue(value: unknown): string {
	if (value === null || value === undefined) return "∅";
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

function detailByName(pathPrefix: string, keys = ["name", "developerName", "apiName", "id", "recordId"]): (row: unknown) => string | undefined {
	return (row) => {
		const value = firstString(row, keys);
		return value ? `${pathPrefix}/${encodeURIComponent(value)}` : undefined;
	};
}

function sqlNameFromRow(row: unknown): string | undefined {
	return firstString(row, ["name", "developerName", "apiName"]);
}

const CATEGORIES: Category[] = [
	{
		id: "readiness",
		label: "Readiness",
		description: "Probe the org across core Data 360 surfaces.",
		operations: [
			{ id: "probe", label: "Readiness probe", description: "Run the same read-only surface sample as d360_probe.", method: "GET", path: "/ssot/data-spaces", kind: "probe" },
			{ id: "data-spaces", label: "Data spaces", description: "List data spaces.", method: "GET", path: "/ssot/data-spaces", kind: "read", rowArrayKeys: ["dataSpaces"], detailPath: detailByName("/ssot/data-spaces") },
		],
	},
	{
		id: "metadata",
		label: "Metadata",
		description: "Metadata search and compact entity catalog discovery.",
		operations: [
			{ id: "metadata-search", label: "Metadata search", description: "Safe POST metadata search sample.", method: "POST", path: "/connect/search/metadata/results", kind: "safe-post", body: { query: "supporter profile fields", pagination: { limit: 10 } }, rowArrayKeys: ["results", "metadata", "items"] },
			{ id: "metadata-dmo", label: "Metadata entities: DMO", description: "List Data Model Object metadata entities.", method: "GET", path: "/ssot/metadata-entities?entityType=DataModelObject", kind: "read", rowArrayKeys: ["metadata"], detailPath: (row) => firstString(row, ["name", "developerName", "apiName"]) ? `/ssot/metadata?entityName=${encodeURIComponent(firstString(row, ["name", "developerName", "apiName"])!)}` : undefined },
			{ id: "metadata-dlo", label: "Metadata entities: DLO", description: "List Data Lake Object metadata entities.", method: "GET", path: "/ssot/metadata-entities?entityType=DataLakeObject", kind: "read", rowArrayKeys: ["metadata"] },
		],
	},
	{
		id: "connect",
		label: "Connect",
		description: "Connectors, connections, and connector test/create dry-runs.",
		operations: [
			{ id: "connectors", label: "Connector catalog", description: "List available connector types.", method: "GET", path: "/ssot/connectors", kind: "read", rowArrayKeys: ["connectorInfoList"], detailPath: detailByName("/ssot/connectors", ["name", "connectorType", "type"]) },
			{ id: "connections-sfdc", label: "Salesforce connections", description: "List SalesforceDotCom connections.", method: "GET", path: "/ssot/connections?connectorType=SalesforceDotCom", kind: "read", rowArrayKeys: ["connections"], detailPath: detailByName("/ssot/connections") },
			{ id: "connections-uploaded", label: "UploadedFiles connections", description: "List UploadedFiles connections.", method: "GET", path: "/ssot/connections?connectorType=UploadedFiles", kind: "read", rowArrayKeys: ["connections"], detailPath: detailByName("/ssot/connections") },
			{ id: "connection-test", label: "Test connection config", description: "POST /connections/actions/test sample (safe operational).", method: "POST", path: "/ssot/connections/actions/test", kind: "safe-post", body: { connectorType: "SalesforceDotCom", connectionProperties: {} } },
			{ id: "connection-create", label: "Create connection", description: "Dry-run Data 360 connection create shape.", method: "POST", path: "/ssot/connections", kind: "mutation", body: { name: "demo_connection", connectorType: "SalesforceDotCom", connectionProperties: {} } },
			{ id: "connection-update", label: "Update connection", description: "Dry-run PATCH connection by id.", method: "PATCH", path: "/ssot/connections/{id}", kind: "mutation", body: { label: "Updated Label" } },
			{ id: "connection-delete", label: "Delete connection", description: "Dry-run DELETE connection by id.", method: "DELETE", path: "/ssot/connections/{id}", kind: "mutation" },
		],
	},
	{
		id: "prepare",
		label: "Prepare",
		description: "DLOs, data streams, and transforms.",
		operations: [
			{ id: "streams", label: "Data streams", description: "List data streams.", method: "GET", path: "/ssot/data-streams?limit=50", kind: "read", rowArrayKeys: ["dataStreams"], detailPath: detailByName("/ssot/data-streams"), sqlName: (row) => firstString((row as any)?.dataLakeObjectInfo, ["name"]) },
			{ id: "dlos", label: "Data Lake Objects", description: "List DLO catalog.", method: "GET", path: "/ssot/data-lake-objects?limit=50", kind: "read", rowArrayKeys: ["dataLakeObjects"], detailPath: detailByName("/ssot/data-lake-objects"), sqlName: sqlNameFromRow },
			{ id: "transforms", label: "Data transforms", description: "List data transforms.", method: "GET", path: "/ssot/data-transforms?limit=50", kind: "read", rowArrayKeys: ["dataTransforms"], detailPath: detailByName("/ssot/data-transforms") },
			{ id: "transform-detail", label: "Transform detail", description: "GET one transform by id placeholder.", method: "GET", path: "/ssot/data-transforms/{id}", kind: "gallery" },
			{ id: "transform-validate", label: "Validate transform", description: "Dry-run POST transform validation.", method: "POST", path: "/ssot/data-transforms-validation", kind: "mutation", body: { sqlExpression: "SELECT 1 AS demo_col" } },
			{ id: "transform-run", label: "Run transform", description: "Dry-run POST data transform run action.", method: "POST", path: "/ssot/data-transforms/{id}/actions/run", kind: "mutation" },
			{ id: "transform-cancel", label: "Cancel transform", description: "Dry-run POST data transform cancel action.", method: "POST", path: "/ssot/data-transforms/{id}/actions/cancel", kind: "mutation" },
			{ id: "stream-create", label: "Create data stream", description: "Dry-run create stream payload placeholder.", method: "POST", path: "/ssot/data-streams", kind: "mutation", body: { name: "demo_stream", label: "Demo Stream", dataStreamType: "INGESTAPI", dataLakeObjectInfo: { label: "Demo DLO", category: "Profile" } } },
			{ id: "stream-update", label: "Update data stream", description: "Dry-run PATCH stream by name/id.", method: "PATCH", path: "/ssot/data-streams/{id}", kind: "mutation", body: { label: "Updated Stream Label" } },
			{ id: "stream-run", label: "Run data stream", description: "Dry-run POST stream run action.", method: "POST", path: "/ssot/data-streams/{id}/run", kind: "mutation" },
			{ id: "stream-delete", label: "Delete data stream", description: "Dry-run DELETE stream with DLO retention flag.", method: "DELETE", path: "/ssot/data-streams/{id}?shouldDeleteDataLakeObject=false", kind: "mutation" },
		],
	},
	{
		id: "harmonize",
		label: "Harmonize",
		description: "DMOs, DLO→DMO mappings, and identity resolution.",
		operations: [
			{ id: "dmos", label: "Data Model Objects", description: "List DMO catalog.", method: "GET", path: "/ssot/data-model-objects?limit=50", kind: "read", rowArrayKeys: ["dataModelObject"], detailPath: detailByName("/ssot/data-model-objects"), sqlName: sqlNameFromRow },
			{ id: "mappings", label: "DLO→DMO mappings", description: "List mappings (some orgs require source/target filters).", method: "GET", path: "/ssot/data-model-object-mappings", kind: "read", rowArrayKeys: ["dataModelObjectMappings", "mappings"], detailPath: detailByName("/ssot/data-model-object-mappings", ["name", "mappingName", "id"]) },
			{ id: "identity", label: "Identity resolutions", description: "List identity-resolution rulesets.", method: "GET", path: "/ssot/identity-resolutions?limit=50", kind: "read", rowArrayKeys: ["identityResolutions"], detailPath: detailByName("/ssot/identity-resolutions", ["id", "name", "label"]) },
			{ id: "dmo-create", label: "Create DMO", description: "Dry-run DMO create payload placeholder.", method: "POST", path: "/ssot/data-model-objects", kind: "mutation", body: { name: "Demo__dlm", label: "Demo", category: "Profile", fields: [] } },
			{ id: "dmo-update", label: "Update DMO", description: "Dry-run PATCH DMO.", method: "PATCH", path: "/ssot/data-model-objects/{dmoName}", kind: "mutation", body: { label: "Updated DMO Label" } },
			{ id: "dmo-delete", label: "Delete DMO", description: "Dry-run DELETE DMO.", method: "DELETE", path: "/ssot/data-model-objects/{dmoName}", kind: "mutation" },
			{ id: "mapping-create", label: "Create mapping", description: "Dry-run DLO→DMO mapping create shape.", method: "POST", path: "/ssot/data-model-object-mappings", kind: "mutation", body: { sourceEntityDeveloperName: "Source__dll", targetEntityDeveloperName: "Target__dlm", fieldMapping: [] } },
			{ id: "mapping-update", label: "Update mapping", description: "Dry-run PATCH mapping.", method: "PATCH", path: "/ssot/data-model-object-mappings/{mappingName}", kind: "mutation", body: { fieldMapping: [] } },
			{ id: "mapping-delete", label: "Delete mapping", description: "Dry-run DELETE mapping.", method: "DELETE", path: "/ssot/data-model-object-mappings/{mappingName}", kind: "mutation" },
		],
	},
	{
		id: "analyze",
		label: "Analyze",
		description: "Calculated insights, segments, ML artifacts, and search indexes.",
		operations: [
			{ id: "cis", label: "Calculated insights", description: "List calculated insights.", method: "GET", path: "/ssot/calculated-insights?limit=50", kind: "read", rowArrayKeys: ["collection", "calculatedInsights"], detailPath: detailByName("/ssot/calculated-insights", ["name", "apiName", "developerName"]) },
			{ id: "segments", label: "Segments", description: "List segments.", method: "GET", path: "/ssot/segments?limit=50", kind: "read", rowArrayKeys: ["segments"], detailPath: detailByName("/ssot/segments", ["id", "name", "apiName"]) },
			{ id: "search-indexes", label: "Search indexes", description: "List search indexes.", method: "GET", path: "/ssot/search-index", kind: "read", rowArrayKeys: ["searchIndexes", "items"] },
			{ id: "ml-artifacts", label: "ML model artifacts", description: "List machine-learning model artifacts.", method: "GET", path: "/ssot/machine-learning/model-artifacts", kind: "read", rowArrayKeys: ["modelArtifacts", "items"] },
			{ id: "ci-validate", label: "Validate CI", description: "Safe POST calculated insight validation sample.", method: "POST", path: "/ssot/calculated-insights/actions/validate", kind: "safe-post", body: { name: "Demo_CI__cio", expression: "SELECT 1 AS demo_col" } },
			{ id: "ci-create", label: "Create CI", description: "Dry-run calculated insight create.", method: "POST", path: "/ssot/calculated-insights", kind: "mutation", body: { name: "Demo_CI__cio", expression: "SELECT 1 AS demo_col" } },
			{ id: "ci-run", label: "Run CI", description: "Dry-run calculated insight run action.", method: "POST", path: "/ssot/calculated-insights/{ciName}/actions/run", kind: "mutation" },
			{ id: "segment-create", label: "Create segment", description: "Dry-run segment create shape.", method: "POST", path: "/ssot/segments", kind: "mutation", body: { displayName: "Demo Segment", segmentOnApiName: "ssot__Individual__dlm", segmentType: "Standard" } },
			{ id: "segment-publish", label: "Publish segment", description: "Dry-run segment publish/calculate action.", method: "POST", path: "/ssot/segments/{id}/actions/publish", kind: "mutation" },
			{ id: "search-index-create", label: "Create search index", description: "Dry-run search index create shape.", method: "POST", path: "/ssot/search-index", kind: "mutation", body: { name: "demo_index", label: "Demo Index", fields: [] } },
		],
	},
	{
		id: "retrieve",
		label: "Retrieve",
		description: "SQL Query API, Profile API, Insight API, data graphs, and semantic models.",
		operations: [
			{ id: "query-builder", label: "Query builder", description: "Midnight Commander-style DMO/DLO field picker that builds SELECT ... LIMIT 5 SQL.", method: "POST", path: "/ssot/query-sql", kind: "gallery" },
			{ id: "sql-sample", label: "SQL query sample", description: "Safe POST /ssot/query-sql sample.", method: "POST", path: "/ssot/query-sql", kind: "query", body: { sql: "SELECT 1 AS demo_col LIMIT 1" } },
			{ id: "profile-meta", label: "Profile metadata", description: "List profile-enabled DMOs and relationships.", method: "GET", path: "/ssot/profile/metadata", kind: "read", rowArrayKeys: ["metadata"], detailPath: detailByName("/ssot/profile/metadata", ["name", "dataModelName", "apiName"]) },
			{ id: "insight-meta", label: "Insight metadata", description: "List calculated insight metadata.", method: "GET", path: "/ssot/insight/metadata", kind: "read", rowArrayKeys: ["metadata", "calculatedInsights"] },
			{ id: "data-graph-wizard", label: "Create Data Graph wizard", description: "Trailhead-style TUI wizard: pick Profile DMO, fields, optional related DMO, review JSON, then dry-run or POST /ssot/data-graphs.", method: "POST", path: "/ssot/data-graphs", kind: "gallery" },
			{ id: "data-graphs", label: "Data graph metadata", description: "List data graph metadata.", method: "GET", path: "/ssot/data-graphs/metadata", kind: "read", rowArrayKeys: ["dataGraphMetadata"], detailPath: detailByName("/ssot/data-graphs", ["developerName", "name"]) },
			{ id: "data-graph-refresh", label: "Refresh/build Data Graph", description: "Dry-run Data Graph refresh/build action.", method: "POST", path: "/ssot/data-graphs/{dataGraphName}/actions/refresh", kind: "mutation" },
			{ id: "data-graph-delete", label: "Delete Data Graph", description: "Dry-run Data Graph delete.", method: "DELETE", path: "/ssot/data-graphs/{dataGraphName}", kind: "mutation" },
			{ id: "semantic-models", label: "Semantic models", description: "List semantic data models.", method: "GET", path: "/ssot/semantic/models?limit=50", kind: "read", rowArrayKeys: ["items"], detailPath: detailByName("/ssot/semantic/models", ["name", "apiName", "id"]) },
			{ id: "semantic-query", label: "Semantic query", description: "Safe POST semantic-engine gateway sample placeholder.", method: "POST", path: "/semantic-engine/gateway", kind: "safe-post", body: { query: "show me total records" } },
			{ id: "semantic-create", label: "Create semantic model", description: "Dry-run semantic model shell create.", method: "POST", path: "/ssot/semantic/models", kind: "mutation", body: { name: "demo_semantic_model", label: "Demo Semantic Model" } },
			{ id: "semantic-validate", label: "Validate semantic model", description: "GET validate endpoint placeholder.", method: "GET", path: "/ssot/semantic/models/{name}/validate", kind: "gallery" },
		],
	},
	{
		id: "act",
		label: "Act",
		description: "Activations, activation targets, data actions, and data action targets.",
		operations: [
			{ id: "activations", label: "Activations", description: "List activations.", method: "GET", path: "/ssot/activations?limit=50", kind: "read", rowArrayKeys: ["activations"], detailPath: detailByName("/ssot/activations", ["id", "name", "developerName"]) },
			{ id: "activation-targets", label: "Activation targets", description: "List activation targets.", method: "GET", path: "/ssot/activation-targets", kind: "read", rowArrayKeys: ["activationTargets", "targets"] },
			{ id: "data-actions", label: "Data actions", description: "List data actions.", method: "GET", path: "/ssot/data-actions?limit=50", kind: "read", rowArrayKeys: ["dataActions"], detailPath: detailByName("/ssot/data-actions", ["developerName", "name", "id"]) },
			{ id: "activation-create", label: "Create activation", description: "Dry-run activation create shape.", method: "POST", path: "/ssot/activations", kind: "mutation", body: { name: "Demo_Activation", segmentId: "{segmentId}", targetId: "{targetId}" } },
			{ id: "activation-target-create", label: "Create activation target", description: "Dry-run activation target create shape.", method: "POST", path: "/ssot/activation-targets", kind: "mutation", body: { name: "Demo_Target", type: "Salesforce" } },
			{ id: "data-action-create", label: "Create data action", description: "Dry-run data action create shape.", method: "POST", path: "/ssot/data-actions", kind: "mutation", body: { developerName: "Demo_Action", label: "Demo Action", targetType: "Webhook" } },
			{ id: "data-action-delete", label: "Delete data action", description: "Dry-run data action delete.", method: "DELETE", path: "/ssot/data-actions/{developerName}", kind: "mutation" },
		],
	},
	{
		id: "ops",
		label: "Ops / edge",
		description: "DataKit, Document AI, private routes, clean room, retrievers.",
		operations: [
			{ id: "data-kits", label: "DataKits", description: "List DataKits.", method: "GET", path: "/ssot/data-kits", kind: "read", rowArrayKeys: ["dataKits", "items"], detailPath: detailByName("/ssot/data-kits", ["id", "name", "developerName"]) },
			{ id: "document-configs", label: "Document AI configs", description: "List document-processing configurations.", method: "GET", path: "/ssot/document-processing/configurations", kind: "read", rowArrayKeys: ["configurations", "items"] },
			{ id: "retrievers", label: "Retrievers", description: "List retrievers when provisioned.", method: "GET", path: "/machine-learning/retrievers", kind: "read", rowArrayKeys: ["retrievers", "items"] },
			{ id: "cleanroom-collabs", label: "Clean-room collaborations", description: "List data clean room collaborations.", method: "GET", path: "/ssot/data-clean-room/collaborations", kind: "read", rowArrayKeys: ["collaborations", "items"] },
			{ id: "private-routes", label: "Private network routes", description: "List private network routes when feature is enabled.", method: "GET", path: "/ssot/private-network-routes", kind: "read", rowArrayKeys: ["privateNetworkRoutes", "items"] },
			{ id: "datakit-update", label: "Deploy/update DataKit", description: "Dry-run DataKit update-components operation.", method: "POST", path: "/ssot/data-kits/update-components", kind: "mutation", body: { components: [] } },
			{ id: "datakit-undeploy", label: "Undeploy DataKit", description: "Dry-run DataKit undeploy operation.", method: "POST", path: "/ssot/data-kits/{id}/undeploy", kind: "mutation" },
			{ id: "doc-extract", label: "Document extract-data", description: "Dry-run Document AI extract-data action.", method: "POST", path: "/ssot/document-processing/actions/extract-data", kind: "mutation", body: { configurationId: "{configurationId}", document: {} } },
			{ id: "cleanroom-run", label: "Run clean-room query", description: "Dry-run clean room run action.", method: "POST", path: "/ssot/data-clean-room/collaborations/{id}/actions/run", kind: "mutation" },
		],
	},
	{
		id: "request",
		label: "d360_api",
		description: "Showcase the raw generic d360_api surface: method, path, body, dry_run.",
		operations: [
			{ id: "raw-shape", label: "Generic tool shape", description: "The d360_api tool can call any Data 360 REST endpoint.", method: "GET", path: "/ssot/data-model-objects", kind: "gallery" },
			{ id: "dry-run-shape", label: "Dry-run mutation shape", description: "Inspect a mutating request without calling Salesforce.", method: "POST", path: "/ssot/data-streams", kind: "mutation", body: { name: "demo_stream", label: "Demo Stream" } },
		],
	},
];

const PROBE_OPS: Operation[] = [
	{ id: "data_spaces", label: "data_spaces", description: "", method: "GET", path: "/ssot/data-spaces", kind: "read" },
	{ id: "dmo_catalog", label: "dmo_catalog", description: "", method: "GET", path: "/ssot/data-model-objects?limit=1", kind: "read" },
	{ id: "dlo_catalog", label: "dlo_catalog", description: "", method: "GET", path: "/ssot/data-lake-objects?limit=1", kind: "read" },
	{ id: "data_streams", label: "data_streams", description: "", method: "GET", path: "/ssot/data-streams?limit=1", kind: "read" },
	{ id: "calculated_insights", label: "calculated_insights", description: "", method: "GET", path: "/ssot/calculated-insights?limit=1", kind: "read" },
	{ id: "connectors", label: "connectors", description: "", method: "GET", path: "/ssot/connectors", kind: "read" },
	{ id: "segments", label: "segments", description: "", method: "GET", path: "/ssot/segments?limit=1", kind: "read" },
	{ id: "identity_resolution", label: "identity_resolution", description: "", method: "GET", path: "/ssot/identity-resolutions?limit=1", kind: "read" },
	{ id: "activations", label: "activations", description: "", method: "GET", path: "/ssot/activations?limit=1", kind: "read" },
	{ id: "data_transforms", label: "data_transforms", description: "", method: "GET", path: "/ssot/data-transforms?limit=1", kind: "read" },
	{ id: "semantic_models", label: "semantic_models", description: "", method: "GET", path: "/ssot/semantic/models?limit=1", kind: "read" },
	{ id: "profile_metadata", label: "profile_metadata", description: "", method: "GET", path: "/ssot/profile/metadata", kind: "read" },
];

class D360Browser implements Component {
	private categoryIndex = 0;
	private opIndex = 0;
	private rowIndex = 0;
	private focus: "categories" | "ops" | "rows" = "ops";
	private loading = false;
	private current?: ApiResult;
	private detail?: ApiResult;
	private status = "Choose an operation and press enter.";
	private paneWeights: [number, number, number] = [0.20, 0.32, 0.48];

	private expanded = false;

	constructor(
		private readonly pi: ExtensionAPI,
		private readonly org: string,
		private readonly theme: ThemeLike,
		private readonly setEditorText: (text: string) => void,
		private readonly launchDataGraphWizard: () => Promise<void>,
		private readonly done: () => void,
		private readonly requestRender: () => void,
	) {}

	handleInput(data: string): void {
		if (this.loading) return;
		if (matchesKey(data, Key.ctrl("c")) || data === "q") return this.done();
		if (matchesKey(data, Key.escape)) return this.goBack();
		if (matchesKey(data, Key.left)) return this.moveFocus(-1);
		if (matchesKey(data, Key.right)) return this.moveFocus(1);
		if (matchesKey(data, Key.up)) return this.moveSelection(-1);
		if (matchesKey(data, Key.down)) return this.moveSelection(1);
		if (matchesKey(data, Key.home)) return this.homeEnd(false);
		if (matchesKey(data, Key.end)) return this.homeEnd(true);
		if (data === "r") return void this.runCurrentOperation();
		if (data === "c") return this.copyCurrentCall(false);
		if (data === "d") return this.copyCurrentCall(true);
		if (data === "s") return void this.runSqlForRow();
		if (data === "z") return this.toggleExpansion();
		if (data === "[" || data === "<") return this.resizePane(-0.05);
		if (data === "]" || data === ">") return this.resizePane(0.05);
		if (matchesKey(data, Key.enter) || data === " ") return void this.activate();
	}

	private toggleExpansion(): void {
		this.expanded = !this.expanded;
		this.applyExpansion();
		this.requestRender();
	}

	private applyExpansion(): void {
		if (this.expanded) {
			const i = this.focus === "categories" ? 0 : this.focus === "ops" ? 1 : 2;
			const others = [0, 1, 2].filter((j) => j !== i);
			this.paneWeights[i] = 0.80;
			for (const j of others) this.paneWeights[j] = 0.10;
		} else {
			this.paneWeights = [0.20, 0.32, 0.48];
		}
	}

	render(width: number): string[] {
		const w = Math.max(70, width);
		const t = this.theme;
		const title = ` Data 360 API Browser · ${this.org} `;
		const rule = "─".repeat(Math.max(0, w - visibleWidth(title)));
		const lines = [fit(t.fg("accent", t.bold(title)) + t.fg("border", rule), w)];

		const sepW = 3; // " │ "
		const usable = Math.max(0, w - sepW * 2);
		let catW = Math.max(0, Math.floor(usable * this.paneWeights[0]));
		let opW = Math.max(0, Math.floor(usable * this.paneWeights[1]));
		let resW = Math.max(0, usable - catW - opW);
		// rebalance if floor underflowed
		const slack = usable - (catW + opW + resW);
		if (slack > 0) resW += slack;
		const leftSepFocused = this.focus === "categories" || this.focus === "ops";
		const rightSepFocused = this.focus === "ops" || this.focus === "rows";
		const leftSep = t.fg(leftSepFocused ? "accent" : "border", " │ ");
		const rightSep = t.fg(rightSepFocused ? "accent" : "border", " │ ");
		const col1 = this.renderCategories(catW);
		const col2 = this.renderOperations(opW);
		const col3 = this.renderResult(resW);
		const rows = Math.max(col1.length, col2.length, col3.length);
		for (let i = 0; i < rows; i += 1) {
			lines.push(fit(pad(col1[i] ?? "", catW) + leftSep + pad(col2[i] ?? "", opW) + rightSep + fit(col3[i] ?? "", resW), w));
		}
		lines.push(t.fg("border", "─".repeat(w)));
		lines.push(fit(t.fg("dim", "←→ pane · ↑↓ move · enter open · s SQL · c copy · d dry-run · [/]/</> resize · z toggle 80% · r refresh · esc back · q close"), w));
		lines.push(fit(this.loading ? t.fg("warning", "Loading…") : t.fg("dim", this.status), w));
		return lines.map((line) => fit(line, w));
	}

	private resizePane(delta: number): void {
		const i = this.focus === "categories" ? 0 : this.focus === "ops" ? 1 : 2;
		const current = this.paneWeights[i]!;
		const next = Math.max(0.12, Math.min(0.75, current + delta));
		const actual = next - current;
		if (actual === 0) return;
		const others = [0, 1, 2].filter((j) => j !== i) as Array<0 | 1 | 2>;
		const share = actual / others.length;
		this.paneWeights[i] = next;
		for (const j of others) this.paneWeights[j] = Math.max(0.10, this.paneWeights[j]! - share);
		const sum = this.paneWeights[0] + this.paneWeights[1] + this.paneWeights[2];
		this.paneWeights = [this.paneWeights[0] / sum, this.paneWeights[1] / sum, this.paneWeights[2] / sum];
		this.requestRender();
	}

	invalidate(): void {}

	private category(): Category {
		return CATEGORIES[this.categoryIndex]!;
	}

	private operation(): Operation {
		return this.category().operations[this.opIndex]!;
	}

	private selectedRow(): unknown | undefined {
		return this.current?.rows?.[this.rowIndex];
	}

	private moveFocus(delta: number): void {
		const panes: Array<typeof this.focus> = ["categories", "ops", "rows"];
		const idx = panes.indexOf(this.focus);
		this.focus = panes[Math.max(0, Math.min(panes.length - 1, idx + delta))]!;
		if (this.expanded) this.applyExpansion();
		this.requestRender();
	}

	private moveSelection(delta: number): void {
		if (this.focus === "categories") {
			this.categoryIndex = Math.max(0, Math.min(CATEGORIES.length - 1, this.categoryIndex + delta));
			this.opIndex = 0;
			this.rowIndex = 0;
			this.current = undefined;
			this.detail = undefined;
			this.status = this.category().description;
		} else if (this.focus === "ops") {
			this.opIndex = Math.max(0, Math.min(this.category().operations.length - 1, this.opIndex + delta));
			this.rowIndex = 0;
			this.detail = undefined;
			this.status = this.operation().description;
		} else {
			const count = this.current?.rows?.length ?? 0;
			this.rowIndex = Math.max(0, Math.min(Math.max(0, count - 1), this.rowIndex + delta));
		}
		this.requestRender();
	}

	private homeEnd(end: boolean): void {
		if (this.focus === "categories") this.categoryIndex = end ? CATEGORIES.length - 1 : 0;
		else if (this.focus === "ops") this.opIndex = end ? this.category().operations.length - 1 : 0;
		else this.rowIndex = end ? Math.max(0, (this.current?.rows?.length ?? 1) - 1) : 0;
		this.requestRender();
	}

	private goBack(): void {
		if (this.detail) this.detail = undefined;
		else if (this.focus === "rows") this.focus = "ops";
		else this.done();
		this.requestRender();
	}

	private async activate(): Promise<void> {
		if (this.focus === "categories") {
			this.focus = "ops";
			this.requestRender();
			return;
		}
		if (this.focus === "rows") {
			await this.openRowDetail();
			return;
		}
		await this.runCurrentOperation();
	}

	private async runCurrentOperation(): Promise<void> {
		const op = this.operation();
		this.detail = undefined;
		this.current = undefined;
		this.rowIndex = 0;
		if (op.id === "data-graph-wizard") {
			await this.launchDataGraphWizard();
			this.status = "Returned from Data Graph wizard.";
			this.requestRender();
			return;
		}
		if (op.id === "query-builder") {
			this.setEditorText("Run /d360-query-explorer for SQL, /d360-semantic-explorer for Vector search, or /d360-query-builder for the step-by-step picker. Add 'refresh' to force-refresh the 15m DMO/DLO cache.");
			this.current = { ok: true, method: "POST", path: "/ssot/query-sql", message: "Query Explorers\n\n- /d360-query-explorer: Standard SQL against DMOs/DLOs.\n- /d360-semantic-explorer: Natural language search across Vector Indexes.\n\nThe generated SQL uses d360_api shape: POST /ssot/query-sql with { sql }." };
			this.status = "Query explorer guidance copied to editor.";
			this.requestRender();
			return;
		}
		if (op.kind === "gallery" || op.kind === "mutation") {
			this.current = { ok: true, method: op.method, path: op.path, message: `${op.kind === "mutation" ? "Dry-run only." : "Gallery operation."}\n\nEquivalent d360_api call:\n${d360ToolCall(op, this.org, { dry_run: op.kind === "mutation" })}` };
			this.status = "Copied shape is available with c/d.";
			this.requestRender();
			return;
		}
		if (op.kind === "probe") {
			await this.runProbe();
			return;
		}
		await this.callOperation(op);
	}

	private async callOperation(op: Operation, pathOverride?: string, bodyOverride?: Json, asDetail = false): Promise<void> {
		this.loading = true;
		this.status = `${op.method} ${pathOverride ?? op.path}`;
		this.requestRender();
		try {
			const path = pathOverride ?? op.path;
			const body = bodyOverride !== undefined ? bodyOverride : op.body;
			const data = await sfApi<Json>(this.pi, this.org, op.method, path, body);
			const rows = inferRows(data, op.rowArrayKeys);
			const result: ApiResult = { ok: true, method: op.method, path, data, rows };
			if (asDetail) this.detail = result;
			else this.current = result;
			this.status = rows.length ? `${rows.length} row(s)` : "Response loaded";
			if (!asDetail && rows.length) this.focus = "rows";
		} catch (error) {
			const result: ApiResult = { ok: false, method: op.method, path: pathOverride ?? op.path, error: extractErrorMessage(error) };
			if (asDetail) this.detail = result;
			else this.current = result;
			this.status = "Call failed";
		} finally {
			this.loading = false;
			this.requestRender();
		}
	}

	private async runProbe(): Promise<void> {
		this.loading = true;
		this.current = undefined;
		this.detail = undefined;
		this.requestRender();
		const rows: Array<{ name: string; path: string; state: string; count?: number; keys?: string[]; message?: string }> = [];
		for (const op of PROBE_OPS) {
			this.status = `Probing ${op.label}`;
			this.requestRender();
			try {
				const data = await sfApi<Json>(this.pi, this.org, "GET", op.path);
				const inferred = inferRows(data);
				const keys = data && typeof data === "object" ? Object.keys(data as Record<string, unknown>) : [];
				rows.push({ name: op.id, path: op.path, state: inferred.length > 0 ? "enabled_populated" : "ok", count: inferred.length || undefined, keys });
			} catch (error) {
				rows.push({ name: op.id, path: op.path, state: "error", message: error instanceof Error ? stripAnsi(error.message).split("\n")[0] : String(error) });
			}
		}
		this.current = { ok: true, method: "GET", path: "d360_probe", data: { targetOrg: this.org, apiVersion: API_VERSION, probes: rows }, rows };
		this.loading = false;
		this.focus = "rows";
		this.status = `Probe complete: ${rows.filter((r) => r.state !== "error").length}/${rows.length} surfaces responded.`;
		this.requestRender();
	}

	private async openRowDetail(): Promise<void> {
		const op = this.operation();
		const row = this.selectedRow();
		if (!row) return;
		const path = op.detailPath?.(row);
		if (path && op.kind !== "mutation") await this.callOperation({ ...op, method: "GET", body: undefined }, path, undefined, true);
		else {
			this.detail = { ok: true, method: op.method, path: op.path, data: row, rows: [] };
			this.requestRender();
		}
	}

	private async runSqlForRow(): Promise<void> {
		const op = this.operation();
		const row = this.selectedRow();
		const name = (row && op.sqlName?.(row)) || (row && sqlNameFromRow(row));
		if (!name) {
			this.status = "Selected row has no SQL-queryable name.";
			this.requestRender();
			return;
		}
		const sql = top5Sql(name);
		await this.callOperation({ id: "row-sql", label: "Row SQL", description: sql, method: "POST", path: "/ssot/query-sql", kind: "query", body: { sql } }, "/ssot/query-sql", { sql }, true);
	}

	private copyCurrentCall(dryRun: boolean): void {
		const op = this.operation();
		this.setEditorText(d360ToolCall(op, this.org, { dry_run: dryRun || op.kind === "mutation" }));
		this.status = `Copied ${dryRun || op.kind === "mutation" ? "dry-run " : ""}d360_api JSON to editor.`;
		this.requestRender();
	}

	private renderCategories(width: number): string[] {
		const t = this.theme;
		const lines = this.paneHeader("Phases", this.focus === "categories", width);
		for (let i = 0; i < CATEGORIES.length; i += 1) {
			const c = CATEGORIES[i]!;
			const selected = i === this.categoryIndex;
			lines.push(`${selected ? t.fg("accent", "› ") : "  "}${selected ? t.fg("accent", c.label) : c.label}`);
		}
		return lines.map((l) => fit(l, width));
	}

	private renderOperations(width: number): string[] {
		const t = this.theme;
		const lines = this.paneHeader(this.category().label, this.focus === "ops", width);
		for (let i = 0; i < this.category().operations.length; i += 1) {
			const op = this.category().operations[i]!;
			const selected = i === this.opIndex;
			const icon = op.kind === "mutation" ? t.fg("warning", "△") : op.kind === "safe-post" || op.kind === "query" ? t.fg("success", "▶") : op.kind === "probe" ? t.fg("accent", "◆") : t.fg("dim", "○");
			lines.push(`${selected ? t.fg("accent", "› ") : "  "}${icon} ${selected ? t.fg("accent", op.label) : op.label}`);
			if (selected) lines.push(`    ${t.fg("muted", fit(op.description, width - 4))}`);
		}
		return lines.map((l) => fit(l, width));
	}

	private renderResult(width: number): string[] {
		const t = this.theme;
		const lines = this.paneHeader("Result", this.focus === "rows", width);
		const op = this.operation();
		if (this.detail) {
			for (const l of this.renderApiResult(this.detail, width)) lines.push(l);
			return lines.map((l) => fit(l, width));
		}
		if (!this.current) {
			lines.push(t.fg("accent", t.bold(op.label)));
			lines.push(`${t.fg("muted", op.method)} ${op.path}`);
			lines.push("");
			lines.push(...this.wrap(op.description, width));
			lines.push("");
			if (op.kind === "mutation") lines.push(t.fg("warning", "Mutation operations open as dry-run JSON only."));
			lines.push(t.fg("dim", "Press enter/r to run or show shape."));
			return lines.map((l) => fit(l, width));
		}
		if (this.current.message) {
			lines.push(...this.wrap(this.current.message, width));
			return lines.map((l) => fit(l, width));
		}
		if (!this.current.ok) {
			lines.push(t.fg("error", "Request failed"));
			lines.push(...this.wrap(this.current.error ?? "Unknown error", width));
			return lines.map((l) => fit(l, width));
		}
		const rows = this.current.rows ?? [];
		if (rows.length > 0) {
			lines.push(t.fg("success", `${rows.length} row(s)`) + t.fg("dim", " · enter detail · s SQL if queryable"));
			const start = Math.max(0, Math.min(this.rowIndex - 8, Math.max(0, rows.length - 16)));
			const end = Math.min(rows.length, start + 16);
			for (let i = start; i < end; i += 1) {
				const row = rows[i];
				const selected = i === this.rowIndex;
				const label = this.operation().rowLabel?.(row) ?? inferLabel(row);
				const desc = this.operation().rowDescription?.(row) ?? inferDescription(row);
				lines.push(`${selected ? t.fg("accent", "› ") : "  "}${selected ? t.fg("accent", label) : label}`);
				if (desc) lines.push(`    ${t.fg("muted", fit(desc, width - 4))}`);
			}
			return lines.map((l) => fit(l, width));
		}
		lines.push(...this.renderJsonPreview(this.current.data, width));
		return lines.map((l) => fit(l, width));
	}

	private renderApiResult(result: ApiResult, width: number): string[] {
		const t = this.theme;
		const lines = [t.fg("accent", t.bold("Detail")), `${t.fg("muted", result.method)} ${result.path}`, ""];
		if (!result.ok) {
			lines.push(t.fg("error", "Request failed"), ...this.wrap(result.error ?? "Unknown error", width));
			return lines;
		}
		if (result.path.includes("query-sql") && result.data) {
			lines.push(...this.renderSqlResult(result.data as QuerySqlResponse, width));
			return lines;
		}
		lines.push(...this.renderJsonPreview(result.data, width));
		return lines;
	}

	private renderSqlResult(result: QuerySqlResponse, width: number): string[] {
		const t = this.theme;
		const data = result.data ?? [];
		const metadata = result.metadata ?? [];
		const names = metadata.length ? metadata.map((m, i) => m.name || `col_${i + 1}`) : data[0]?.map((_v, i) => `col_${i + 1}`) ?? [];
		const maxCols = Math.max(1, Math.min(names.length, Math.floor(width / 14)));
		const cols = names.slice(0, maxCols);
		const colW = Math.max(8, Math.floor((width - Math.max(0, cols.length - 1) * 3) / Math.max(1, cols.length)));
		const sep = t.fg("border", " │ ");
		const lines = [t.fg("success", `Returned ${result.returnedRows ?? data.length} row(s)`), cols.map((c) => t.fg("accent", pad(c, colW))).join(sep), t.fg("border", "─".repeat(Math.min(width, cols.length * colW + Math.max(0, cols.length - 1) * 3)))];
		for (const row of data.slice(0, 5)) lines.push(cols.map((_c, i) => pad(formatValue(row[i]), colW)).join(sep));
		if (names.length > maxCols) lines.push(t.fg("dim", `… ${names.length - maxCols} more columns hidden`));
		if (!data.length) lines.push(t.fg("muted", "No rows returned."));
		return lines;
	}

	private renderJsonPreview(data: Json, width: number): string[] {
		const text = JSON.stringify(data, null, 2) ?? "";
		return text.split("\n").slice(0, 28).map((line) => fit(line, width));
	}

	private wrap(text: string, width: number, maxLines = 100): string[] {
		const out: string[] = [];
		for (const raw of text.split("\n")) {
			let line = raw;
			if (!line.length) {
				out.push("");
				continue;
			}
			while (visibleWidth(line) > width) {
				out.push(fit(line, width));
				if (out.length >= maxLines) return out;
				const consumed = Math.max(1, Math.floor(width * 0.8));
				if (consumed >= line.length) {
					line = "";
					break;
				}
				line = line.slice(consumed);
			}
			if (line.length > 0) {
				out.push(line);
				if (out.length >= maxLines) return out;
			}
		}
		return out;
	}

	private header(label: string, focused: boolean): string {
		const t = this.theme;
		return focused ? t.fg("accent", t.bold(label)) : t.fg("muted", t.bold(label));
	}

	private paneHeader(label: string, focused: boolean, width: number): string[] {
		const t = this.theme;
		const marker = focused ? t.fg("accent", "▌") : " ";
		const title = focused ? t.fg("accent", t.bold(label)) : t.fg("muted", t.bold(label));
		const ruleChar = focused ? "━" : "─";
		const ruleColor = focused ? "accent" : "border";
		return [fit(`${marker} ${title}`, width), t.fg(ruleColor, ruleChar.repeat(Math.max(0, width)))];
	}
}

type FieldPickResult = { fieldNames: string[]; fields: DmoField[] } | null;

class MultiFieldPicker implements Component {
	private cursor = 0;
	private scrollTop = 0;
	private selected = new Set<string>();
	private query = "";
	private searchMode = false;
	private readonly pageSize = 18;

	constructor(
		private readonly title: string,
		private readonly fields: DmoField[],
		initialNames: string[],
		private readonly theme: ThemeLike,
		private readonly done: (result: FieldPickResult) => void,
		private readonly requestRender: () => void,
	) {
		for (const name of initialNames) if (name) this.selected.add(name);
	}

	handleInput(data: string): void {
		if (this.searchMode) {
			if (matchesKey(data, Key.enter)) {
				this.searchMode = false;
				this.accept();
				return;
			}
			if (matchesKey(data, Key.escape)) {
				this.searchMode = false;
				this.requestRender();
				return;
			}
			if (isBackspaceKey(data)) {
				this.query = this.query.slice(0, -1);
				this.cursor = 0;
				this.scrollTop = 0;
				this.requestRender();
				return;
			}
			if (data.length === 1 && data.charCodeAt(0) >= 32) {
				this.query += data;
				this.cursor = 0;
				this.scrollTop = 0;
				this.requestRender();
			}
			return;
		}

		if (matchesKey(data, Key.escape) || data === "q") return this.done(null);
		if (matchesKey(data, Key.enter)) return this.accept();
		if (matchesKey(data, Key.up)) return this.move(-1);
		if (matchesKey(data, Key.down)) return this.move(1);
		if (matchesKey(data, Key.home)) return this.jump(false);
		if (matchesKey(data, Key.end)) return this.jump(true);
		if (data === "/") {
			this.searchMode = true;
			this.requestRender();
			return;
		}
		if (data === "c") {
			this.query = "";
			this.cursor = 0;
			this.scrollTop = 0;
			this.requestRender();
			return;
		}
		if (data === " " || data === "x") return this.toggleCurrent();
		if (data === "a") return this.selectFiltered(true);
		if (data === "n") return this.selectFiltered(false);
		if (data === "i") return this.invertFiltered();
	}

	render(width: number): string[] {
		const w = Math.max(72, width);
		const t = this.theme;
		const filtered = this.filteredFields();
		this.ensureVisible(filtered.length);
		const title = ` ${this.title} `;
		const count = `${this.selected.size}/${this.fields.length} selected`;
		const rule = "─".repeat(Math.max(0, w - visibleWidth(title) - visibleWidth(count)));
		const lines = [fit(t.fg("accent", t.bold(title)) + t.fg("border", rule) + t.fg("muted", count), w)];
		const leftW = Math.max(44, Math.floor(w * 0.64));
		const sep = t.fg("border", " │ ");
		const rightW = Math.max(24, w - leftW - visibleWidth(sep));
		const left = this.renderFieldPane(leftW, filtered);
		const right = this.renderSelectedPane(rightW);
		const rows = Math.max(left.length, right.length);
		for (let i = 0; i < rows; i += 1) lines.push(fit(pad(left[i] ?? "", leftW) + sep + fit(right[i] ?? "", rightW), w));
		lines.push(t.fg("border", "─".repeat(w)));
		const search = this.query ? ` filter=${JSON.stringify(this.query)}` : "";
		lines.push(fit(t.fg("dim", `↑↓ move · space/x toggle · / search${this.searchMode ? " (typing)" : ""}${search} · a all · n none · i invert · c clear · enter accept · q cancel`), w));
		return lines.map((line) => fit(line, w));
	}

	invalidate(): void {}

	private fieldName(field: DmoField): string {
		return field.name ?? field.label ?? "(unnamed)";
	}

	private filteredFields(): DmoField[] {
		const q = this.query.trim().toLowerCase();
		if (!q) return this.fields;
		return this.fields.filter((field) => `${field.name ?? ""} ${field.label ?? ""} ${field.type ?? ""} ${field.dataType ?? ""} ${field.usageTag ?? ""}`.toLowerCase().includes(q));
	}

	private ensureVisible(count: number): void {
		this.cursor = Math.max(0, Math.min(Math.max(0, count - 1), this.cursor));
		if (this.cursor < this.scrollTop) this.scrollTop = this.cursor;
		if (this.cursor >= this.scrollTop + this.pageSize) this.scrollTop = this.cursor - this.pageSize + 1;
	}

	private move(delta: number): void {
		this.cursor = Math.max(0, Math.min(Math.max(0, this.filteredFields().length - 1), this.cursor + delta));
		this.ensureVisible(this.filteredFields().length);
		this.requestRender();
	}

	private jump(end: boolean): void {
		const count = this.filteredFields().length;
		this.cursor = end ? Math.max(0, count - 1) : 0;
		this.ensureVisible(count);
		this.requestRender();
	}

	private toggleCurrent(): void {
		const field = this.filteredFields()[this.cursor];
		if (!field) return;
		const name = this.fieldName(field);
		if (this.selected.has(name)) this.selected.delete(name);
		else this.selected.add(name);
		this.requestRender();
	}

	private selectFiltered(value: boolean): void {
		for (const field of this.filteredFields()) {
			const name = this.fieldName(field);
			if (value) this.selected.add(name);
			else this.selected.delete(name);
		}
		this.requestRender();
	}

	private invertFiltered(): void {
		for (const field of this.filteredFields()) {
			const name = this.fieldName(field);
			if (this.selected.has(name)) this.selected.delete(name);
			else this.selected.add(name);
		}
		this.requestRender();
	}

	private accept(): void {
		const fieldNames = this.fields.map((f) => this.fieldName(f)).filter((name) => this.selected.has(name));
		this.done({ fieldNames, fields: this.fields.filter((f) => this.selected.has(this.fieldName(f))) });
	}

	private renderFieldPane(width: number, filtered: DmoField[]): string[] {
		const t = this.theme;
		const lines = [t.fg("accent", t.bold("Fields")) + t.fg("dim", ` (${filtered.length} visible)` )];
		const end = Math.min(filtered.length, this.scrollTop + this.pageSize);
		if (this.scrollTop > 0) lines.push(t.fg("dim", `  ↑ ${this.scrollTop} more`));
		for (let i = this.scrollTop; i < end; i += 1) {
			const field = filtered[i]!;
			const name = this.fieldName(field);
			const checked = this.selected.has(name) ? t.fg("success", "[x]") : t.fg("dim", "[ ]");
			const cursor = i === this.cursor ? t.fg("accent", "›") : " ";
			const type = field.type ?? field.dataType ?? "";
			const key = field.isPrimaryKey ? t.fg("success", " PK") : graphUsageTag(field) === "KEY_QUALIFIER" ? t.fg("warning", " KQ") : "";
			const label = field.label && field.label !== name ? t.fg("muted", ` · ${field.label}`) : "";
			lines.push(fit(`${cursor} ${checked} ${i === this.cursor ? t.fg("accent", name) : name} ${t.fg("muted", type)}${key}${label}`, width));
		}
		if (end < filtered.length) lines.push(t.fg("dim", `  ↓ ${filtered.length - end} more`));
		if (filtered.length === 0) lines.push(t.fg("warning", "No fields match the filter."));
		return lines.map((line) => fit(line, width));
	}

	private renderSelectedPane(width: number): string[] {
		const t = this.theme;
		const names = this.fields.map((f) => this.fieldName(f)).filter((name) => this.selected.has(name));
		const lines = [t.fg("accent", t.bold("Selected"))];
		for (const name of names.slice(0, 18)) lines.push(`${t.fg("success", "✓")} ${fit(name, width - 2)}`);
		if (names.length > 18) lines.push(t.fg("dim", `… ${names.length - 18} more`));
		if (names.length === 0) lines.push(t.fg("muted", "No fields selected."));
		return lines.map((line) => fit(line, width));
	}
}

async function pickFieldsMc(ctx: any, title: string, fields: DmoField[], initialNames: string[]): Promise<FieldPickResult> {
	return ctx.ui.custom<FieldPickResult>((tui: any, theme: ThemeLike, _kb: any, done: (result: FieldPickResult) => void) => {
		return new MultiFieldPicker(title, fields, initialNames, theme, done, () => tui.requestRender());
	});
}

type ObjectPickResult = DmoMeta | null;

class ObjectPicker implements Component {
	private cursor = 0;
	private scrollTop = 0;
	private query = "";
	private searchMode = false;
	private readonly pageSize = 20;

	constructor(
		private readonly title: string,
		private readonly objects: DmoMeta[],
		private readonly theme: ThemeLike,
		private readonly cacheLine: string,
		private readonly done: (result: ObjectPickResult) => void,
		private readonly requestRender: () => void,
	) {}

	handleInput(data: string): void {
		if (this.searchMode) {
			if (matchesKey(data, Key.enter)) {
				this.searchMode = false;
				return this.done(this.filteredObjects()[this.cursor] ?? null);
			}
			if (matchesKey(data, Key.escape)) {
				this.searchMode = false;
				this.requestRender();
				return;
			}
			if (isBackspaceKey(data)) {
				this.query = this.query.slice(0, -1);
				this.cursor = 0;
				this.scrollTop = 0;
				this.requestRender();
				return;
			}
			if (data.length === 1 && data.charCodeAt(0) >= 32) {
				this.query += data;
				this.cursor = 0;
				this.scrollTop = 0;
				this.requestRender();
			}
			return;
		}

		if (matchesKey(data, Key.escape) || data === "q") return this.done(null);
		if (matchesKey(data, Key.enter)) return this.done(this.filteredObjects()[this.cursor] ?? null);
		if (matchesKey(data, Key.up)) return this.move(-1);
		if (matchesKey(data, Key.down)) return this.move(1);
		if (matchesKey(data, Key.home)) return this.jump(false);
		if (matchesKey(data, Key.end)) return this.jump(true);
		if (data === "/") {
			this.searchMode = true;
			this.requestRender();
			return;
		}
		if (data === "c") {
			this.query = "";
			this.cursor = 0;
			this.scrollTop = 0;
			this.requestRender();
		}
	}

	render(width: number): string[] {
		const w = Math.max(72, width);
		const t = this.theme;
		const filtered = this.filteredObjects();
		this.ensureVisible(filtered.length);
		const title = ` ${this.title} `;
		const count = `${filtered.length}/${this.objects.length}`;
		const rule = "─".repeat(Math.max(0, w - visibleWidth(title) - visibleWidth(count)));
		const lines = [fit(t.fg("accent", t.bold(title)) + t.fg("border", rule) + t.fg("muted", count), w)];
		lines.push(fit(t.fg(this.cacheLine.startsWith("Serving") ? "success" : "warning", this.cacheLine), w));
		if (this.query || this.searchMode) lines.push(fit(t.fg("accent", `Filter${this.searchMode ? " (typing)" : ""}: /${this.query}`), w));
		const end = Math.min(filtered.length, this.scrollTop + this.pageSize);
		if (this.scrollTop > 0) lines.push(t.fg("dim", `  ↑ ${this.scrollTop} more`));
		for (let i = this.scrollTop; i < end; i += 1) {
			const item = filtered[i]!;
			const selected = i === this.cursor;
			const label = item.displayName ?? item.name ?? "(unnamed)";
			const api = item.name ?? "";
			const category = item.category ?? "";
			lines.push(fit(`${selected ? t.fg("accent", "› ") : "  "}${selected ? t.fg("accent", label) : label} ${t.fg("muted", `(${api})`)} ${category ? t.fg("dim", `· ${category}`) : ""}`, w));
		}
		if (end < filtered.length) lines.push(t.fg("dim", `  ↓ ${filtered.length - end} more`));
		if (!filtered.length) lines.push(t.fg("warning", "No objects match the filter."));
		lines.push(t.fg("border", "─".repeat(w)));
		lines.push(fit(t.fg("dim", "↑↓ move · / filter · c clear filter · enter choose · q cancel · run command with 'refresh' to rebuild cache"), w));
		return lines.map((line) => fit(line, w));
	}

	invalidate(): void {}

	private filteredObjects(): DmoMeta[] {
		const q = this.query.trim().toLowerCase();
		if (!q) return this.objects;
		return this.objects.filter((obj) => `${obj.displayName ?? ""} ${obj.name ?? ""} ${obj.category ?? ""} ${obj.type ?? ""}`.toLowerCase().includes(q));
	}

	private ensureVisible(count: number): void {
		this.cursor = Math.max(0, Math.min(Math.max(0, count - 1), this.cursor));
		if (this.cursor < this.scrollTop) this.scrollTop = this.cursor;
		if (this.cursor >= this.scrollTop + this.pageSize) this.scrollTop = this.cursor - this.pageSize + 1;
	}

	private move(delta: number): void {
		this.cursor = Math.max(0, Math.min(Math.max(0, this.filteredObjects().length - 1), this.cursor + delta));
		this.ensureVisible(this.filteredObjects().length);
		this.requestRender();
	}

	private jump(end: boolean): void {
		const count = this.filteredObjects().length;
		this.cursor = end ? Math.max(0, count - 1) : 0;
		this.ensureVisible(count);
		this.requestRender();
	}
}

async function pickObjectMc(ctx: any, title: string, objects: DmoMeta[], cacheLine: string): Promise<ObjectPickResult> {
	return ctx.ui.custom<ObjectPickResult>((tui: any, theme: ThemeLike, _kb: any, done: (result: ObjectPickResult) => void) => {
		return new ObjectPicker(title, objects, theme, cacheLine, done, () => tui.requestRender());
	});
}

type QueryObjectType = "DataModelObject" | "DataLakeObject";

type SpaConstructorArgs<TObject, TField> = {
	pi: ExtensionAPI;
	org: string;
	theme: ThemeLike;
	strategy: SpaStrategy<TObject, TField>;
	setEditorText: (text: string) => void;
	notify: (message: string, level?: "info" | "success" | "warning" | "error") => void;
	done: () => void;
	requestRender: () => void;
};

function highlightText(text: string, query: string, theme: ThemeLike): string {
	if (!query || !query.trim()) return text;
	const terms = query.trim().split(/\s+/).filter(t => t.length > 1);
	if (terms.length === 0) return text;
	
	let highlighted = text;
	for (const term of terms) {
		const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		const regex = new RegExp(`(${escaped})`, "gi");
		highlighted = highlighted.replace(regex, theme.fg("warning", theme.bold("$1")));
	}
	return highlighted;
}

function categoryColor(category: string, theme: ThemeLike): string {
	const c = (category || "").toLowerCase();
	if (c.includes("profile")) return theme.fg("accent", "Profile");
	if (c.includes("engagement")) return theme.fg("borderAccent", "Engagement");
	if (c.includes("directory")) return theme.fg("error", "Directory");
	return theme.fg("accent", category || "Other");
}

class Spa<TObject, TField> implements Component {
	private readonly pi: ExtensionAPI;
	private readonly org: string;
	private readonly theme: ThemeLike;
	private readonly strategy: SpaStrategy<TObject, TField>;
	private readonly setEditorText: (text: string) => void;
	private readonly notify: (message: string, level?: "info" | "success" | "warning" | "error") => void;
	private readonly done: () => void;
	private readonly requestRender: () => void;

	private objects: TObject[];
	private objectCacheLine: string;
	private objectCursor = 0;
	private objectScrollTop = 0;
	private objectQuery = "";
	private selectedObject: TObject | undefined;

	private fields: TField[] = [];
	private selectedFields = new Set<string>();
	private fieldCursor = 0;
	private fieldScrollTop = 0;
	private fieldQuery = "";

	private focus: "objects" | "fields" | "preview" = "objects";
	private layoutMode: "columns" | "accordion" = "columns";
	private searchMode = false;
	private loading = false;
	private confirmQuit = false;
	private status: string;
	private result: RunResult | undefined;
	private error: string | undefined;
	private readonly pageSize = 18;
	private paneWeights: [number, number, number] = [0.30, 0.34, 0.36];
	private whereClause = "";
	private limit: number;
	private editing: "where" | "limit" | null = null;
	private editBuffer = "";
	private resultCursor = 0;
	private resultScrollTop = 0;
	private readonly resultPageSize = 10;
	private detailMode = false;
	private detailScrollTop = 0;

	private expanded = false;
	private transportInfo: Sfd360Transport["info"] | undefined;

	constructor(args: SpaConstructorArgs<TObject, TField>) {
		this.pi = args.pi;
		this.org = args.org;
		this.theme = args.theme;
		this.strategy = args.strategy;
		this.setEditorText = args.setEditorText;
		this.notify = args.notify;
		this.done = args.done;
		this.requestRender = args.requestRender;
		this.objects = args.strategy.initialObjects();
		this.objectCacheLine = args.strategy.initialCacheLine();
		this.status = this.objectCacheLine;
		this.limit = args.strategy.defaultLimit;
		// Resolve the transport mode lazily; first /d360-* call will already
		// have warmed it. Re-render once it lands so the footer pill is correct.
		getSfData360Transport(this.pi)
			.then((t) => {
				this.transportInfo = t.info;
				this.requestRender();
			})
			.catch(() => {});
	}

	handleInput(data: string): void {
		if (this.editing) return this.handleEditInput(data);
		if (this.detailMode) return this.handleDetailInput(data);
		if (this.searchMode) return this.handleSearchInput(data);
		if (this.confirmQuit) {
			if (matchesKey(data, Key.enter) || matchesKey(data, Key.escape) || data === "q" || data.toLowerCase() === "y") return this.done();
			this.confirmQuit = false;
			this.status = "Quit cancelled.";
			this.requestRender();
			return;
		}
		if (matchesKey(data, Key.ctrl("c"))) return this.done();
		if (data === "q") return this.askQuit();
		if (matchesKey(data, Key.escape)) {
			if (this.error || this.result) {
				this.error = undefined;
				this.result = undefined;
				this.requestRender();
				return;
			}
			return this.askQuit();
		}
		if (matchesKey(data, Key.left)) return this.moveFocus(-1);
		if (matchesKey(data, Key.right) || matchesKey(data, Key.tab)) return this.moveFocus(1);
		if (matchesKey(data, Key.up)) return this.move(-1);
		if (matchesKey(data, Key.down)) return this.move(1);
		if (matchesKey(data, Key.home)) return this.jump(false);
		if (matchesKey(data, Key.end)) return this.jump(true);
		if (data === "/") {
			this.searchMode = true;
			this.requestRender();
			return;
		}
		if (data === "c") return this.copyEditor();
		if (data === "r") return void this.runQuery();
		if (data === "f") return void this.forceReloadCurrent();
		if (data === "m" && this.strategy.alternateCatalog) return void this.toggleAlternateCatalog();
		if (data === "w") return this.enterEdit("where");
		if (data === "L") return this.enterEdit("limit");
		if (data === "z") return this.toggleExpansion();
		if (data === "v") return this.toggleLayout();
		if (data === "[" || data === "<") return this.resizePane(-0.05);
		if (data === "]" || data === ">") return this.resizePane(0.05);
		if (this.focus === "objects" && (matchesKey(data, Key.enter) || data === " ")) return void this.selectObject(false);
		if (this.focus === "fields") {
			if (matchesKey(data, Key.enter) || data === " ") return this.toggleField();
			if (data === "a") return this.selectVisibleFields(true);
			if (data === "n") return this.selectVisibleFields(false);
			if (data === "i") return this.invertVisibleFields();
		}
		if (this.focus === "preview" && (matchesKey(data, Key.enter) || data === " ")) return this.openDetail();
	}

	private toggleExpansion(): void {
		this.expanded = !this.expanded;
		this.applyExpansion();
		this.status = this.expanded ? "80% focus mode enabled." : "Default layout restored.";
		this.requestRender();
	}

	private toggleLayout(): void {
		this.layoutMode = this.layoutMode === "columns" ? "accordion" : "columns";
		this.status = `Layout switched to ${this.layoutMode}.`;
		this.requestRender();
	}

	private applyExpansion(): void {
		if (this.expanded) {
			const i = this.focus === "objects" ? 0 : this.focus === "fields" ? 1 : 2;
			const others = [0, 1, 2].filter((j) => j !== i);
			this.paneWeights[i] = 0.80;
			for (const j of others) this.paneWeights[j] = 0.10;
		} else {
			this.paneWeights = [0.30, 0.34, 0.36];
		}
	}

	private handleDetailInput(data: string): void {
		if (matchesKey(data, Key.ctrl("c"))) return this.done();
		if (matchesKey(data, Key.escape) || data === "q") {
			this.detailMode = false;
			this.detailScrollTop = 0;
			this.requestRender();
			return;
		}
		if (matchesKey(data, Key.up)) {
			this.detailScrollTop = Math.max(0, this.detailScrollTop - 1);
			this.requestRender();
			return;
		}
		if (matchesKey(data, Key.down)) {
			this.detailScrollTop += 1;
			this.requestRender();
			return;
		}
		if (matchesKey(data, Key.home)) {
			this.detailScrollTop = 0;
			this.requestRender();
			return;
		}
		if (matchesKey(data, Key.left) || data === "[" || data === "<") return this.detailNav(-1);
		if (matchesKey(data, Key.right) || data === "]" || data === ">") return this.detailNav(1);
		if (data === "c") return this.copyDetailJson();
	}

	render(width: number): string[] {
		const w = Math.max(90, width);
		const t = this.theme;
		const title = this.strategy.title(this.org);
		const pill = this.transportPill();
		const pillVisible = pill ? visibleWidth(pill) + 1 : 0; // +1 for the leading space
		const ruleWidth = Math.max(0, w - visibleWidth(title) - pillVisible);
		const rule = "─".repeat(ruleWidth);
		const headerInner = pill
			? `${t.fg("accent", t.bold(title))}${t.fg("border", rule)} ${pill}`
			: `${t.fg("accent", t.bold(title))}${t.fg("border", rule)}`;
		const lines = [fit(headerInner, w)];

		if (this.layoutMode === "accordion") {
			lines.push(...this.renderAccordion(w));
		} else {
			const sepW = 3;
			const usable = Math.max(0, w - sepW * 2);
			let objectW = Math.max(0, Math.floor(usable * this.paneWeights[0]));
			let fieldW = Math.max(0, Math.floor(usable * this.paneWeights[1]));
			let previewW = Math.max(0, usable - objectW - fieldW);
			const slack = usable - (objectW + fieldW + previewW);
			if (slack > 0) previewW += slack;
			const leftSepFocused = this.focus === "objects" || this.focus === "fields";
			const rightSepFocused = this.focus === "fields" || this.focus === "preview";
			const leftSep = t.fg(leftSepFocused ? "accent" : "border", " │ ");
			const rightSep = t.fg(rightSepFocused ? "accent" : "border", " │ ");
			const objectPane = this.renderObjects(objectW);
			const fieldPane = this.renderFields(fieldW);
			const previewPane = this.renderPreview(previewW);
			const rows = Math.max(objectPane.length, fieldPane.length, previewPane.length);
			for (let i = 0; i < rows; i += 1) {
				lines.push(fit(pad(objectPane[i] ?? "", objectW) + leftSep + pad(fieldPane[i] ?? "", fieldW) + rightSep + fit(previewPane[i] ?? "", previewW), w));
			}
		}

		lines.push(t.fg("border", "─".repeat(w)));
		const filter = this.searchMode ? ` · filtering ${this.focus}: /${this.currentQuery()}` : "";
		const altKey = this.strategy.alternateCatalog ? ` · m ${this.strategy.alternateCatalog.label}` : "";
		const wLabel = this.strategy.whereLabel;
		const lLabel = this.strategy.limitLabel;
		lines.push(fit(t.fg("dim", `←→ pane · ↑↓ move · / filter${filter}${altKey} · enter toggle/detail · a/n/i fields · w ${wLabel} · L ${lLabel} · z 80% · v layout · r run · c copy · f refresh · q close`), w));
		if (this.editing) {
			const prompt = this.editing === "where" ? wLabel : lLabel;
			lines.push(fit(t.fg("accent", t.bold(`${prompt}> `) + `${this.editBuffer}█   (enter commit · esc cancel)`), w));
		}
		else if (this.confirmQuit) lines.push(fit(t.fg("warning", "Quit Explorer? Press Enter/Esc/q/y to quit, any other key to stay."), w));
		else lines.push(fit(this.loading ? t.fg("warning", `Loading… ${this.status}`) : t.fg("dim", this.status), w));
		return lines.map((line) => fit(line, w));
	}

	private transportPill(): string | undefined {
		if (!this.transportInfo) return undefined;
		const label = transportLabel(this.transportInfo);
		return this.theme.fg("borderAccent", `[${label}]`);
	}

	private renderAccordion(width: number): string[] {
		const t = this.theme;
		const lines: string[] = [];
		const panes: Array<{ id: typeof this.focus; label: string; renderer: (w: number) => string[] }> = [
			{ id: "objects", label: "Objects", renderer: (w) => this.renderObjects(w) },
			{ id: "fields", label: "Fields", renderer: (w) => this.renderFields(w) },
			{ id: "preview", label: "Request / Result", renderer: (w) => this.renderPreview(w) },
		];

		for (const pane of panes) {
			const focused = this.focus === pane.id;
			if (focused) {
				for (const l of pane.renderer(width)) lines.push(l);
			} else {
				lines.push(t.fg("muted", `[ ${pane.label} ]`));
			}
		}
		return lines;
	}

	invalidate(): void {}

	private resizePane(delta: number): void {
		const i = this.focus === "objects" ? 0 : this.focus === "fields" ? 1 : 2;
		const current = this.paneWeights[i]!;
		const next = Math.max(0.12, Math.min(0.75, current + delta));
		const actual = next - current;
		if (actual === 0) return;
		const others = [0, 1, 2].filter((j) => j !== i) as Array<0 | 1 | 2>;
		const share = actual / others.length;
		this.paneWeights[i] = next;
		for (const j of others) this.paneWeights[j] = Math.max(0.10, this.paneWeights[j]! - share);
		const sum = this.paneWeights[0] + this.paneWeights[1] + this.paneWeights[2];
		this.paneWeights = [this.paneWeights[0] / sum, this.paneWeights[1] / sum, this.paneWeights[2] / sum];
		this.requestRender();
	}

	private enterEdit(kind: "where" | "limit"): void {
		this.editing = kind;
		this.editBuffer = kind === "where" ? this.whereClause : String(this.limit);
		this.searchMode = false;
		this.confirmQuit = false;
		this.requestRender();
	}

	private handleEditInput(data: string): void {
		if (matchesKey(data, Key.escape)) {
			this.editing = null;
			this.editBuffer = "";
			this.requestRender();
			return;
		}
		if (matchesKey(data, Key.enter)) {
			if (this.editing === "where") {
				this.whereClause = this.editBuffer.trim();
				this.status = this.whereClause ? `${this.strategy.whereLabel} set: ${this.whereClause}` : `${this.strategy.whereLabel} cleared.`;
			} else if (this.editing === "limit") {
				const n = parseInt(this.editBuffer.trim(), 10);
				if (Number.isFinite(n) && n > 0) {
					this.limit = Math.min(10000, n);
					this.status = `${this.strategy.limitLabel} set to ${this.limit}.`;
				} else {
					this.status = `${this.strategy.limitLabel} must be a positive integer.`;
				}
			}
			this.editing = null;
			this.editBuffer = "";
			this.requestRender();
			return;
		}
		if (isBackspaceKey(data)) {
			this.editBuffer = this.editBuffer.slice(0, -1);
			this.requestRender();
			return;
		}
		if (data.length === 1 && data.charCodeAt(0) >= 32 && data.charCodeAt(0) < 127) {
			if (this.editing === "limit" && !/[0-9]/.test(data)) return;
			this.editBuffer += data;
			this.requestRender();
		}
	}

	private askQuit(): void {
		this.confirmQuit = true;
		this.requestRender();
	}

	private handleSearchInput(data: string): void {
		this.confirmQuit = false;
		if (matchesKey(data, Key.up)) return this.move(-1);
		if (matchesKey(data, Key.down)) return this.move(1);
		if (matchesKey(data, Key.home)) return this.jump(false);
		if (matchesKey(data, Key.end)) return this.jump(true);
		if (matchesKey(data, Key.left)) return this.moveFocus(-1);
		if (matchesKey(data, Key.right) || matchesKey(data, Key.tab)) return this.moveFocus(1);
		if (matchesKey(data, Key.enter)) {
			this.searchMode = false;
			if (this.focus === "objects") void this.selectObject(false);
			else if (this.focus === "fields") this.toggleField();
			else this.requestRender();
			return;
		}
		if (matchesKey(data, Key.escape)) {
			this.searchMode = false;
			this.requestRender();
			return;
		}
		if (isBackspaceKey(data)) {
			this.setCurrentQuery(this.currentQuery().slice(0, -1));
			this.resetScrollForFocus();
			this.requestRender();
			return;
		}
		if (data.length === 1 && data.charCodeAt(0) >= 32) {
			this.setCurrentQuery(this.currentQuery() + data);
			this.resetScrollForFocus();
			this.requestRender();
		}
	}

	private currentQuery(): string {
		return this.focus === "fields" ? this.fieldQuery : this.objectQuery;
	}

	private setCurrentQuery(value: string): void {
		if (this.focus === "fields") this.fieldQuery = value;
		else this.objectQuery = value;
	}

	private resetScrollForFocus(): void {
		if (this.focus === "fields") {
			this.fieldCursor = 0;
			this.fieldScrollTop = 0;
		} else {
			this.objectCursor = 0;
			this.objectScrollTop = 0;
		}
	}

	private moveFocus(delta: number): void {
		const panes: Array<typeof this.focus> = ["objects", "fields", "preview"];
		const idx = panes.indexOf(this.focus);
		this.focus = panes[Math.max(0, Math.min(panes.length - 1, idx + delta))]!;
		this.searchMode = false;
		if (this.expanded) this.applyExpansion();
		this.requestRender();
	}

	private move(delta: number): void {
		if (this.focus === "preview") {
			const count = this.result?.rows.length ?? 0;
			if (!count) return;
			this.resultCursor = Math.max(0, Math.min(count - 1, this.resultCursor + delta));
			this.ensureResultVisible(count);
		} else if (this.focus === "fields") {
			const count = this.filteredFields().length;
			this.fieldCursor = Math.max(0, Math.min(Math.max(0, count - 1), this.fieldCursor + delta));
			this.ensureFieldVisible(count);
		} else {
			const count = this.filteredObjects().length;
			this.objectCursor = Math.max(0, Math.min(Math.max(0, count - 1), this.objectCursor + delta));
			this.ensureObjectVisible(count);
		}
		this.requestRender();
	}

	private jump(end: boolean): void {
		if (this.focus === "preview") {
			const count = this.result?.rows.length ?? 0;
			if (!count) return;
			this.resultCursor = end ? Math.max(0, count - 1) : 0;
			this.ensureResultVisible(count);
		} else if (this.focus === "fields") {
			const count = this.filteredFields().length;
			this.fieldCursor = end ? Math.max(0, count - 1) : 0;
			this.ensureFieldVisible(count);
		} else {
			const count = this.filteredObjects().length;
			this.objectCursor = end ? Math.max(0, count - 1) : 0;
			this.ensureObjectVisible(count);
		}
		this.requestRender();
	}

	private async toggleAlternateCatalog(): Promise<void> {
		const alt = this.strategy.alternateCatalog;
		if (!alt) return;
		await alt.toggle();
		this.objectCursor = 0;
		this.objectScrollTop = 0;
		this.objectQuery = "";
		this.selectedObject = undefined;
		this.fields = [];
		this.selectedFields.clear();
		this.result = undefined;
		this.error = undefined;
		this.detailMode = false;
		this.resultCursor = 0;
		this.resultScrollTop = 0;
		await this.loadCatalog(false);
	}

	private async forceReloadCurrent(): Promise<void> {
		if (this.focus === "fields" && this.selectedObject) await this.loadFields(this.selectedObject, true);
		else await this.loadCatalog(true);
	}

	private async loadCatalog(force: boolean): Promise<void> {
		this.loading = true;
		this.status = `${force ? "Refreshing" : "Loading"} ${this.strategy.objectKindLabel()} catalog…`;
		this.requestRender();
		try {
			const loaded = await this.strategy.loadCatalog(force);
			this.objects = loaded.value;
			this.objectCacheLine = cacheStatus(loaded.kindLabel, loaded.cached, loaded.loadedAt);
			this.status = this.objectCacheLine;
			this.notify(this.objectCacheLine, loaded.cached ? "success" : "info");
		} catch (error) {
			this.status = error instanceof Error ? stripAnsi(error.message) : String(error);
			this.notify(this.status, "error");
		} finally {
			this.loading = false;
			this.requestRender();
		}
	}

	private async selectObject(force: boolean): Promise<void> {
		const obj = this.filteredObjects()[this.objectCursor];
		if (!obj) return;
		this.selectedObject = obj;
		this.focus = "fields";
		this.fieldCursor = 0;
		this.fieldScrollTop = 0;
		this.fieldQuery = "";
		this.selectedFields.clear();
		this.result = undefined;
		this.error = undefined;
		this.detailMode = false;
		await this.loadFields(obj, force);
	}

	private async loadFields(obj: TObject, force: boolean): Promise<void> {
		this.loading = true;
		const objName = this.strategy.objectName(obj);
		this.status = `${force ? "Refreshing" : "Loading"} fields for ${objName}…`;
		this.requestRender();
		try {
			const loaded = await this.strategy.loadFields(obj, force);
			this.fields = loaded.value;
			for (const name of this.strategy.defaultFieldSelections(this.fields)) this.selectedFields.add(name);
			this.status = cacheStatus(loaded.kindLabel, loaded.cached, loaded.loadedAt);
			this.notify(this.status, loaded.cached ? "success" : "info");
		} catch (error) {
			this.fields = [];
			this.status = `Load failed: ${extractErrorMessage(error)}`;
			this.notify(this.status, "error");
		} finally {
			this.loading = false;
			this.requestRender();
		}
	}

	private filteredObjects(): TObject[] {
		const q = this.objectQuery.trim().toLowerCase();
		if (!q) return this.objects;
		return this.objects.filter((obj) => this.strategy.objectQueryHay(obj).toLowerCase().includes(q));
	}

	private filteredFields(): TField[] {
		const q = this.fieldQuery.trim().toLowerCase();
		if (!q) return this.fields;
		return this.fields.filter((field) => this.strategy.fieldQueryHay(field).toLowerCase().includes(q));
	}

	private ensureObjectVisible(count: number): void {
		this.objectCursor = Math.max(0, Math.min(Math.max(0, count - 1), this.objectCursor));
		if (this.objectCursor < this.objectScrollTop) this.objectScrollTop = this.objectCursor;
		if (this.objectCursor >= this.objectScrollTop + this.pageSize) this.objectScrollTop = this.objectCursor - this.pageSize + 1;
	}

	private ensureFieldVisible(count: number): void {
		this.fieldCursor = Math.max(0, Math.min(Math.max(0, count - 1), this.fieldCursor));
		if (this.fieldCursor < this.fieldScrollTop) this.fieldScrollTop = this.fieldCursor;
		if (this.fieldCursor >= this.fieldScrollTop + this.pageSize) this.fieldScrollTop = this.fieldCursor - this.pageSize + 1;
	}

	private ensureResultVisible(count: number): void {
		this.resultCursor = Math.max(0, Math.min(Math.max(0, count - 1), this.resultCursor));
		if (this.resultCursor < this.resultScrollTop) this.resultScrollTop = this.resultCursor;
		if (this.resultCursor >= this.resultScrollTop + this.resultPageSize) this.resultScrollTop = this.resultCursor - this.resultPageSize + 1;
	}

	private toggleField(): void {
		const field = this.filteredFields()[this.fieldCursor];
		if (!field) return;
		const name = this.strategy.fieldName(field);
		if (this.selectedFields.has(name)) this.selectedFields.delete(name);
		else this.selectedFields.add(name);
		this.requestRender();
	}

	private selectVisibleFields(value: boolean): void {
		for (const field of this.filteredFields()) {
			const name = this.strategy.fieldName(field);
			if (value) this.selectedFields.add(name);
			else this.selectedFields.delete(name);
		}
		this.requestRender();
	}

	private invertVisibleFields(): void {
		for (const field of this.filteredFields()) {
			const name = this.strategy.fieldName(field);
			if (this.selectedFields.has(name)) this.selectedFields.delete(name);
			else this.selectedFields.add(name);
		}
		this.requestRender();
	}

	private selectedFieldNames(): string[] {
		return this.fields.map((f) => this.strategy.fieldName(f)).filter((name) => this.selectedFields.has(name));
	}

	private previewState(): PreviewParams<TObject> {
		return {
			selectedObject: this.selectedObject,
			selectedFieldNames: this.selectedFieldNames(),
			whereClause: this.whereClause,
			limit: this.limit,
		};
	}

	private copyEditor(): void {
		this.setEditorText(this.strategy.copyEditorPayload(this.previewState()));
		this.status = "Copied to editor.";
		this.notify(this.status, "info");
		this.requestRender();
	}

	private async runQuery(): Promise<void> {
		if (!this.selectedObject) {
			this.notify("Pick an object first.", "warning");
			return;
		}
		this.loading = true;
		this.result = undefined;
		this.error = undefined;
		this.detailMode = false;
		this.detailScrollTop = 0;
		this.resultCursor = 0;
		this.resultScrollTop = 0;
		this.status = `Running on ${this.strategy.objectName(this.selectedObject)}…`;
		this.requestRender();
		try {
			this.result = await this.strategy.runQuery(this.previewState());
			this.status = `Returned ${this.result.totalReturned} row(s).`;
			this.focus = "preview";
		} catch (error) {
			this.error = error instanceof Error ? stripAnsi(error.message) : String(error);
			this.status = `Query failed: ${extractErrorMessage(error)}`;
		} finally {
			this.loading = false;
			this.requestRender();
		}
	}

	private openDetail(): void {
		if (!this.result?.rows.length) return;
		this.resultCursor = Math.max(0, Math.min(this.result.rows.length - 1, this.resultCursor));
		this.detailMode = true;
		this.detailScrollTop = 0;
		this.requestRender();
	}

	private detailNav(delta: number): void {
		const data = this.result?.rows ?? [];
		if (!data.length) return;
		const next = Math.max(0, Math.min(data.length - 1, this.resultCursor + delta));
		if (next === this.resultCursor) return;
		this.resultCursor = next;
		this.detailScrollTop = 0;
		this.ensureResultVisible(data.length);
		this.requestRender();
	}

	private copyDetailJson(): void {
		const row = this.result?.rows[this.resultCursor];
		if (!row) return;
		this.setEditorText(JSON.stringify(row, null, 2));
		this.status = "Record JSON copied to editor.";
		this.notify(this.status, "info");
		this.requestRender();
	}

	private renderObjects(width: number): string[] {
		const t = this.theme;
		const filtered = this.filteredObjects();
		this.ensureObjectVisible(filtered.length);
		const lines = this.paneHeader(`${this.strategy.objectKindLabel()} (${filtered.length}/${this.objects.length})`, this.focus === "objects", width);
		lines.push(fit(t.fg(this.objectCacheLine.startsWith("Serving") ? "success" : "warning", this.objectCacheLine), width));
		if (this.objectQuery || (this.searchMode && this.focus === "objects")) lines.push(t.fg("accent", `/${this.objectQuery}`));
		const end = Math.min(filtered.length, this.objectScrollTop + this.pageSize);
		if (this.objectScrollTop > 0) lines.push(t.fg("dim", `↑ ${this.objectScrollTop} more`));
		for (let i = this.objectScrollTop; i < end; i += 1) {
			const obj = filtered[i]!;
			const selected = i === this.objectCursor;
			const name = this.strategy.objectName(obj);
			const active = name && name === (this.selectedObject ? this.strategy.objectName(this.selectedObject) : undefined);
			
			if (this.strategy.objectRow) {
				for (const l of this.strategy.objectRow(obj, selected, active, width, t)) lines.push(l);
			} else {
				const prefix = selected ? t.fg("accent", "› ") : active ? t.fg("success", "◆ ") : "  ";
				const label = this.strategy.objectDisplayName(obj);
				lines.push(fit(`${prefix}${selected ? t.fg("accent", label) : label}`, width));
				lines.push(fit(`    ${t.fg("muted", this.strategy.objectSubtitle(obj))}`, width));
			}
		}
		if (end < filtered.length) lines.push(t.fg("dim", `↓ ${filtered.length - end} more`));
		return lines.map((line) => fit(line, width));
	}

	private renderFields(width: number): string[] {
		const t = this.theme;
		const filtered = this.filteredFields();
		this.ensureFieldVisible(filtered.length);
		const lines = this.paneHeader(`Fields (${this.selectedFields.size}/${this.fields.length})`, this.focus === "fields", width);
		if (!this.selectedObject) {
			lines.push(t.fg("muted", "Select an object and press enter."));
			return lines;
		}
		if (this.fieldQuery || (this.searchMode && this.focus === "fields")) lines.push(t.fg("accent", `/${this.fieldQuery}`));
		const end = Math.min(filtered.length, this.fieldScrollTop + this.pageSize);
		if (this.fieldScrollTop > 0) lines.push(t.fg("dim", `↑ ${this.fieldScrollTop} more`));
		for (let i = this.fieldScrollTop; i < end; i += 1) {
			const field = filtered[i]!;
			const name = this.strategy.fieldName(field);
			const selected = i === this.fieldCursor;
			const checked = this.selectedFields.has(name) ? t.fg("success", "[x]") : t.fg("dim", "[ ]");
			const prefix = selected ? t.fg("accent", "› ") : "  ";
			lines.push(fit(`${prefix}${checked} ${selected ? t.fg("accent", name) : name} ${t.fg("muted", this.strategy.fieldTypeLabel(field))}`, width));
		}
		if (end < filtered.length) lines.push(t.fg("dim", `↓ ${filtered.length - end} more`));
		if (!filtered.length && !this.loading) lines.push(t.fg("warning", "No fields match."));
		return lines.map((line) => fit(line, width));
	}

	private renderPreview(width: number): string[] {
		const t = this.theme;
		const lines = this.paneHeader("Request / Result", this.focus === "preview", width);
		if (this.detailMode && this.result) {
			for (const l of this.renderRecordDetail(width)) lines.push(l);
			return lines.map((line) => fit(line, width));
		}
		lines.push(t.fg("accent", t.bold("Request")));
		for (const line of this.strategy.previewLines(this.previewState())) lines.push(fit(t.fg("toolOutput", line), width));
		lines.push(fit(t.fg("muted", `w: edit ${this.strategy.whereLabel} · L: edit ${this.strategy.limitLabel} (${this.limit})${this.whereClause ? ` · ${this.strategy.whereLabel}: ${this.whereClause}` : ""}`), width));
		if (this.error) {
			lines.push("", t.fg("error", "Error"));
			for (const l of this.wrap(this.error, width)) lines.push(l);
		} else if (this.result) {
			lines.push("");
			for (const l of this.renderResultTable(this.result, width)) lines.push(l);
		} else {
			lines.push("", t.fg("dim", "Press r to run. Press c to copy."));
		}
		return lines.map((line) => fit(line, width));
	}

	private renderResultTable(result: RunResult, width: number): string[] {
		const t = this.theme;
		const cols = result.columns;
		const usable = Math.max(0, width - 2); // reserve cursor prefix
		const maxCols = Math.max(1, Math.min(cols.length, Math.floor(usable / 13)));
		const visibleCols = cols.slice(0, maxCols);
		const colW = Math.max(8, Math.floor((usable - Math.max(0, visibleCols.length - 1) * 3) / Math.max(1, visibleCols.length)));
		const sep = t.fg("border", " │ ");
		this.ensureResultVisible(result.rows.length);
		const lines: string[] = [];
		const hint = this.focus === "preview" && result.rows.length > 0 ? t.fg("dim", " · ↑↓ row · enter detail") : "";
		lines.push(t.fg("success", `Returned ${result.totalReturned} row(s)`) + hint);
		lines.push("  " + visibleCols.map((c) => t.fg("accent", pad(c, colW))).join(sep));
		lines.push("  " + t.fg("border", "─".repeat(Math.min(usable, visibleCols.length * colW + Math.max(0, visibleCols.length - 1) * 3))));
		const end = Math.min(result.rows.length, this.resultScrollTop + this.resultPageSize);
		if (this.resultScrollTop > 0) lines.push(t.fg("dim", `↑ ${this.resultScrollTop} more`));
		for (let i = this.resultScrollTop; i < end; i += 1) {
			const row = result.rows[i]!;
			const selected = i === this.resultCursor && this.focus === "preview";
			const prefix = selected ? t.fg("accent", "› ") : "  ";
			const rowText = visibleCols.map((c) => {
				const val = formatValue(row[c]);
				return pad(highlightText(val, this.whereClause, t), colW);
			}).join(sep);
			lines.push(prefix + rowText);
		}
		if (end < result.rows.length) lines.push(t.fg("dim", `↓ ${result.rows.length - end} more`));
		if (cols.length > maxCols) lines.push(t.fg("dim", `… ${cols.length - maxCols} more columns hidden (open detail to see all)`));
		return lines;
	}

	private renderRecordDetail(width: number): string[] {
		const t = this.theme;
		const result = this.result!;
		const data = result.rows;
		const row = data[this.resultCursor] ?? {};
		const objName = this.selectedObject ? this.strategy.objectName(this.selectedObject) : "";
		// Build a stable name list: result.columns first (ordered), plus any extra keys present on the row
		const names: string[] = [];
		const seen = new Set<string>();
		for (const c of result.columns) { names.push(c); seen.add(c); }
		for (const k of Object.keys(row)) if (!seen.has(k)) { names.push(k); seen.add(k); }
		const lines: string[] = [];
		lines.push(t.fg("accent", t.bold(`Record ${this.resultCursor + 1} of ${data.length}`)) + t.fg("dim", `  ·  ${objName}`));
		lines.push(t.fg("dim", "↑↓ scroll · ←→ prev/next record · c copy JSON · esc back"));
		lines.push(t.fg("border", "─".repeat(width)));
		const nameWMax = names.reduce((acc, n) => Math.max(acc, visibleWidth(n)), 0);
		const labelW = Math.max(8, Math.min(36, nameWMax));
		const valueW = Math.max(8, width - labelW - 2);
		const fieldLines: string[] = [];
		for (const name of names) {
			const raw = highlightText(formatValue(row[name]), this.whereClause, t);
			const pieces = raw.length === 0 ? [""] : this.wrapValue(raw, valueW);
			fieldLines.push(`${t.fg("muted", pad(name, labelW))}  ${fit(pieces[0]!, valueW)}`);
			for (let k = 1; k < pieces.length; k += 1) {
				fieldLines.push(`${pad("", labelW)}  ${fit(pieces[k]!, valueW)}`);
			}
		}
		const maxScroll = Math.max(0, fieldLines.length - 1);
		if (this.detailScrollTop > maxScroll) this.detailScrollTop = maxScroll;
		if (this.detailScrollTop > 0) lines.push(t.fg("dim", `↑ ${this.detailScrollTop} hidden`));
		for (const line of fieldLines.slice(this.detailScrollTop)) lines.push(line);
		return lines;
	}

	private wrapValue(text: string, width: number): string[] {
		const out: string[] = [];
		for (const raw of text.split("\n")) {
			let remaining = raw;
			if (!remaining.length) {
				out.push("");
				continue;
			}
			while (visibleWidth(remaining) > width) {
				out.push(fit(remaining, width));
				const consumed = Math.max(1, Math.floor(width * 0.85));
				if (consumed >= remaining.length) {
					remaining = "";
					break;
				}
				remaining = remaining.slice(consumed);
			}
			if (remaining.length > 0) out.push(remaining);
		}
		return out;
	}

	private wrap(text: string, width: number, maxLines = 100): string[] {
		const out: string[] = [];
		for (const raw of text.split("\n")) {
			let line = raw;
			if (!line.length) {
				out.push("");
				continue;
			}
			while (visibleWidth(line) > width) {
				out.push(fit(line, width));
				if (out.length >= maxLines) return out;
				const consumed = Math.max(1, Math.floor(width * 0.8));
				if (consumed >= line.length) {
					line = "";
					break;
				}
				line = line.slice(consumed);
			}
			if (line.length > 0) {
				out.push(line);
				if (out.length >= maxLines) return out;
			}
		}
		return out;
	}

	private paneHeader(label: string, focused: boolean, width: number): string[] {
		const t = this.theme;
		const marker = focused ? t.fg("accent", "▌") : " ";
		const title = focused ? t.fg("accent", t.bold(label)) : t.fg("muted", t.bold(label));
		const ruleChar = focused ? "━" : "─";
		const ruleColor = focused ? "accent" : "border";
		return [fit(`${marker} ${title}`, width), t.fg(ruleColor, ruleChar.repeat(Math.max(0, width)))];
	}
}

// ─── Strategies ──────────────────────────────────────────────────────────

function buildQuerySql(state: PreviewParams<DmoMeta>): string {
	const obj = state.selectedObject;
	if (!obj?.name) return "-- select a DMO/DLO";
	const projection = state.selectedFieldNames.length > 0 ? state.selectedFieldNames.map(quoteIdentifier).join(",\n  ") : "*";
	const where = state.whereClause.trim() ? `\nWHERE ${state.whereClause.trim()}` : "";
	return `SELECT\n  ${projection}\nFROM ${quoteIdentifier(obj.name)}${where}\nLIMIT ${state.limit}`;
}

type QueryFilterMode = "All" | "DMO" | "DLO";

async function loadCombinedQueryCatalog(
	pi: ExtensionAPI,
	org: string,
	force: boolean,
): Promise<{ value: DmoMeta[]; cached: boolean; loadedAt: number }> {
	const [dmo, dlo] = await Promise.all([
		loadEntityMetadata(pi, org, "DataModelObject", force),
		loadEntityMetadata(pi, org, "DataLakeObject", force),
	]);
	const tagged: DmoMeta[] = [
		...dmo.value.filter((m) => m.name).map((m) => ({ ...m, entityType: "DMO" as const })),
		...dlo.value.filter((m) => m.name).map((m) => ({ ...m, entityType: "DLO" as const })),
	];
	tagged.sort((a, b) => (a.displayName || a.name || "").localeCompare(b.displayName || b.name || ""));
	return {
		value: tagged,
		cached: dmo.cached && dlo.cached,
		loadedAt: Math.max(dmo.loadedAt, dlo.loadedAt),
	};
}

function createQueryStrategy(
	pi: ExtensionAPI,
	org: string,
	initial: { objects: DmoMeta[]; cacheLine: string },
	forceRefreshDefault: boolean,
	requestRender: () => void,
): SpaStrategy<DmoMeta, DmoField> {
	let filter: QueryFilterMode = "All";
	const nextFilter = (m: QueryFilterMode): QueryFilterMode => (m === "All" ? "DMO" : m === "DMO" ? "DLO" : "All");
	const kindLabel = () => (filter === "All" ? "DMO+DLO" : filter);
	let allObjects: DmoMeta[] = initial.objects;
	const applyFilter = (objs: DmoMeta[]): DmoMeta[] => {
		if (filter === "All") return objs;
		return objs.filter((o) => o.entityType === filter);
	};
	const typeBadge = (entityType: "DMO" | "DLO" | undefined, theme: ThemeLike): string => {
		const label = entityType ?? "---";
		return pad(theme.fg("borderAccent", label), 5);
	};
	return {
		whereLabel: "WHERE",
		limitLabel: "LIMIT",
		defaultLimit: 5,
		title: (o) => ` Data 360 Query Explorer · ${o} · ${kindLabel()} `,
		objectKindLabel: () => kindLabel(),
		initialObjects: () => applyFilter(allObjects),
		initialCacheLine: () => initial.cacheLine,
		loadCatalog: async (force) => {
			const r = await loadCombinedQueryCatalog(pi, org, force);
			allObjects = r.value;
			return {
				value: applyFilter(r.value),
				cached: r.cached,
				loadedAt: r.loadedAt,
				kindLabel: `${kindLabel()} catalog`,
			};
		},
		loadFields: async (obj, force) => {
			const r = await loadQueryableFields(pi, org, obj.name!, force || forceRefreshDefault);
			return { value: r.value, cached: r.cached, loadedAt: r.loadedAt, kindLabel: `${obj.name} queryable fields` };
		},
		defaultFieldSelections: (fs) => queryDefaultFieldNames(fs, 6),
		objectName: (o) => o.name ?? "",
		objectDisplayName: (o) => o.displayName ?? o.name ?? "(unnamed)",
		objectRow: (o, selected, active, width, theme) => {
			const status = theme.fg("success", pad("ACTIVE", 7));
			const type = typeBadge(o.entityType, theme);
			const cat = pad(categoryColor(o.category || "Other", theme), 11);
			const label = o.displayName || o.name || "(unnamed)";
			const name = o.name || "";
			const row = `${status} ${type} ${cat} ${label} ${theme.fg("dim", `(${name})`)}`;
			return [selected ? theme.bold(row) : row];
		},
		objectQueryHay: (o) => `${o.displayName ?? ""} ${o.name ?? ""} ${o.category ?? ""} ${o.type ?? ""} ${o.entityType ?? ""}`,
		fieldName: (f) => f.name ?? f.label ?? "(unnamed)",
		fieldQueryHay: (f) => `${f.name ?? ""} ${f.label ?? ""} ${f.type ?? ""} ${f.dataType ?? ""}`,
		fieldTypeLabel: (f) => f.type ?? f.dataType ?? "",
		previewLines: (state) => {
			const sql = buildQuerySql(state);
			return ["SQL", ...sql.split("\n")];
		},
		runQuery: async (state, signal) => {
			const sql = buildQuerySql(state);
			const r = await sfApi<QuerySqlResponse>(pi, org, "POST", "/ssot/query-sql", { sql }, signal);
			const cols = (r.metadata ?? []).map((m, i) => m.name || `col_${i + 1}`);
			const rows: SpaRow[] = (r.data ?? []).map((row) => {
				const o: SpaRow = {};
				cols.forEach((c, i) => { o[c] = row[i]; });
				return o;
			});
			return { rows, columns: cols, totalReturned: r.returnedRows ?? rows.length, raw: r };
		},
		copyEditorPayload: (state) => buildQuerySql(state),
		alternateCatalog: {
			label: "All/DMO/DLO",
			toggle: async () => {
				filter = nextFilter(filter);
				requestRender();
			},
		},
	};
}

function buildProfileRequest(state: PreviewParams<ProfileMeta>): string {
	const obj = state.selectedObject;
	if (!obj?.name) return "GET /ssot/profile/<select Profile DMO>";
	const params: string[] = [];
	if (state.selectedFieldNames.length) params.push(`fields=${state.selectedFieldNames.join(",")}`);
	if (state.whereClause.trim()) params.push(`filters=${state.whereClause.trim()}`);
	else params.push("filters=[<required, e.g. ssot__Id__c=001fj00000o3iuBAAQ>]");
	params.push(`batchSize=${state.limit}`);
	return `GET /ssot/profile/${obj.name}\n  ?${params.join("\n  &")}`;
}

function profileDefaultFieldNames(fields: ProfileField[], primaryKeyName?: string): string[] {
	const names = fields.map((f) => f.name).filter((n): n is string => !!n);
	const out: string[] = [];
	if (primaryKeyName && names.includes(primaryKeyName)) out.push(primaryKeyName);
	for (const n of names) {
		if (out.length >= 6) break;
		if (!out.includes(n)) out.push(n);
	}
	return out;
}

function createProfileStrategy(
	pi: ExtensionAPI,
	org: string,
	initial: { objects: ProfileMeta[]; cacheLine: string },
): SpaStrategy<ProfileMeta, ProfileField> {
	return {
		whereLabel: "filters",
		limitLabel: "batchSize",
		defaultLimit: 10,
		title: (o) => ` Data 360 Profile Explorer · ${o} `,
		objectKindLabel: () => "Profile DMO",
		initialObjects: () => initial.objects,
		initialCacheLine: () => initial.cacheLine,
		loadCatalog: async (force) => {
			const r = await loadProfileMetadata(pi, org, force);
			return { value: r.value, cached: r.cached, loadedAt: r.loadedAt, kindLabel: "Profile metadata" };
		},
		loadFields: async (obj, _force) => {
			return { value: obj.fields ?? [], cached: true, loadedAt: Date.now(), kindLabel: `${obj.name} fields` };
		},
		defaultFieldSelections: (fs) => profileDefaultFieldNames(fs),
		objectName: (o) => o.name ?? "",
		objectDisplayName: (o) => o.displayName ?? o.name ?? "(unnamed)",
		objectRow: (o, selected, active, width, theme) => {
			const status = theme.fg("success", pad("ACTIVE", 7));
			const cat = pad(categoryColor(o.category || "Other", theme), 11);
			const label = o.displayName || o.name || "(unnamed)";
			const name = o.name || "";
			const rels = (o.relationships?.length ?? 0).toString();
			const row = `${status} ${cat} ${label} ${theme.fg("dim", `(${name})`)} ${theme.fg("muted", rels)}`;
			return [selected ? theme.bold(row) : row];
		},
		objectQueryHay: (o) => `${o.displayName ?? ""} ${o.name ?? ""} ${o.category ?? ""}`,
		fieldName: (f) => f.name ?? f.displayName ?? "(unnamed)",
		fieldQueryHay: (f) => `${f.name ?? ""} ${f.displayName ?? ""} ${f.type ?? ""} ${f.businessType ?? ""}`,
		fieldTypeLabel: (f) => f.type ?? f.businessType ?? "",
		previewLines: (state) => buildProfileRequest(state).split("\n"),
		runQuery: async (state, signal) => {
			if (!state.selectedObject?.name) throw new Error("Pick a Profile DMO first.");
			if (!state.whereClause.trim()) throw new Error("Profile API requires filters. Press w to enter one, e.g. [ssot__Id__c=001fj00000o3iuBAAQ]");
			const params: string[] = [];
			if (state.selectedFieldNames.length) params.push(`fields=${encodeURIComponent(state.selectedFieldNames.join(","))}`);
			params.push(`filters=${encodeURIComponent(state.whereClause.trim())}`);
			params.push(`batchSize=${state.limit}`);
			const path = `/ssot/profile/${encodeURIComponent(state.selectedObject.name)}?${params.join("&")}`;
			const r = await sfApi<{ data?: SpaRow[]; done?: boolean }>(pi, org, "GET", path, undefined, signal);
			const rows = (r.data ?? []) as SpaRow[];
			const columns = state.selectedFieldNames.length
				? state.selectedFieldNames
				: rows[0]
					? Object.keys(rows[0])
					: [];
			return { rows, columns, totalReturned: rows.length, raw: r };
		},
		copyEditorPayload: (state) => buildProfileRequest(state),
		alternateCatalog: null,
	};
}

class ResultViewer implements Component {
	private offset = 0;
	constructor(private readonly title: string, private readonly text: string, private readonly theme: ThemeLike, private readonly done: () => void) {}
	handleInput(data: string): void {
		if (matchesKey(data, Key.escape) || data === "q" || matchesKey(data, Key.enter)) return this.done();
		if (matchesKey(data, Key.up)) this.offset = Math.max(0, this.offset - 1);
		if (matchesKey(data, Key.down)) this.offset += 1;
	}
	render(width: number): string[] {
		const lines = this.text.split("\n");
		const visible = lines.slice(this.offset, this.offset + 32).map((l) => fit(l, width));
		return [this.theme.fg("accent", this.theme.bold(this.title)), this.theme.fg("dim", "↑↓ scroll · enter/esc/q close"), this.theme.fg("border", "─".repeat(width)), ...visible];
	}
	invalidate(): void {}
}

async function runWithLoader<T>(ctx: any, label: string, work: (signal: AbortSignal) => Promise<T>): Promise<T | null> {
	return ctx.ui.custom<T | null>((tui: any, theme: any, _kb: any, done: (v: T | null) => void) => {
		const loader = new BorderedLoader(tui, theme, label);
		loader.onAbort = () => done(null);
		work(loader.signal).then(done).catch((error) => done({ error: error instanceof Error ? error.message : String(error) } as T));
		return loader;
	});
}

function parseOrgAndRefresh(args: string): { org: string; forceRefresh: boolean } {
	const parts = args.trim().split(/\s+/).filter(Boolean);
	const forceRefresh = parts.some((p) => ["refresh", "reload", "force", "--refresh", "--force", "-f"].includes(p.toLowerCase()));
	const org = parts.find((p) => !["refresh", "reload", "force", "--refresh", "--force", "-f", "default"].includes(p.toLowerCase())) ?? DEFAULT_ORG;
	return { org, forceRefresh };
}

export default function data360Browser(pi: ExtensionAPI) {
	pi.registerCommand("d360-browser", {
		description: "Full-screen Data 360 API browser / operation gallery",
		getArgumentCompletions: (prefix: string) => [DEFAULT_ORG, "default", "refresh", `${DEFAULT_ORG} refresh`].filter((v) => v.startsWith(prefix)).map((value) => ({ value, label: value })),
		handler: async (args, ctx) => {
			if (!ctx.hasUI) return ctx.ui.notify("/d360-browser requires interactive pi TUI mode", "error");
			const { org, forceRefresh } = parseOrgAndRefresh(args);
			await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
				return new D360Browser(
					pi,
					org,
					theme,
					(text) => ctx.ui.setEditorText(text),
					() => runDataGraphWizard(pi, ctx, org, forceRefresh),
					() => done(),
					() => tui.requestRender(),
				);
			});
		},
	});

	pi.registerCommand("d360-data-graph-new", {
		description: "Create a Data 360 Data Graph with the TUI wizard",
		getArgumentCompletions: (prefix: string) => [DEFAULT_ORG, "default", "refresh", `${DEFAULT_ORG} refresh`].filter((v) => v.startsWith(prefix)).map((value) => ({ value, label: value })),
		handler: async (args, ctx) => {
			if (!ctx.hasUI) return ctx.ui.notify("/d360-data-graph-new requires interactive pi TUI mode", "error");
			const { org, forceRefresh } = parseOrgAndRefresh(args);
			await runDataGraphWizard(pi, ctx, org, forceRefresh);
		},
	});

	pi.registerCommand("d360-semantic-explorer", {
		description: "Semantic Vector Search explorer: search across indexed vectors using natural language",
		getArgumentCompletions: (prefix: string) => [DEFAULT_ORG, "default", "refresh", `${DEFAULT_ORG} refresh`].filter((v) => v.startsWith(prefix)).map((value) => ({ value, label: value })),
		handler: async (args, ctx) => {
			if (!ctx.hasUI) return ctx.ui.notify("/d360-semantic-explorer requires interactive pi TUI mode", "error");
			const { org, forceRefresh } = parseOrgAndRefresh(args);
			const loaded = await runWithLoader(ctx, `${forceRefresh ? "Refreshing" : "Loading"} Search Index catalog for ${org}…`, () => loadSearchIndexes(pi, org, forceRefresh));
			if (!loaded || (loaded as any).error) return ctx.ui.notify(`Could not load Search Indexes: ${(loaded as any)?.error ?? "cancelled"}`, "error");
			const cacheLine = cacheStatus("Search Index catalog", (loaded as any).cached, (loaded as any).loadedAt);
			ctx.ui.notify(cacheLine, (loaded as any).cached ? "success" : "info");
			const objects = (loaded as { value: SearchIndex[] }).value;
			await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
				const strategy = createSemanticStrategy(pi, org, { objects, cacheLine });
				return new Spa<SearchIndex, DmoField>({
					pi,
					org,
					theme,
					strategy,
					setEditorText: (text) => ctx.ui.setEditorText(text),
					notify: (message, level) => ctx.ui.notify(message, level),
					done: () => done(),
					requestRender: () => tui.requestRender(),
				});
			});
		},
	});

	pi.registerCommand("d360-query-explorer", {
		description: "Single-screen Data 360 query explorer with object list, field picker, SQL preview, and results",
		getArgumentCompletions: (prefix: string) => [DEFAULT_ORG, "default", "refresh", `${DEFAULT_ORG} refresh`].filter((v) => v.startsWith(prefix)).map((value) => ({ value, label: value })),
		handler: async (args, ctx) => {
			if (!ctx.hasUI) return ctx.ui.notify("/d360-query-explorer requires interactive pi TUI mode", "error");
			const { org, forceRefresh } = parseOrgAndRefresh(args);
			const loaded = await runWithLoader(ctx, `${forceRefresh ? "Refreshing" : "Loading"} DMO+DLO catalog for ${org}…`, () => loadCombinedQueryCatalog(pi, org, forceRefresh));
			if (!loaded || (loaded as any).error) return ctx.ui.notify(`Could not load DMO+DLO catalog: ${(loaded as any)?.error ?? "cancelled"}`, "error");
			const cacheLine = cacheStatus("DMO+DLO catalog", (loaded as any).cached, (loaded as any).loadedAt);
			ctx.ui.notify(cacheLine, (loaded as any).cached ? "success" : "info");
			const objects = ((loaded as { value?: DmoMeta[] }).value ?? []);
			await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
				const strategy = createQueryStrategy(pi, org, { objects, cacheLine }, forceRefresh, () => tui.requestRender());
				return new Spa<DmoMeta, DmoField>({
					pi,
					org,
					theme,
					strategy,
					setEditorText: (text) => ctx.ui.setEditorText(text),
					notify: (message, level) => ctx.ui.notify(message, level),
					done: () => done(),
					requestRender: () => tui.requestRender(),
				});
			});
		},
	});

	pi.registerCommand("d360-profile-explorer", {
		description: "Single-screen Data 360 profile explorer: pick a profile DMO, choose fields, edit filters/batchSize, browse records.",
		getArgumentCompletions: (prefix: string) => [DEFAULT_ORG, "default", "refresh", `${DEFAULT_ORG} refresh`].filter((v) => v.startsWith(prefix)).map((value) => ({ value, label: value })),
		handler: async (args, ctx) => {
			if (!ctx.hasUI) return ctx.ui.notify("/d360-profile-explorer requires interactive pi TUI mode", "error");
			const { org, forceRefresh } = parseOrgAndRefresh(args);
			const loaded = await runWithLoader(ctx, `${forceRefresh ? "Refreshing" : "Loading"} profile metadata for ${org}…`, () => loadProfileMetadata(pi, org, forceRefresh));
			if (!loaded || (loaded as any).error) return ctx.ui.notify(`Could not load /ssot/profile/metadata: ${(loaded as any)?.error ?? "cancelled"}`, "error");
			const cacheLine = cacheStatus("Profile metadata", (loaded as any).cached, (loaded as any).loadedAt);
			ctx.ui.notify(cacheLine, (loaded as any).cached ? "success" : "info");
			const objects = ((loaded as { value?: ProfileMeta[] }).value ?? []).filter((m) => m.name);
			await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
				const strategy = createProfileStrategy(pi, org, { objects, cacheLine });
				return new Spa<ProfileMeta, ProfileField>({
					pi,
					org,
					theme,
					strategy,
					setEditorText: (text) => ctx.ui.setEditorText(text),
					notify: (message, level) => ctx.ui.notify(message, level),
					done: () => done(),
					requestRender: () => tui.requestRender(),
				});
			});
		},
	});

	pi.registerCommand("d360-query-builder", {
		description: "Midnight Commander-style DMO/DLO field picker for Data 360 SQL",
		getArgumentCompletions: (prefix: string) => [DEFAULT_ORG, "default", "refresh", `${DEFAULT_ORG} refresh`].filter((v) => v.startsWith(prefix)).map((value) => ({ value, label: value })),
		handler: async (args, ctx) => {
			if (!ctx.hasUI) return ctx.ui.notify("/d360-query-builder requires interactive pi TUI mode", "error");
			const { org, forceRefresh } = parseOrgAndRefresh(args);
			await runQueryBuilder(pi, ctx, org, forceRefresh);
		},
	});

	pi.registerCommand("d360-request", {
		description: "Prompted d360_api-style request builder",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) return ctx.ui.notify("/d360-request requires interactive pi TUI mode", "error");
			const org = DEFAULT_ORG;
			const method = ((await ctx.ui.select("HTTP method", ["GET", "POST", "PATCH", "PUT", "DELETE"])) ?? "GET") as Method;
			const suggestedPath = args.trim() || "/ssot/data-streams?limit=5";
			const path = (await ctx.ui.input(`Data 360 path (blank = ${suggestedPath})`, suggestedPath))?.trim() || suggestedPath;
			let body: Json | undefined;
			if (method !== "GET" && method !== "DELETE") {
				const bodyText = await ctx.ui.editor("JSON body", "{}\n");
				if (bodyText?.trim()) body = JSON.parse(bodyText);
			}
			const dryRun = await ctx.ui.confirm("Dry run?", "Show equivalent d360_api request instead of calling Salesforce?", { timeout: 30_000 });
			const op: Operation = { id: "custom", label: "Custom", description: "Custom request", method, path, kind: dryRun ? "mutation" : "read", body };
			if (dryRun) {
				ctx.ui.setEditorText(d360ToolCall(op, org, { dry_run: true }));
				ctx.ui.notify("Dry-run d360_api JSON copied to editor", "info");
				return;
			}
			const result = await runWithLoader(ctx, `${method} ${path}`, (signal) => sfApi<Json>(pi, org, method, path, body, signal));
			if (result === null) return ctx.ui.notify("Cancelled", "info");
			await ctx.ui.custom<void>((_tui, theme, _kb, done) => new ResultViewer(`${method} ${path}`, JSON.stringify(result, null, 2), theme, done));
		},
	});
}
