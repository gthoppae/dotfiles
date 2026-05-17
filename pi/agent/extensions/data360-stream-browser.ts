import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { BorderedLoader } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";

type ThemeLike = {
	bold: (text: string) => string;
	fg: (color: string, text: string) => string;
};

type Data360Field = {
	name?: string;
	label?: string;
	dataType?: string;
	isPrimaryKey?: boolean;
};

type DataStream = {
	name: string;
	label?: string;
	status?: string;
	lastRunStatus?: string;
	lastRefreshDate?: string;
	lastAddedRecords?: number;
	lastProcessedRecords?: number;
	totalRecords?: number;
	connectorInfo?: {
		connectorType?: string;
		connectorDetails?: { name?: string; type?: string };
	};
	dataLakeObjectInfo?: {
		name?: string;
		label?: string;
		category?: string;
		fields?: Data360Field[];
		dataLakeFieldInfoRepresentation?: Data360Field[];
	};
	mappings?: unknown[];
	sourceFields?: Data360Field[];
};

type StreamListResponse = {
	dataStreams?: DataStream[];
	nextPageUrl?: string;
	totalSize?: number;
};

type QuerySqlResponse = {
	data?: unknown[][];
	metadata?: Array<{ name?: string; type?: string; nullable?: boolean }>;
	returnedRows?: number;
	status?: unknown;
};

type LoadResult =
	| { ok: true; streams: DataStream[]; totalSize?: number }
	| { ok: false; error: string }
	| null;

const API_VERSION = "66.0";
const DEFAULT_ORG = "afdc-l3";

