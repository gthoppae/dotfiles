/**
 * html-slide-shot — take screenshots of HTML slide decks (or any HTML page) via Playwright.
 *
 * Tool: html_slide_shot
 *   - Opens a local HTML file or URL in headless Chromium
 *   - Optionally navigates through a reveal.js/custom deck by pressing ArrowRight
 *   - Screenshots the requested slide(s) to disk
 *
 * Uses the `playwright` npm dep bundled with this extension. Tries to reuse an already-installed
 * Chromium from `~/Library/Caches/ms-playwright/` (macOS) before falling back to Playwright's own.
 */

import { Type } from "@mariozechner/pi-ai";
import { defineTool, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { chromium, type Browser, type BrowserContext } from "playwright";
import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/** Find a locally-installed Chrome-for-Testing to reuse, falling back to Playwright's bundled Chromium. */
function findChromiumExecutable(): string | undefined {
	const cacheRoot = path.join(homedir(), "Library", "Caches", "ms-playwright");
	if (!existsSync(cacheRoot)) return undefined;
	let best: { ver: number; exe: string } | undefined;
	for (const name of readdirSync(cacheRoot)) {
		const m = name.match(/^chromium-(\d+)$/);
		if (!m) continue;
		const ver = parseInt(m[1], 10);
		const macExe = path.join(
			cacheRoot,
			name,
			"chrome-mac-x64",
			"Google Chrome for Testing.app",
			"Contents",
			"MacOS",
			"Google Chrome for Testing",
		);
		const linuxExe = path.join(cacheRoot, name, "chrome-linux", "chrome");
		const exe = existsSync(macExe) ? macExe : existsSync(linuxExe) ? linuxExe : undefined;
		if (!exe) continue;
		if (!best || ver > best.ver) best = { ver, exe };
	}
	return best?.exe;
}

function toFileUrl(p: string): string {
	if (/^https?:\/\//.test(p) || p.startsWith("file://")) return p;
	return "file://" + path.resolve(p);
}

function ensureDir(p: string) {
	const d = path.dirname(p);
	if (d && !existsSync(d)) mkdirSync(d, { recursive: true });
}

interface ShotSpec {
	slide: number; // 1-based
	output: string;
}

function resolveSpecs(
	slides: unknown,
	output: string,
): ShotSpec[] {
	// slides: number | number[] | "all"
	// When "all", output must be a directory (or pattern with {i})
	const outIsDirPattern = output.includes("{i}");

	const ensureOutForIndex = (i: number): string => {
		if (outIsDirPattern) return output.replace(/\{i\}/g, String(i));
		// If output exists and is a directory, use it
		const asDir =
			existsSync(output) && statSync(output).isDirectory() ? output : undefined;
		if (asDir) return path.join(asDir, `slide-${String(i).padStart(2, "0")}.png`);
		return output; // assume caller knows it's a single-slide shot
	};

	if (slides === "all") {
		return [];
	}
	if (typeof slides === "number") {
		return [{ slide: slides, output: ensureOutForIndex(slides) }];
	}
	if (Array.isArray(slides)) {
		return slides.map((s) => ({ slide: s as number, output: ensureOutForIndex(s as number) }));
	}
	return [{ slide: 1, output }];
}

const ANIM_KILL_CSS = `
	*, *::before, *::after {
		animation-duration: 0ms !important;
		animation-delay: 0ms !important;
		transition-duration: 0ms !important;
		transition-delay: 0ms !important;
	}
	.ai { opacity: 1 !important; transform: none !important; }
`;

async function installAnimKiller(context: BrowserContext) {
	await context.addInitScript((css: string) => {
		const apply = () => {
			const s = document.createElement("style");
			s.setAttribute("data-html-slide-shot", "anim-killer");
			s.textContent = css;
			document.documentElement.appendChild(s);
		};
		if (document.documentElement) apply();
		else document.addEventListener("DOMContentLoaded", apply);
	}, ANIM_KILL_CSS);
}

async function applyTheme(page: import("playwright").Page, theme: "light" | "dark") {
	await page.evaluate((t: string) => {
		document.documentElement.dataset.theme = t;
		document.body.dataset.theme = t;
		(document.documentElement.style as CSSStyleDeclaration).colorScheme = t;
	}, theme);
}

async function countSlides(page: import("playwright").Page, selector: string): Promise<number> {
	return await page.evaluate((sel: string) => document.querySelectorAll(sel).length, selector);
}

async function gotoSlide(
	page: import("playwright").Page,
	index: number, // 1-based
	selector: string,
) {
	// Generic approach: press Home, then ArrowRight (index-1) times.
	// Works for reveal.js, custom keydown handlers, and most slide decks.
	await page.keyboard.press("Home").catch(() => {});
	// For decks without Home support, manually goTo 0 via JS when possible.
	await page.evaluate(
		({ sel }: { sel: string }) => {
			const slides = document.querySelectorAll(sel);
			if (!slides.length) return;
			slides.forEach((s) => s.classList.remove("active", "exit-up"));
			slides[0].classList.add("active");
			const progress = document.getElementById("progress");
			const ctr = document.querySelector(".ctr");
			const sec = document.querySelector(".sec");
			if (progress) (progress as HTMLElement).style.width = (1 / slides.length) * 100 + "%";
			if (ctr) ctr.textContent = `1 / ${slides.length}`;
			if (sec) sec.textContent = (slides[0] as HTMLElement).dataset.section || "";
			(window as unknown as { __hss_current?: number }).__hss_current = 0;
		},
		{ sel: selector },
	);
	// Advance by pressing ArrowRight
	for (let i = 1; i < index; i++) {
		await page.keyboard.press("ArrowRight");
		await page.waitForTimeout(40);
	}
	await page.waitForTimeout(200);
}

async function readSlideMeta(
	page: import("playwright").Page,
	selector: string,
): Promise<{ index: number; total: number; section?: string; active: boolean }> {
	return await page.evaluate((sel: string) => {
		const slides = Array.from(document.querySelectorAll(sel));
		const i = slides.findIndex((s) => s.classList.contains("active"));
		const s = slides[i] as HTMLElement | undefined;
		return {
			index: i + 1,
			total: slides.length,
			section: s?.dataset.section,
			active: i >= 0,
		};
	}, selector);
}

const slideShotTool = defineTool({
	name: "html_slide_shot",
	label: "HTML Slide Shot",
	description:
		"Screenshot a local HTML file (or URL) via headless Chromium. Useful for slide decks (navigates via ArrowRight) or any HTML page. Supports single slide, list of slides, or 'all'. Kills animations and supports light/dark theme override.",
	promptSnippet:
		"Screenshot HTML pages / slide decks headlessly (navigates slides via ArrowRight, kills animations, outputs PNGs).",
	parameters: Type.Object({
		path: Type.String({
			description:
				"Local HTML file path (absolute or relative to cwd) or http(s) URL.",
		}),
		slide: Type.Optional(
			Type.Union(
				[
					Type.Number({ description: "1-based slide index" }),
					Type.Array(Type.Number()),
					Type.Literal("all"),
				],
				{
					description:
						"Slide to screenshot. 1-based index, array of indices, or 'all'. Omit for a single shot of the current page (no navigation).",
				},
			),
		),
		output: Type.String({
			description:
				"Output PNG path. For multiple slides, use a directory, or a pattern with '{i}' placeholder (e.g. '/tmp/slide-{i}.png').",
		}),
		viewport: Type.Optional(
			Type.Object({
				width: Type.Number(),
				height: Type.Number(),
			}),
		),
		theme: Type.Optional(
			Type.Union([Type.Literal("light"), Type.Literal("dark")], {
				description:
					"Force theme by setting html/body data-theme and style.colorScheme.",
			}),
		),
		selector: Type.Optional(
			Type.String({
				description:
					"CSS selector for slide elements. Default '.slide'. Used for counting and navigation.",
			}),
		),
		disableAnimations: Type.Optional(Type.Boolean()),
		fullPage: Type.Optional(
			Type.Boolean({
				description: "Capture the full scrollable page instead of the viewport.",
			}),
		),
		waitMs: Type.Optional(
			Type.Number({ description: "Extra wait after load/navigation, in ms. Default 400." }),
		),
	}),

	async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
		const viewport = params.viewport ?? { width: 1600, height: 1000 };
		const selector = params.selector ?? ".slide";
		const disableAnim = params.disableAnimations ?? true;
		const waitMs = params.waitMs ?? 400;

		const executablePath = findChromiumExecutable();
		let browser: Browser | undefined;
		try {
			browser = await chromium.launch({
				executablePath,
				headless: true,
			});
		} catch (e) {
			// Retry with bundled
			if (executablePath) {
				browser = await chromium.launch({ headless: true });
			} else {
				throw e;
			}
		}

		const context = await browser.newContext({ viewport, deviceScaleFactor: 1 });
		if (disableAnim) await installAnimKiller(context);

		const url = toFileUrl(params.path);
		const page = await context.newPage();
		if (signal?.aborted) throw new Error("aborted");
		await page.goto(url, { waitUntil: "networkidle" });
		await page.waitForTimeout(waitMs);

		if (params.theme) await applyTheme(page, params.theme);

		// Resolve specs. If 'all', discover slide count now.
		let specs: ShotSpec[];
		const total = await countSlides(page, selector);
		if (params.slide === "all") {
			const pattern = params.output.includes("{i}")
				? params.output
				: (existsSync(params.output) && statSync(params.output).isDirectory())
					? path.join(params.output, "slide-{i}.png")
					: (() => {
							// Treat as directory even if it doesn't exist yet
							mkdirSync(params.output, { recursive: true });
							return path.join(params.output, "slide-{i}.png");
						})();
			specs = Array.from({ length: total }, (_, k) => ({
				slide: k + 1,
				output: pattern.replace(/\{i\}/g, String(k + 1).padStart(2, "0")),
			}));
		} else {
			specs = resolveSpecs(params.slide, params.output);
		}

		const results: Array<{ slide?: number; section?: string; output: string; bytes: number }> = [];

		if (specs.length === 0) {
			// No slide navigation — just screenshot the current page.
			ensureDir(params.output);
			await page.screenshot({
				path: params.output,
				fullPage: params.fullPage ?? false,
			});
			const st = statSync(params.output);
			results.push({ output: params.output, bytes: st.size });
		} else {
			for (const spec of specs) {
				if (signal?.aborted) break;
				await gotoSlide(page, spec.slide, selector);
				await page.waitForTimeout(Math.min(waitMs, 400));
				const meta = await readSlideMeta(page, selector);
				ensureDir(spec.output);
				await page.screenshot({
					path: spec.output,
					fullPage: params.fullPage ?? false,
				});
				const st = statSync(spec.output);
				results.push({
					slide: meta.index || spec.slide,
					section: meta.section,
					output: spec.output,
					bytes: st.size,
				});
			}
		}

		await context.close();
		await browser.close();

		const lines = [
			`Screenshot(s) written (${results.length}):`,
			...results.map((r) =>
				r.slide !== undefined
					? `  slide ${r.slide}${r.section ? ` · ${r.section}` : ""} → ${r.output} (${r.bytes} bytes)`
					: `  ${r.output} (${r.bytes} bytes)`,
			),
			`Total slides in deck: ${total}`,
			executablePath ? `Chromium: ${executablePath}` : "Chromium: bundled",
		];

		return {
			content: [{ type: "text", text: lines.join("\n") }],
			details: {
				url,
				executablePath: executablePath ?? "bundled",
				totalSlides: total,
				results,
			},
		};
	},
});

export default function (pi: ExtensionAPI) {
	pi.registerTool(slideShotTool);
}
