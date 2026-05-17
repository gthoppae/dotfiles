/* SPDX-License-Identifier: Apache-2.0 */
/**
 * sf-data360 adapter for the data360-browser TUI extension.
 *
 * The /d360-* explorers were originally a self-contained extension that shelled
 * out to `sf api request rest` for every Data 360 REST call. This adapter
 * replaces that thin transport with the actual primitives published by the
 * sf-data360 extension shipped in the sf-pi pi-package
 * (https://github.com/salesforce/sf-pi). The TUI becomes a showcase of how
 * sf-data360's lib/* surface (cached @salesforce/core Connection, path
 * builder, target-org/api-version resolution) is reusable beyond the
 * LLM-callable d360_api tool.
 *
 * Discovery is best-effort: if sf-pi is not installed the adapter reports
 * mode="cli-fallback" and the explorer keeps working via the legacy
 * `sf api request rest` path. The footer pill in the explorer reflects which
 * transport was active.
 */

import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export type Method = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
export type Json = unknown;

export type SfApiCall = <T = Json>(
	pi: ExtensionAPI,
	org: string,
	method: Method,
	apiPath: string,
	body?: Json,
	signal?: AbortSignal,
) => Promise<T>;

export type TransportInfo =
	| { mode: "sf-data360"; sfPiPath: string; sourceCommit?: string }
	| { mode: "cli-fallback"; reason: string; sfPiPath?: string };

export interface Sfd360Transport {
	call: SfApiCall;
	info: TransportInfo;
}

interface SfData360Modules {
	connFromAlias: (alias?: string) => Promise<unknown>;
	connRequest: <T>(
		conn: unknown,
		opts: { method: Method; url: string; body?: unknown; timeoutMs?: number; headers?: Record<string, string> },
	) => Promise<{ status: number; body: T; headers?: Record<string, string> }>;
	buildApiPath: (path: string, apiVersion: string, query?: Record<string, unknown>) => string;
	resolveApiVersion: (env: unknown, targetOrgInfo?: unknown) => string;
	resolveExplicitTargetOrg: (targetOrg: string | undefined, env: unknown) => Promise<unknown>;
	normalizeTargetOrg: (targetOrg: string | undefined, env: unknown) => string | undefined;
	getCachedSfEnvironment: (cwd: string) => unknown;
	getSharedSfEnvironment: (exec: unknown, cwd: string) => Promise<unknown>;
	buildExecFn: (pi: ExtensionAPI, defaultCwd?: string) => unknown;
	clearConnectionCache: () => void;
}

let cachedTransport: Promise<Sfd360Transport> | null = null;

/**
 * Resolve a sf-pi installation directory, in order of preference:
 *   1. SF_DATA360_BROWSER_SFPI_PATH env override (escape hatch for devs)
 *   2. The known git-package install path: ~/.pi/agent/git/github.com/salesforce/sf-pi
 *   3. ./node_modules/sf-pi if the workspace happened to install it as an npm dep
 * Returns absolute path, or undefined when no candidate exists.
 */
async function resolveSfPiPath(): Promise<string | undefined> {
	const candidates: string[] = [];
	if (process.env.SF_DATA360_BROWSER_SFPI_PATH) {
		candidates.push(process.env.SF_DATA360_BROWSER_SFPI_PATH);
	}
	candidates.push(path.join(os.homedir(), ".pi/agent/git/github.com/salesforce/sf-pi"));
	candidates.push(path.join(process.cwd(), "node_modules/sf-pi"));
	for (const candidate of candidates) {
		try {
			const stat = await fs.stat(path.join(candidate, "extensions/sf-data360/lib/api-tool.ts"));
			if (stat.isFile()) return candidate;
		} catch {
			// keep walking
		}
	}
	return undefined;
}

async function tryLoadModules(sfPiPath: string): Promise<SfData360Modules> {
	const url = (rel: string): string => `file://${path.join(sfPiPath, rel)}`;
	// Dynamic imports — keep this in sf-pi's module root so its own node_modules
	// (@salesforce/core, jsforce, etc.) resolve correctly when Node walks up
	// from the imported file's directory.
	const [conn, req, p, t, env, exec] = await Promise.all([
		import(url("lib/common/sf-conn/connection.ts")),
		import(url("lib/common/sf-conn/request.ts")),
		import(url("extensions/sf-data360/lib/path.ts")),
		import(url("extensions/sf-data360/lib/target-org.ts")),
		import(url("lib/common/sf-environment/shared-runtime.ts")),
		import(url("lib/common/exec-adapter.ts")),
	]);
	return {
		connFromAlias: conn.connFromAlias,
		connRequest: req.connRequest,
		buildApiPath: p.buildApiPath,
		resolveApiVersion: t.resolveApiVersion,
		resolveExplicitTargetOrg: t.resolveExplicitTargetOrg,
		normalizeTargetOrg: t.normalizeTargetOrg,
		getCachedSfEnvironment: env.getCachedSfEnvironment,
		getSharedSfEnvironment: env.getSharedSfEnvironment,
		buildExecFn: exec.buildExecFn,
		clearConnectionCache: conn.clearConnectionCache,
	};
}