function normalizeApiPath(path: string): string {
	const trimmed = path.trim();
	const versionedPrefix = new RegExp(`^/services/data/v${API_VERSION.replace(".", "\\.")}`);
	if (versionedPrefix.test(trimmed)) return trimmed.replace(versionedPrefix, "") || "/";
	if (trimmed.startsWith("/services/data/")) return trimmed.replace(/^\/services\/data\/v[0-9.]+/, "") || "/";
	return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function parseJsonFromStdout(stdout: string): unknown {
	const text = stdout.trim();
	const firstJsonChar = text.search(/[\[{]/);
	if (firstJsonChar < 0) throw new Error(`No JSON response in Salesforce CLI output: ${text.slice(0, 120)}`);
	return JSON.parse(text.slice(firstJsonChar));
}

async function sfApi<T>(
	pi: ExtensionAPI,
	org: string,
	method: "GET" | "POST",
	path: string,
	body?: unknown,
	signal?: AbortSignal,
): Promise<T> {
	const apiPath = normalizeApiPath(path);
	const args = [
		"api",
		"request",
		"rest",
		`/services/data/v${API_VERSION}${apiPath}`,
		"--target-org",
		org,
		"--method",
		method,
	];

	if (body !== undefined) args.push("--body", JSON.stringify(body));

	const result = await pi.exec("sf", args, { timeout: 60_000, signal });

	if (result.code !== 0) {
		const message = [result.stderr, result.stdout].filter(Boolean).join("\n").trim();
		throw new Error(message || `sf api request rest failed with exit code ${result.code}`);
	}

	return parseJsonFromStdout(result.stdout) as T;
}

async function sfGet<T>(pi: ExtensionAPI, org: string, path: string, signal?: AbortSignal): Promise<T> {
	return sfApi<T>(pi, org, "GET", path, undefined, signal);
}

async function sfPost<T>(pi: ExtensionAPI, org: string, path: string, body: unknown, signal?: AbortSignal): Promise<T> {
	return sfApi<T>(pi, org, "POST", path, body, signal);
}

async function fetchStreams(pi: ExtensionAPI, org: string, signal?: AbortSignal): Promise<{ streams: DataStream[]; totalSize?: number }> {
	let path = "/ssot/data-streams?limit=100";
	const streams: DataStream[] = [];
	let totalSize: number | undefined;

	for (let page = 0; page < 10 && path; page += 1) {
		const response = await sfGet<StreamListResponse>(pi, org, path, signal);
		streams.push(...(response.dataStreams ?? []));
		totalSize = response.totalSize ?? totalSize;
		path = response.nextPageUrl ? normalizeApiPath(response.nextPageUrl) : "";
	}

	return { streams, totalSize };
}

function statusBadge(theme: ThemeLike, status?: string): string {
	const value = status || "UNKNOWN";
	if (["ACTIVE", "SUCCESS", "COMPLETED"].includes(value.toUpperCase())) return theme.fg("success", value);
	if (["ERROR", "FAILED"].includes(value.toUpperCase())) return theme.fg("error", value);
	if (["IN_PROGRESS", "RUNNING", "PROCESSING"].includes(value.toUpperCase())) return theme.fg("warning", value);
	return theme.fg("muted", value);
}

function fit(text: string, width: number): string {
	return truncateToWidth(text, Math.max(0, width), "…");
}

function pad(text: string, width: number): string {
	const fitted = fit(text, width);
	return fitted + " ".repeat(Math.max(0, width - visibleWidth(fitted)));
}

function fieldsFor(stream?: DataStream): Data360Field[] {
	return stream?.dataLakeObjectInfo?.fields ?? stream?.dataLakeObjectInfo?.dataLakeFieldInfoRepresentation ?? [];
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

function quoteIdentifier(identifier: string): string {
	// DLO API names in this UI come from Data 360 metadata. They are normally safe
	// bare identifiers such as Foo__dll. Quote only when a name contains odd chars.
	return /^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier) ? identifier : `"${identifier.replace(/"/g, '""')}"`;
}

function queryForDlo(dloName: string): string {
	return `SELECT *\nFROM ${quoteIdentifier(dloName)}\nLIMIT 5`;
}

function renderBox(lines: string[], width: number, theme: ThemeLike): string[] {
	const boxWidth = Math.max(36, Math.min(width, 110));
	const innerWidth = boxWidth - 4;
	const top = theme.fg("borderAccent", `╭${"─".repeat(boxWidth - 2)}╮`);
	const bottom = theme.fg("borderAccent", `╰${"─".repeat(boxWidth - 2)}╯`);
	return [
		top,
		...lines.map((line) => theme.fg("borderAccent", "│ ") + pad(line, innerWidth) + theme.fg("borderAccent", " │")),
		bottom,
	].map((line) => fit(line, width));
}

type DloModal = {
	stream: DataStream;
	sql: string;
	running: boolean;
	copied: boolean;
	result?: QuerySqlResponse;
	error?: string;
};

class Data360StreamBrowser implements Component {
	private selected = 0;
	private scrollTop = 0;
	private modal: DloModal | undefined;
	private readonly pageSize = 14;

	constructor(
		private readonly org: string,
		private readonly streams: DataStream[],
		private readonly totalSize: number | undefined,
		private readonly theme: ThemeLike,
		private readonly runQuery: (sql: string) => Promise<QuerySqlResponse>,
		private readonly setEditorText: (text: string) => void,
		private readonly done: () => void,
		private readonly requestRender: () => void,
	) {}

	handleInput(data: string): void {
		if (this.modal) {
			this.handleModalInput(data);
			return;
		}

		if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c")) || data === "q") {
			this.done();
			return;
		}

		if (matchesKey(data, Key.up) || data === "k") {
			this.move(-1);
			return;
		}

		if (matchesKey(data, Key.down) || data === "j") {
			this.move(1);
			return;
		}

		if (matchesKey(data, Key.home)) {
			this.selected = 0;
			this.ensureVisible();
			this.requestRender();
			return;
		}

		if (matchesKey(data, Key.end)) {
			this.selected = Math.max(0, this.streams.length - 1);
			this.ensureVisible();
			this.requestRender();
			return;
		}

		if (matchesKey(data, Key.enter) || matchesKey(data, Key.right) || data === " ") {
			this.openDloBrowser();
			return;
		}
	}

	render(width: number): string[] {
		const w = Math.max(40, width);
		if (this.modal) return this.renderModal(w);

		const t = this.theme;
		const title = ` Data 360 Stream Browser · ${this.org} `;
		const count = `${this.streams.length}${this.totalSize && this.totalSize !== this.streams.length ? `/${this.totalSize}` : ""} streams`;
		const ruleWidth = Math.max(0, w - visibleWidth(title) - visibleWidth(count));
		const lines = [
			fit(t.fg("accent", t.bold(title)) + t.fg("border", "─".repeat(ruleWidth)) + t.fg("muted", count), w),
		];

		if (this.streams.length === 0) {
			lines.push(t.fg("warning", "No data streams found."));
			return lines.map((line) => fit(line, w));
		}

		if (w < 92) {
			lines.push(...this.renderList(w));
			lines.push(t.fg("border", "─".repeat(w)));
			lines.push(...this.renderDetail(w));
		} else {
			const leftWidth = Math.max(36, Math.min(52, Math.floor(w * 0.42)));
			const separator = t.fg("border", " │ ");
			const rightWidth = Math.max(30, w - leftWidth - visibleWidth(separator));
			const left = this.renderList(leftWidth);
			const right = this.renderDetail(rightWidth);
			const rows = Math.max(left.length, right.length);
			for (let i = 0; i < rows; i += 1) {
				lines.push(fit(pad(left[i] ?? "", leftWidth) + separator + fit(right[i] ?? "", rightWidth), w));
			}
		}

		lines.push(t.fg("border", "─".repeat(w)));
		lines.push(fit(t.fg("dim", "↑↓/jk navigate · enter/right open DLO SQL browser · home/end jump · q/esc close"), w));
		return lines.map((line) => fit(line, w));
	}

	invalidate(): void {
		// No render cache to clear. Theme invalidation is handled by fresh render output.
	}

	private move(delta: number): void {
		const next = Math.max(0, Math.min(this.streams.length - 1, this.selected + delta));
		if (next === this.selected) return;
		this.selected = next;
		this.ensureVisible();
		this.requestRender();
	}

	private ensureVisible(): void {
		if (this.selected < this.scrollTop) this.scrollTop = this.selected;
		if (this.selected >= this.scrollTop + this.pageSize) this.scrollTop = this.selected - this.pageSize + 1;
	}

	private currentStream(): DataStream | undefined {
		return this.streams[this.selected];
	}

	private openDloBrowser(): void {
		const stream = this.currentStream();
		const dloName = stream?.dataLakeObjectInfo?.name;
		if (!stream || !dloName) return;
		this.modal = { stream, sql: queryForDlo(dloName), running: false, copied: false };
		this.requestRender();
	}

	private handleModalInput(data: string): void {
		if (!this.modal) return;

		if (matchesKey(data, Key.escape) || data === "q" || data === "b" || matchesKey(data, Key.left)) {
			this.modal = undefined;
			this.requestRender();
			return;
		}

		if (data === "c") {
			this.setEditorText(this.modal.sql);
			this.modal.copied = true;
			this.requestRender();
			return;
		}

		if (data === "r" || matchesKey(data, Key.enter)) {
			void this.runModalQuery();
		}
	}

	private async runModalQuery(): Promise<void> {
		if (!this.modal || this.modal.running) return;
		this.modal.running = true;
		this.modal.error = undefined;
		this.requestRender();

		try {
			this.modal.result = await this.runQuery(this.modal.sql.replace(/\n/g, " "));
		} catch (error) {
			this.modal.error = error instanceof Error ? error.message : String(error);
		} finally {
			if (this.modal) this.modal.running = false;
			this.requestRender();
		}
	}

	private renderList(width: number): string[] {
		const t = this.theme;
		const lines = [t.fg("accent", t.bold("Streams"))];
		const end = Math.min(this.streams.length, this.scrollTop + this.pageSize);

		for (let i = this.scrollTop; i < end; i += 1) {
			const stream = this.streams[i];
			const selected = i === this.selected;
			const prefix = selected ? t.fg("accent", "› ") : "  ";
			const label = stream.label || stream.name;
			const marker = stream.dataLakeObjectInfo?.name ? t.fg("success", "◆") : t.fg("dim", "◇");
			const name = selected ? t.fg("accent", label) : label;
			lines.push(prefix + marker + " " + fit(name, width - 4));

			const dlo = stream.dataLakeObjectInfo?.name ?? "no DLO reported";
			const fieldCount = fieldsFor(stream).length;
			const meta = `${stream.status ?? "UNKNOWN"} · ${dlo}${fieldCount ? ` · ${fieldCount} fields` : ""}`;
			lines.push(`    ${t.fg("muted", fit(meta, width - 4))}`);
		}

		if (this.scrollTop > 0) lines.splice(1, 0, t.fg("dim", `  ↑ ${this.scrollTop} more`));
		if (end < this.streams.length) lines.push(t.fg("dim", `  ↓ ${this.streams.length - end} more`));
		return lines.map((line) => fit(line, width));
	}

	private renderDetail(width: number): string[] {
		const t = this.theme;
		const stream = this.currentStream();
		if (!stream) return [t.fg("warning", "No stream selected")];

		const fields = fieldsFor(stream);
		const dlo = stream.dataLakeObjectInfo;
		const lines: string[] = [];

		lines.push(t.fg("accent", t.bold("Selected Stream")));
		lines.push(`${t.fg("muted", "Label:")} ${stream.label || stream.name}`);
		lines.push(`${t.fg("muted", "API:")}   ${stream.name}`);
		lines.push(`${t.fg("muted", "Status:")} ${statusBadge(t, stream.status)}${stream.lastRunStatus ? ` · last run ${statusBadge(t, stream.lastRunStatus)}` : ""}`);
		if (stream.connectorInfo?.connectorType) lines.push(`${t.fg("muted", "Source:")} ${stream.connectorInfo.connectorType}`);
		if (typeof stream.totalRecords === "number") lines.push(`${t.fg("muted", "Rows:")}   ${stream.totalRecords.toLocaleString()}`);
		if (stream.lastRefreshDate) lines.push(`${t.fg("muted", "Refresh:")} ${stream.lastRefreshDate}`);

		lines.push("");
		lines.push(t.fg("accent", t.bold("Underlying DLO")) + " " + t.fg("dim", "(enter opens SQL browser)"));
		lines.push(`${t.fg("muted", "Name:")}     ${dlo?.name ?? "(not reported)"}`);
		lines.push(`${t.fg("muted", "Label:")}    ${dlo?.label ?? "(not reported)"}`);
		lines.push(`${t.fg("muted", "Category:")} ${dlo?.category ?? "(not reported)"}`);
		lines.push(`${t.fg("muted", "Fields:")}   ${fields.length}`);

		if (fields.length > 0) {
			lines.push("");
			lines.push(t.fg("accent", t.bold(`DLO Fields (${fields.length})`)));
			for (const field of fields.slice(0, 12)) {
				const pk = field.isPrimaryKey ? t.fg("success", " PK") : "";
				lines.push(`• ${field.name ?? field.label ?? "(unnamed)"} ${t.fg("muted", field.dataType ?? "")}${pk}`);
			}
			if (fields.length > 12) lines.push(t.fg("dim", `… ${fields.length - 12} more fields`));
		}

		return lines.map((line) => fit(line, width));
	}

	private renderModal(width: number): string[] {
		const t = this.theme;
		const modal = this.modal!;
		const stream = modal.stream;
		const dlo = stream.dataLakeObjectInfo;
		const fields = fieldsFor(stream);
		const lines: string[] = [];

		lines.push(t.fg("accent", t.bold("DLO SQL Browser")) + t.fg("dim", ` · ${this.org}`));
		lines.push(`${t.fg("muted", "Stream:")} ${stream.label || stream.name}`);
		lines.push(`${t.fg("muted", "DLO:")}    ${dlo?.name ?? "(none)"}${dlo?.label ? ` · ${dlo.label}` : ""}`);
		lines.push(`${t.fg("muted", "Fields:")} ${fields.length}${fields.length ? ` · ${fields.slice(0, 5).map((f) => f.name).filter(Boolean).join(", ")}${fields.length > 5 ? ", …" : ""}` : ""}`);
		lines.push("");
		lines.push(t.fg("accent", t.bold("Top 5 SQL")));
		for (const sqlLine of modal.sql.split("\n")) lines.push(t.fg("toolOutput", `  ${sqlLine}`));
		lines.push("");

		if (modal.copied) lines.push(t.fg("success", "Copied SQL into the editor."));
		if (modal.running) lines.push(t.fg("warning", "Running query via /ssot/query-sql…"));
		if (modal.error) {
			lines.push(t.fg("error", "Query failed"));
			lines.push(t.fg("dim", modal.error.replace(/\s+/g, " ")));
		}

		if (modal.result) {
			lines.push(...this.renderQueryResult(modal.result, Math.max(30, Math.min(width - 6, 104))));
		} else if (!modal.running && !modal.error) {
			lines.push(t.fg("dim", "Press r or enter to run the read-only top 5 query."));
		}

		lines.push("");
		lines.push(t.fg("dim", "r/enter run query · c copy SQL to editor · b/left/esc back · q close browser"));
		return renderBox(lines, width, t);
	}

	private renderQueryResult(result: QuerySqlResponse, width: number): string[] {
		const t = this.theme;
		const data = result.data ?? [];
		const metadata = result.metadata ?? [];
		const columnNames = metadata.length > 0 ? metadata.map((m, i) => m.name || `col_${i + 1}`) : data[0]?.map((_v, i) => `col_${i + 1}`) ?? [];
		const maxCols = Math.max(1, Math.min(columnNames.length, Math.floor(Math.max(24, width) / 16)));
		const cols = columnNames.slice(0, maxCols);
		const colWidth = Math.max(8, Math.floor((width - Math.max(0, cols.length - 1) * 3) / Math.max(1, cols.length)));
		const sep = t.fg("border", " │ ");
		const lines = ["", t.fg("accent", t.bold(`Rows (${result.returnedRows ?? data.length})`))];

		if (cols.length === 0) {
			lines.push(t.fg("muted", "Query returned no columns."));
			return lines;
		}

		lines.push(cols.map((col) => t.fg("accent", pad(col, colWidth))).join(sep));
		lines.push(t.fg("border", "─".repeat(Math.min(width, cols.length * colWidth + Math.max(0, cols.length - 1) * 3))));

		for (const row of data.slice(0, 5)) {
			lines.push(cols.map((_col, i) => pad(formatValue(row[i]), colWidth)).join(sep));
		}

		if (columnNames.length > maxCols) lines.push(t.fg("dim", `… ${columnNames.length - maxCols} more columns hidden`));
		if (data.length === 0) lines.push(t.fg("muted", "No rows returned."));
		return lines.map((line) => fit(line, width));
	}
}

function registerBrowserCommand(pi: ExtensionAPI, commandName: string) {
	pi.registerCommand(commandName, {
		description: "Browse Data 360 streams, DLOs, and top-5 SQL previews",
		getArgumentCompletions: (prefix: string) => {
			const options = [DEFAULT_ORG, "default"];
			const items = options.filter((value) => value.startsWith(prefix)).map((value) => ({ value, label: value }));
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify(`${commandName} requires interactive pi TUI mode`, "error");
				return;
			}

			const org = args.trim() && args.trim() !== "default" ? args.trim() : DEFAULT_ORG;

			const loaded = await ctx.ui.custom<LoadResult>((tui, theme, _keybindings, done) => {
				const loader = new BorderedLoader(tui, theme, `Loading Data 360 streams from ${org}…`);
				loader.onAbort = () => done(null);

				fetchStreams(pi, org, loader.signal)
					.then(({ streams, totalSize }) => done({ ok: true, streams, totalSize }))
					.catch((error) => done({ ok: false, error: error instanceof Error ? error.message : String(error) }));

				return loader;
			});

			if (loaded === null) {
				ctx.ui.notify("Data 360 stream browser cancelled", "info");
				return;
			}

			if (!loaded.ok) {
				ctx.ui.notify(`Could not load Data 360 streams: ${loaded.error}`, "error");
				return;
			}

			if (loaded.streams.length === 0) {
				ctx.ui.notify(`No Data 360 streams found in ${org}`, "warning");
				return;
			}

			await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
				const browser = new Data360StreamBrowser(
					org,
					loaded.streams,
					loaded.totalSize,
					theme,
					(sql) => sfPost<QuerySqlResponse>(pi, org, "/ssot/query-sql", { sql }),
					(text) => ctx.ui.setEditorText(text),
					() => done(),
					() => tui.requestRender(),
				);

				return browser;
			});
		},
	});
}

export default function data360StreamBrowser(pi: ExtensionAPI) {
	registerBrowserCommand(pi, "d360-streams");
	registerBrowserCommand(pi, "d360-stream-browser");
}
