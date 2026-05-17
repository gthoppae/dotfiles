import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { AutocompleteItem } from "@mariozechner/pi-tui";

const HEARTBEAT_URL = "https://results.eci.gov.in/ResultAcGenMay2026/election-json-S22-live.json";
const HEARTBEAT_MS = 5000;

type HeartbeatCtx = {
	hasUI: boolean;
	ui: {
		setStatus: (id: string, value: string | undefined) => void;
		setWidget: (id: string, value: string[] | undefined) => void;
		notify: (message: string, level?: "info" | "success" | "warning" | "error") => void;
	};
};

export default function (pi: ExtensionAPI) {
	let timer: ReturnType<typeof setInterval> | undefined;
	let beat = 0;
	let heartbeatMs = HEARTBEAT_MS;
	let lastCtx: HeartbeatCtx | undefined;

	const formatCounts = (counts: Record<string, number>) => {
		const parties = ["TVK", "ADMK", "DMK", "INC", "PMK", "BJP", "DMDK"];
		const first = parties.slice(0, 4).map((p) => `${p}: ${counts[p] ?? 0}`).join(", ");
		const second = parties.slice(4).map((p) => `${p}: ${counts[p] ?? 0}`).join(", ");
		return [first, second];
	};

	const formatInterval = (ms: number) => {
		if (ms % 60000 === 0) return `${ms / 60000}m`;
		if (ms % 1000 === 0) return `${ms / 1000}s`;
		return `${ms}ms`;
	};

	const parseInterval = (input: string): number | undefined => {
		const match = input.trim().toLowerCase().match(/^(?:(?:duration|interval|every|set)\s+)?(\d+)(ms|s|m)?$/);
		if (!match) return undefined;
		const value = Number(match[1]);
		const unit = match[2] ?? "s";
		if (unit === "ms") return value;
		if (unit === "m") return value * 60000;
		return value * 1000;
	};

	const makeWidget = (counts: Record<string, number>, rows: number, beatCount: number, ms: number, intervalMs: number) => {
		const [first, second] = formatCounts(counts);
		const meta = `beat ${beatCount} · every ${formatInterval(intervalMs)} · ${rows} rows · ${ms}ms`;
		return [first, second, meta];
	};

	async function ping(ctx: HeartbeatCtx, announce = false) {
		const started = Date.now();
		try {
			const response = await fetch(HEARTBEAT_URL, { cache: "no-store" });
			if (!response.ok) throw new Error(`HTTP ${response.status}`);

			const payload = (await response.json()) as { S22?: { tableData?: Array<[string, string, number]> } };
			const rows = payload.S22?.tableData?.length ?? 0;
			const counts: Record<string, number> = {};
			for (const row of payload.S22?.tableData ?? []) {
				counts[row[0]] = (counts[row[0]] ?? 0) + 1;
			}
			beat += 1;
			const lines = makeWidget(counts, rows, beat, Date.now() - started, heartbeatMs);
			ctx.ui.setWidget("heartbeat", lines);
			ctx.ui.setStatus("heartbeat", undefined);
			if (announce) ctx.ui.notify(`Heartbeat updated (${rows} rows)`, "success");
			return lines;
		} catch (error) {
			beat += 1;
			const message = error instanceof Error ? error.message : String(error);
			ctx.ui.setStatus("heartbeat", `💔 ${beat} | ${message}`);
			ctx.ui.setWidget("heartbeat", [`Heartbeat failed`, message]);
			if (announce) ctx.ui.notify(`Heartbeat failed: ${message}`, "error");
			return [`failed: ${message}`];
		}
	}

	function startHeartbeat(ctx: HeartbeatCtx) {
		lastCtx = ctx;
		if (timer) clearInterval(timer);
		beat = 0;
		void ping(ctx, false);
		timer = setInterval(() => {
			if (lastCtx) void ping(lastCtx, false);
		}, heartbeatMs);
	}

	function stopHeartbeat(ctx: HeartbeatCtx) {
		if (timer) clearInterval(timer);
		timer = undefined;
		ctx.ui.setStatus("heartbeat", undefined);
		ctx.ui.setWidget("heartbeat", undefined);
	}

	pi.registerCommand("heartbeat", {
		description: "Ping the ECI JSON endpoint or control the heartbeat",
		getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
			const options = ["ping", "on", "off", "status", "interval 10s", "duration 30s"];
			const items = options
				.filter((option) => option.startsWith(prefix))
				.map((value) => ({ value, label: value }));
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			lastCtx = ctx;
			const command = args.trim().toLowerCase();
			const interval = parseInterval(command);

			if (interval) {
				heartbeatMs = interval;
				if (timer) startHeartbeat(ctx);
				ctx.ui.notify(`Heartbeat interval set to ${formatInterval(heartbeatMs)}`, "info");
				return;
			}

			if (command === "on" || command === "start") {
				startHeartbeat(ctx);
				ctx.ui.notify("Heartbeat started", "info");
				return;
			}

			if (command === "off" || command === "stop") {
				stopHeartbeat(ctx);
				ctx.ui.notify("Heartbeat stopped", "info");
				return;
			}

			if (command === "status") {
				ctx.ui.notify(timer ? `Heartbeat running (${beat}) every ${formatInterval(heartbeatMs)}` : "Heartbeat stopped", "info");
				return;
			}

			await ping(ctx, true);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		lastCtx = ctx;
		ctx.ui.setStatus("heartbeat", undefined);
		ctx.ui.setWidget("heartbeat", undefined);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		if (timer) clearInterval(timer);
		timer = undefined;
		if (ctx.hasUI) ctx.ui.setStatus("heartbeat", undefined);
	});
}