async function tryReadCommit(sfPiPath: string): Promise<string | undefined> {
	try {
		const head = (await fs.readFile(path.join(sfPiPath, ".git", "HEAD"), "utf8")).trim();
		if (head.startsWith("ref:")) {
			const refPath = head.slice(4).trim();
			const sha = (await fs.readFile(path.join(sfPiPath, ".git", refPath), "utf8")).trim();
			return sha.slice(0, 7);
		}
		return head.slice(0, 7);
	} catch {
		return undefined;
	}
}

/**
 * Initialize the sf-data360 transport. Lazy and memoized.
 *
 * Failure to discover or load sf-pi is non-fatal: the returned transport
 * uses the CLI shell-out fallback, and `info.mode === "cli-fallback"`
 * surfaces the reason to the TUI footer.
 */
export function getSfData360Transport(pi: ExtensionAPI): Promise<Sfd360Transport> {
	if (!cachedTransport) cachedTransport = initialize(pi);
	return cachedTransport;
}

async function initialize(pi: ExtensionAPI): Promise<Sfd360Transport> {
	const sfPiPath = await resolveSfPiPath();
	if (!sfPiPath) {
		return makeCliFallback(
			"sf-pi pi-package not installed at ~/.pi/agent/git/github.com/salesforce/sf-pi (install with: pi install git:github.com/salesforce/sf-pi)",
		);
	}
	let modules: SfData360Modules;
	try {
		modules = await tryLoadModules(sfPiPath);
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		return makeCliFallback(`sf-pi present at ${sfPiPath} but module load failed: ${reason}`, sfPiPath);
	}
	const sourceCommit = await tryReadCommit(sfPiPath);
	const cwd = process.cwd();
	// Warm the env so the first call doesn't pay the discovery cost mid-render.
	const exec = modules.buildExecFn(pi);
	const envPromise = (async () => {
		try {
			return modules.getCachedSfEnvironment(cwd) ?? (await modules.getSharedSfEnvironment(exec, cwd));
		} catch {
			return null;
		}
	})();

	const call: SfApiCall = async <T>(
		_pi: ExtensionAPI,
		org: string,
		method: Method,
		apiPath: string,
		body?: Json,
		signal?: AbortSignal,
	): Promise<T> => {
		if (signal?.aborted) throw new Error("sf-data360 call cancelled before request.");
		const env = (await envPromise) ?? modules.getCachedSfEnvironment(cwd) ?? (await modules.getSharedSfEnvironment(exec, cwd));
		const targetOrg = modules.normalizeTargetOrg(org && org !== "default" ? org : undefined, env);
		const targetOrgInfo = await modules.resolveExplicitTargetOrg(targetOrg, env);
		const apiVersion = modules.resolveApiVersion(env, targetOrgInfo);
		const url = modules.buildApiPath(apiPath, apiVersion);
		const conn = await modules.connFromAlias(targetOrg);
		const reqBody =
			method === "GET" || method === "DELETE" ? undefined : body;
		const resp = await modules.connRequest<T>(conn, {
			method,
			url,
			body: reqBody,
			timeoutMs: 120_000,
		});
		if (resp.status >= 400) {
			const text = typeof resp.body === "string" ? resp.body : JSON.stringify(resp.body);
			throw new Error(`sf-data360 ${method} ${url} failed: ${resp.status} ${text}`);
		}
		return resp.body as T;
	};

	return {
		call,
		info: { mode: "sf-data360", sfPiPath, sourceCommit },
	};
}

function makeCliFallback(reason: string, sfPiPath?: string): Sfd360Transport {
	// Fallback transport — caller should not invoke `call`; the legacy
	// `sfApi()` shell-out path takes over. `call` here is a sentinel that
	// throws so a misconfigured caller fails loudly.
	return {
		call: async () => {
			throw new Error(
				`sf-data360 transport unavailable (${reason}). The /d360-* explorers fall back to the sf CLI shell-out path automatically; if you saw this, the caller forgot to check info.mode.`,
			);
		},
		info: { mode: "cli-fallback", reason, sfPiPath },
	};
}

/** One-line label for the TUI footer / status bar. */
export function transportLabel(info: TransportInfo): string {
	if (info.mode === "sf-data360") {
		return info.sourceCommit
			? `transport: sf-data360 @ ${info.sourceCommit}`
			: "transport: sf-data360";
	}
	return "transport: cli-fallback";
}
