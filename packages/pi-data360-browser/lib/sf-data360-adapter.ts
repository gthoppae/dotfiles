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
 * sf-pi is a required runtime dependency. This adapter intentionally does not
 * fall back to shelling out to `sf`; the browser package is only the TUI layer.
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
	{ mode: "sf-data360"; sfPiPath: string; sourceCommit?: string };

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
	detectEnvironment: (
		exec: (command: string, args: string[], options?: { timeout?: number; cwd?: string }) => Promise<{ stdout: string; stderr: string; code: number | null }>,
		cwd: string,
	) => Promise<unknown>;
	clearConnectionCache: () => void;
}

let cachedTransport: Promise<Sfd360Transport> | null = null;
const envCache = new Map<string, unknown>();

/**
 * Resolve a sf-pi installation directory, in order of preference:
 *   1. SF_DATA360_BROWSER_SFPI_PATH env override (escape hatch for devs)
 *   2. The known git-package install path: ~/.pi/agent/git/github.com/salesforce/sf-pi
 *   3. ./node_modules/sf-pi if the workspace happened to install it as an npm dep
 * Returns absolute path, or throws when no candidate exists.
 */
async function resolveSfPiPath(): Promise<string> {
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
	throw new Error(
		"pi-data360-browser requires sf-pi. Install it with: pi install git:github.com/salesforce/sf-pi, or set SF_DATA360_BROWSER_SFPI_PATH.",
	);
}

async function tryLoadModules(sfPiPath: string): Promise<SfData360Modules> {
	const url = (rel: string): string => `file://${path.join(sfPiPath, rel)}`;
	// Dynamic imports — keep this in sf-pi's module root so its own node_modules
	// (@salesforce/core, jsforce, etc.) resolve correctly when Node walks up
	// from the imported file's directory.
	const [conn, req, p, t, env] = await Promise.all([
		import(url("lib/common/sf-conn/connection.ts")),
		import(url("lib/common/sf-conn/request.ts")),
		import(url("extensions/sf-data360/lib/path.ts")),
		import(url("extensions/sf-data360/lib/target-org.ts")),
		import(url("lib/common/sf-environment/detect.ts")),
	]);
	return {
		connFromAlias: conn.connFromAlias,
		connRequest: req.connRequest,
		buildApiPath: p.buildApiPath,
		resolveApiVersion: t.resolveApiVersion,
		resolveExplicitTargetOrg: t.resolveExplicitTargetOrg,
		normalizeTargetOrg: t.normalizeTargetOrg,
		detectEnvironment: env.detectEnvironment,
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

function connectionApiVersion(conn: unknown): string | undefined {
	try {
		const getApiVersion = (conn as { getApiVersion?: () => string | undefined })?.getApiVersion;
		const version = typeof getApiVersion === "function" ? getApiVersion.call(conn) : undefined;
		return version || undefined;
	} catch {
		return undefined;
	}
}

function missingApiVersionMessage(targetOrg: string | undefined): string {
	const orgLabel = targetOrg ? `target org ${targetOrg}` : "the default target org";
	return `No Salesforce API version available for ${orgLabel}. Verify auth with \`sf org display --target-org <alias> --json\`, pass an explicit alias to /d360-query-explorer, set a Salesforce CLI default org, or set SF_DATA360_BROWSER_DEFAULT_ORG=<alias>.`;
}

/**
 * Initialize the sf-data360 transport. Lazy and memoized.
 *
 * Failure to discover or load sf-pi is fatal. This package intentionally uses
 * sf-pi as the only Data 360 conduit.
 */
export function getSfData360Transport(pi: ExtensionAPI): Promise<Sfd360Transport> {
	if (!cachedTransport) cachedTransport = initialize(pi);
	return cachedTransport;
}

async function initialize(pi: ExtensionAPI): Promise<Sfd360Transport> {
	const sfPiPath = await resolveSfPiPath();
	const modules = await tryLoadModules(sfPiPath);
	const sourceCommit = await tryReadCommit(sfPiPath);
	const cwd = process.cwd();
	const exec = async (command: string, args: string[], options?: { timeout?: number; cwd?: string }) => {
		const result = await pi.exec(command, args, { timeout: options?.timeout, cwd: options?.cwd ?? cwd });
		return { stdout: result.stdout, stderr: result.stderr, code: result.code };
	};
	const loadEnv = async (): Promise<unknown> => {
		const cached = envCache.get(cwd);
		if (cached) return cached;
		const env = await modules.detectEnvironment(exec, cwd);
		envCache.set(cwd, env);
		return env;
	};
	// Warm the env so the first call doesn't pay the discovery cost mid-render.
	const envPromise = loadEnv().catch(() => null);

	const call: SfApiCall = async <T>(
		_pi: ExtensionAPI,
		org: string,
		method: Method,
		apiPath: string,
		body?: Json,
		signal?: AbortSignal,
	): Promise<T> => {
		if (signal?.aborted) throw new Error("sf-data360 call cancelled before request.");
		const env = (await envPromise) ?? (await loadEnv());
		const requestedOrg = org && org !== "default" ? org : undefined;
		const targetOrg = modules.normalizeTargetOrg(requestedOrg, env) ?? requestedOrg;
		const conn = await modules.connFromAlias(targetOrg);
		const targetOrgInfo = targetOrg ? await modules.resolveExplicitTargetOrg(targetOrg, env).catch(() => undefined) : undefined;
		const apiVersion = (() => {
			try {
				return modules.resolveApiVersion(env, targetOrgInfo);
			} catch {
				const fromConnection = connectionApiVersion(conn);
				if (fromConnection) return fromConnection;
				throw new Error(missingApiVersionMessage(targetOrg));
			}
		})();
		const url = modules.buildApiPath(apiPath, apiVersion);
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

/** One-line label for the TUI footer / status bar. */
export function transportLabel(info: TransportInfo): string {
	return info.sourceCommit
		? `transport: sf-data360 @ ${info.sourceCommit}`
		: "transport: sf-data360";
}
