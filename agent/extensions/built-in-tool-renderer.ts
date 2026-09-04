/**
 * Compact renderers for Pi tools.
 *
 * Execution always delegates to Pi's official tools. This extension only owns
 * presentation: one shared compact adapter for extension tools, concise built-in
 * status rows, bounded previews, and readable edit diffs.
 */

import type {
	BashToolDetails,
	EditToolDetails,
	ExtensionAPI,
	FindToolDetails,
	GrepToolDetails,
	LsToolDetails,
	ReadToolDetails,
} from "@earendil-works/pi-coding-agent";
import {
	AssistantMessageComponent,
	createBashTool,
	createEditTool,
	createFindTool,
	createGrepTool,
	createLsTool,
	createReadTool,
	createWriteTool,
	ToolExecutionComponent,
} from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { isAbsolute, relative, sep } from "node:path";

const COLLAPSED_PREVIEW_LINES = 8;
const EXPANDED_PREVIEW_LINES = 40;
const COMMAND_PREVIEW_LENGTH = 120;
const OWN_TOOL_RENDERERS = new Set(["read", "bash", "edit", "write", "grep", "find", "ls", "Agent"]);
const NON_GROUPABLE_TOOLS = new Set(["edit", "write", "apply_patch"]);
const GROUP_PARENT = Symbol("compact-tool-group-parent");
const GROUP_PATCH = Symbol.for("wen.pi.compact-tool-grouping");
const TOOL_RENDER_PATCH = Symbol.for("wen.pi.compact-tool-rendering");
const GENERIC_RENDERER = Symbol("compact-generic-tool-renderer");

let currentTheme: Theme | undefined;

type ToolBackground = (text: string) => string;
type CompactRenderContext = {
	args?: unknown;
	isError?: boolean;
	state: {
		callComponent?: Text;
		callText?: string;
		startedAt?: number;
		writeContent?: string;
	};
};
type Theme = {
	bg(name: string, text: string): string;
	bold(text: string): string;
	fg(name: string, text: string): string;
};

type GroupingPatch = {
	active: boolean;
	groups: Set<CompactToolGroup>;
	original: {
		addChild: (this: Container, component: unknown) => unknown;
		clear: (this: Container) => unknown;
		removeChild: (this: Container, component: unknown) => unknown;
	};
	installed: {
		addChild: (this: Container, component: unknown) => unknown;
		clear: (this: Container) => unknown;
		removeChild: (this: Container, component: unknown) => unknown;
	};
	shutdown(): void;
};

type ToolRenderMethods = {
	getCallRenderer: (this: ToolExecutionComponent) => unknown;
	getRenderShell: (this: ToolExecutionComponent) => "default" | "self";
	getResultRenderer: (this: ToolExecutionComponent) => unknown;
};

type ToolRenderingPatch = {
	active: boolean;
	installed: ToolRenderMethods;
	original: ToolRenderMethods;
	shutdown(): void;
};

function componentToolName(component: unknown): string {
	return String((component as { toolName?: string })?.toolName ?? "tool");
}

function componentStatus(component: unknown): "pending" | "success" | "error" {
	const tool = component as {
		executionStarted?: boolean;
		isPartial?: boolean;
		result?: { isError?: boolean };
	};
	if (tool.result?.isError) return "error";
	if (tool.isPartial || (tool.executionStarted && !tool.result)) return "pending";
	return tool.result ? "success" : "pending";
}

function isGroupableTool(component: unknown): component is ToolExecutionComponent {
	return component instanceof ToolExecutionComponent && !NON_GROUPABLE_TOOLS.has(componentToolName(component));
}

function isIgnorableSibling(component: unknown): boolean {
	if (component instanceof Spacer) return true;
	if (!(component instanceof AssistantMessageComponent)) return false;
	const children = (component as unknown as { contentContainer?: { children?: unknown[] } }).contentContainer?.children;
	return Array.isArray(children) && children.length === 0;
}

function previousMeaningfulSibling(children: unknown[], start: number): { child: unknown; index: number } | undefined {
	let skipped = 0;
	for (let index = start; index >= 0; index--) {
		const child = children[index];
		if (isIgnorableSibling(child) && skipped < 3) {
			skipped++;
			continue;
		}
		return { child, index };
	}
	return undefined;
}

function visibleRenderedLines(component: { render(width: number): string[] }, width: number): string[] {
	return component.render(width).filter((line) => line.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").trim());
}

function groupedToolSummary(component: ToolExecutionComponent): string {
	const runtime = component as unknown as {
		args?: unknown;
		builtInToolDefinition?: { label?: string };
		toolDefinition?: { label?: string };
	};
	const name = componentToolName(component);
	const label = runtime.toolDefinition?.label || runtime.builtInToolDefinition?.label || humanizeToolName(name);
	const detail = genericArgumentSummary(runtime.args, process.cwd());
	return detail ? `${label} ${detail}` : label;
}

// The container lifecycle follows pi-cc-extensions' MIT-licensed grouping design,
// adapted here to keep Pi 0.85's official tool execution and native Ctrl+O state.
class CompactToolGroup extends Container {
	declare children: ToolExecutionComponent[];
	readonly toolName = "compact-tool-group";
	private expanded = false;

	constructor(private readonly patch: GroupingPatch) {
		super();
		patch.groups.add(this);
	}

	addTool(tool: ToolExecutionComponent): void {
		this.children.push(tool);
		(tool as unknown as Record<symbol, unknown>)[GROUP_PARENT] = this;
	}

	releaseTools(): ToolExecutionComponent[] {
		const tools = [...this.children];
		this.children.length = 0;
		this.patch.groups.delete(this);
		return tools;
	}

	removeTool(tool: ToolExecutionComponent): void {
		const index = this.children.indexOf(tool);
		if (index >= 0) this.children.splice(index, 1);
	}

	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
		for (const tool of this.children) tool.setExpanded?.(expanded);
	}

	render(width: number): string[] {
		const counts = new Map<string, number>();
		let pending = false;
		let failed = false;
		let expanded = this.expanded;
		for (const tool of this.children) {
			const name = componentToolName(tool);
			counts.set(name, (counts.get(name) ?? 0) + 1);
			const state = componentStatus(tool);
			pending ||= state === "pending";
			failed ||= state === "error";
			expanded ||= Boolean((tool as unknown as { expanded?: boolean }).expanded);
		}

		const theme = currentTheme;
		const state = failed ? "error" : pending ? "pending" : "success";
		const icon = theme?.fg(state === "pending" ? "accent" : state, glyph(state)) ?? glyph(state);
		const label = pending ? "Running tools" : failed ? "Tools completed with errors" : "Tools completed";
		const summary = [...counts].map(([name, count]) => `${name}${count > 1 ? `×${count}` : ""}`).join(", ");
		const hint = expanded ? "" : " · Ctrl+O to expand";
		const header = truncateToWidth(`${icon} ${label} · ${summary}${theme?.fg("dim", hint) ?? hint}`, width, "…");
		if (!expanded) {
			const lines = [header];
			for (let index = 0; index < this.children.length; index++) {
				const tool = this.children[index];
				const branch = index === this.children.length - 1 ? "└" : "├";
				const toolState = componentStatus(tool);
				const toolIcon = theme?.fg(toolState === "pending" ? "accent" : toolState, glyph(toolState)) ?? glyph(toolState);
				const summary = groupedToolSummary(tool);
				lines.push(truncateToWidth(`${theme?.fg("dim", branch) ?? branch} ${toolIcon} ${theme?.fg("toolTitle", summary) ?? summary}`, width, "…"));
			}
			return lines;
		}

		const lines = [header];
		for (let index = 0; index < this.children.length; index++) {
			const tool = this.children[index];
			const branch = index === this.children.length - 1 ? "└" : "├";
			const continuation = index === this.children.length - 1 ? " " : "│";
			const rendered = visibleRenderedLines(tool, Math.max(1, width - 2));
			for (let lineIndex = 0; lineIndex < rendered.length; lineIndex++) {
				const prefix = lineIndex === 0 ? `${branch} ` : `${continuation} `;
				lines.push(truncateToWidth((theme?.fg("dim", prefix) ?? prefix) + rendered[lineIndex].replace(/^\s+/, ""), width, "…"));
			}
		}
		return lines;
	}
}

function parentOf(component: unknown): unknown {
	return (component as Record<symbol, unknown>)?.[GROUP_PARENT];
}

function normalizeGroup(patch: GroupingPatch, group: CompactToolGroup): void {
	if (group.children.length > 1) return;
	const parent = parentOf(group) as { children?: unknown[] } | undefined;
	const index = parent?.children?.indexOf(group) ?? -1;
	const tools = group.releaseTools();
	if (index < 0 || !parent?.children) return;
	if (tools.length === 1) {
		(tools[0] as unknown as Record<symbol, unknown>)[GROUP_PARENT] = parent;
		parent.children.splice(index, 1, tools[0]);
	} else {
		parent.children.splice(index, 1);
	}
}

function maybeGroup(patch: GroupingPatch, parent: Container, component: unknown): void {
	if (!patch.active || parent instanceof CompactToolGroup || !isGroupableTool(component)) return;
	const children = parent.children as unknown[];
	const index = children.indexOf(component);
	const prior = previousMeaningfulSibling(children, index - 1);
	if (!prior) return;
	if (prior.child instanceof CompactToolGroup) {
		children.splice(index, 1);
		prior.child.addTool(component);
		return;
	}
	if (!isGroupableTool(prior.child)) return;
	const group = new CompactToolGroup(patch);
	group.addTool(prior.child);
	group.addTool(component);
	(group as unknown as Record<symbol, unknown>)[GROUP_PARENT] = parent;
	children[prior.index] = group;
	children.splice(index, 1);
}

function ungroup(patch: GroupingPatch): void {
	for (const group of [...patch.groups]) {
		const parent = parentOf(group) as { children?: unknown[] } | undefined;
		const index = parent?.children?.indexOf(group) ?? -1;
		const tools = group.releaseTools();
		if (index < 0 || !parent?.children) continue;
		for (const tool of tools) (tool as unknown as Record<symbol, unknown>)[GROUP_PARENT] = parent;
		parent.children.splice(index, 1, ...tools);
	}
}

function installCompactToolGrouping(): GroupingPatch {
	const globalState = globalThis as typeof globalThis & { [GROUP_PATCH]?: GroupingPatch };
	globalState[GROUP_PATCH]?.shutdown();
	const prototype = Container.prototype;
	const original = {
		addChild: prototype.addChild,
		removeChild: prototype.removeChild,
		clear: prototype.clear,
	};
	const patch: GroupingPatch = {
		active: true,
		groups: new Set<CompactToolGroup>(),
		original,
		installed: undefined as unknown as GroupingPatch["installed"],
		shutdown() {
			if (!patch.active) return;
			patch.active = false;
			ungroup(patch);
			if (prototype.addChild === patch.installed.addChild) prototype.addChild = original.addChild;
			if (prototype.removeChild === patch.installed.removeChild) prototype.removeChild = original.removeChild;
			if (prototype.clear === patch.installed.clear) prototype.clear = original.clear;
			if (globalState[GROUP_PATCH] === patch) delete globalState[GROUP_PATCH];
		},
	};

	patch.installed = {
		addChild(this: Container, component: unknown) {
			const result = original.addChild.call(this, component as never);
			if (component && typeof component === "object") (component as Record<symbol, unknown>)[GROUP_PARENT] = this;
			maybeGroup(patch, this, component);
			return result;
		},
		removeChild(this: Container, component: unknown) {
			const group = parentOf(component);
			if (group instanceof CompactToolGroup && parentOf(group) === this) {
				group.removeTool(component as ToolExecutionComponent);
				normalizeGroup(patch, group);
				return;
			}
			const result = original.removeChild.call(this, component as never);
			if (this instanceof CompactToolGroup) normalizeGroup(patch, this);
			if (component instanceof CompactToolGroup) component.releaseTools();
			return result;
		},
		clear(this: Container) {
			for (const child of [...this.children]) {
				if (child instanceof CompactToolGroup) child.releaseTools();
			}
			if (this instanceof CompactToolGroup) patch.groups.delete(this);
			return original.clear.call(this);
		},
	};
	prototype.addChild = patch.installed.addChild;
	prototype.removeChild = patch.installed.removeChild;
	prototype.clear = patch.installed.clear;
	globalState[GROUP_PATCH] = patch;
	return patch;
}

function humanizeToolName(name: string): string {
	return name
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.replace(/[_-]+/g, " ")
		.replace(/\b\w/g, (character) => character.toUpperCase());
}

function genericArgumentSummary(args: unknown, cwd: string): string {
	if (!args || typeof args !== "object") return "";
	const values = args as Record<string, unknown>;
	const preferred = ["path", "file_path", "command", "query", "pattern", "url", "name", "message"];
	for (const key of preferred) {
		const value = values[key];
		if (typeof value !== "string" || !value.trim()) continue;
		return key === "path" || key === "file_path" ? displayPath(value, cwd) : ellipsize(value);
	}
	return "";
}

function compactErrorSummary(toolName: string, text: string): string {
	const firstLine = outputLines(text)[0]?.trim() || "Failed";
	const escapedName = toolName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return ellipsize(firstLine.replace(new RegExp(`^${escapedName}\\s*[—–:-]+\\s*`, "i"), ""));
}

function genericInputText(args: unknown, cwd: string): string {
	if (!args || typeof args !== "object" || Object.keys(args).length === 0) return "";
	const values = { ...(args as Record<string, unknown>) };
	for (const key of ["path", "file_path"]) {
		if (typeof values[key] === "string") values[key] = displayPath(values[key], cwd);
	}
	try {
		return JSON.stringify(values, null, 2);
	} catch {
		return String(args);
	}
}

function genericExpandedPreview(args: unknown, output: string, theme: Theme, failed: boolean, cwd: string): Text {
	const input = genericInputText(args, cwd);
	const sections: string[] = [];
	const appendSection = (corner: "├" | "└", title: string, body: string, isError = false) => {
		sections.push(`${theme.fg("dim", corner)} ${theme.fg("accent", theme.bold(title))}`);
		const lines = outputLines(body);
		const visible = lines.slice(0, EXPANDED_PREVIEW_LINES);
		for (const line of visible) sections.push(`${theme.fg("dim", corner === "├" ? "│" : " ")} ${theme.fg(isError ? "error" : "toolOutput", line)}`);
		if (lines.length > visible.length) sections.push(theme.fg("dim", `  … ${lines.length - visible.length} more lines`));
	};
	if (input) appendSection("├", "Input", input);
	appendSection("└", "Output", output || "Done", failed);
	return new Text(sections.join("\n"), 0, 0);
}

function createGenericToolRenderer(component: ToolExecutionComponent, cwd: string) {
	const runtime = component as unknown as {
		toolDefinition?: { label?: string };
		builtInToolDefinition?: { label?: string };
		toolName?: string;
	};
	const name = String(runtime.toolName ?? "tool");
	const label = runtime.toolDefinition?.label || runtime.builtInToolDefinition?.label || humanizeToolName(name);
	return {
		renderCall(args: unknown, theme: Theme, context: CompactRenderContext) {
			const detail = genericArgumentSummary(args, cwd);
			const text = theme.fg("toolTitle", theme.bold(label)) + (detail ? theme.fg("dim", ` ${detail}`) : "");
			return renderCallLine(text, statusBackground(theme, "pending"), context);
		},
		renderResult(
			result: { content?: Array<{ type: string; text?: string }> },
			options: { expanded?: boolean; isPartial?: boolean },
			theme: Theme,
			context: CompactRenderContext,
		) {
			const text = textContent(result);
			if (options.isPartial) {
				updateCallLine("", "pending", statusBackground(theme, "pending"), context);
				return new Text(theme.fg("muted", `↳ ${pendingStatus("Pending…", text, context)}`), 0, 0);
			}
			const failed = isErrorResult(text, context);
			const state = failed ? "error" : "success";
			const lines = nonEmptyLineCount(text);
			updateCallLine("", state, statusBackground(theme, state), context);
			if (options.expanded) return genericExpandedPreview(context.args, text, theme, failed, cwd);
			const summary = failed ? compactErrorSummary(name, text) : lines > 0 ? `${lines} ${lines === 1 ? "line" : "lines"} returned` : "Done";
			const hasDetail = Boolean(text) || Boolean(genericInputText(context.args, cwd));
			const hint = hasDetail ? theme.fg("dim", " · Ctrl+O to expand") : "";
			return new Text(`${theme.fg("dim", "↳ ")}${theme.fg(failed ? "error" : "muted", summary)}${hint}`, 0, 0);
		},
	};
}

function installCompactToolRendering(cwd: string): ToolRenderingPatch {
	const globalState = globalThis as typeof globalThis & { [TOOL_RENDER_PATCH]?: ToolRenderingPatch };
	globalState[TOOL_RENDER_PATCH]?.shutdown();
	const prototype = ToolExecutionComponent.prototype as unknown as ToolExecutionComponent & ToolRenderMethods;
	const original: ToolRenderMethods = {
		getCallRenderer: prototype.getCallRenderer,
		getRenderShell: prototype.getRenderShell,
		getResultRenderer: prototype.getResultRenderer,
	};
	const rendererFor = (component: ToolExecutionComponent) => {
		const state = component as unknown as Record<symbol, unknown>;
		let renderer = state[GENERIC_RENDERER] as ReturnType<typeof createGenericToolRenderer> | undefined;
		if (!renderer) {
			renderer = createGenericToolRenderer(component, cwd);
			state[GENERIC_RENDERER] = renderer;
		}
		return renderer;
	};
	const usesOwnRenderer = (component: ToolExecutionComponent) => OWN_TOOL_RENDERERS.has(componentToolName(component));
	const patch: ToolRenderingPatch = {
		active: true,
		original,
		installed: {
			getRenderShell(this: ToolExecutionComponent) {
				return usesOwnRenderer(this) ? original.getRenderShell.call(this) : "self";
			},
			getCallRenderer(this: ToolExecutionComponent) {
				return usesOwnRenderer(this) ? original.getCallRenderer.call(this) : rendererFor(this).renderCall;
			},
			getResultRenderer(this: ToolExecutionComponent) {
				return usesOwnRenderer(this) ? original.getResultRenderer.call(this) : rendererFor(this).renderResult;
			},
		},
		shutdown() {
			if (!patch.active) return;
			patch.active = false;
			if (prototype.getRenderShell === patch.installed.getRenderShell) prototype.getRenderShell = original.getRenderShell;
			if (prototype.getCallRenderer === patch.installed.getCallRenderer) prototype.getCallRenderer = original.getCallRenderer;
			if (prototype.getResultRenderer === patch.installed.getResultRenderer) prototype.getResultRenderer = original.getResultRenderer;
			if (globalState[TOOL_RENDER_PATCH] === patch) delete globalState[TOOL_RENDER_PATCH];
		},
	};
	prototype.getRenderShell = patch.installed.getRenderShell;
	prototype.getCallRenderer = patch.installed.getCallRenderer;
	prototype.getResultRenderer = patch.installed.getResultRenderer;
	globalState[TOOL_RENDER_PATCH] = patch;
	return patch;
}

function textContent(result: { content?: Array<{ type: string; text?: string }> }): string {
	return (result.content ?? [])
		.filter((item) => item.type === "text")
		.map((item) => item.text ?? "")
		.join("\n")
		.replace(/\r\n?/g, "\n");
}

function outputLines(text: string): string[] {
	const normalized = text.replace(/\n+$/, "");
	return normalized ? normalized.split("\n") : [];
}

function nonEmptyLineCount(text: string): number {
	return outputLines(text).filter((line) => line.trim()).length;
}

function ellipsize(text: string, limit = COMMAND_PREVIEW_LENGTH): string {
	const oneLine = text.replace(/\s+/g, " ").trim();
	return oneLine.length > limit ? `${oneLine.slice(0, limit - 1)}…` : oneLine;
}

function glyph(state: "pending" | "success" | "error"): string {
	if (state === "success") return "✓";
	if (state === "error") return "✗";
	return "●";
}

function renderCallLine(
	text: string,
	background: ToolBackground | undefined,
	context: CompactRenderContext,
): Text {
	const component = new Text(`${glyph("pending")} ${text}`, 0, 0, background);
	context.state.callComponent = component;
	context.state.callText = text;
	context.state.startedAt = Date.now();
	return component;
}

function updateCallLine(
	status: string,
	state: "pending" | "success" | "error",
	background: ToolBackground | undefined,
	context: CompactRenderContext,
): void {
	const { callComponent, callText = "tool" } = context.state;
	callComponent?.setCustomBgFn(background);
	callComponent?.setText(`${glyph(state)} ${callText}${status ? ` · ${status}` : ""}`);
}

function emptyResult(): Text {
	return new Text("", 0, 0);
}

function isErrorResult(text: string, context: CompactRenderContext): boolean {
	return Boolean(context.isError) || /^(error\b|command (?:aborted|timed out|exited))/i.test(text.trim());
}

function previewText(
	text: string,
	theme: Theme,
	options: {
		expanded: boolean;
		isError?: boolean;
		mode?: "head" | "tail";
		style?: "diff" | "output" | "write";
	},
): Text {
	const lines = outputLines(text);
	const limit = options.expanded ? EXPANDED_PREVIEW_LINES : COLLAPSED_PREVIEW_LINES;
	const visible = options.mode === "tail" && lines.length > limit ? lines.slice(-limit) : lines.slice(0, limit);
	const hidden = Math.max(0, lines.length - visible.length);
	const rendered: string[] = [];

	for (let index = 0; index < visible.length; index++) {
		const line = visible[index] ?? "";
		const rail = theme.fg("dim", `${index === visible.length - 1 && hidden === 0 ? "└" : "│"} `);
		let styled = theme.fg(options.isError ? "error" : "toolOutput", line);
		if (options.style === "diff") {
			if (line.startsWith("+")) styled = theme.fg("success", line);
			else if (line.startsWith("-")) styled = theme.fg("error", line);
			else styled = theme.fg("dim", line);
		} else if (options.style === "write") {
			styled = theme.fg("muted", `${String(index + 1).padStart(3, " ")} │ ${line}`);
		}
		rendered.push(rail + styled);
	}

	if (hidden > 0) rendered.push(theme.fg("dim", `└ … ${hidden} more lines · Ctrl+O to expand`));
	return new Text(rendered.join("\n"), 0, 0);
}

function pendingStatus(label: string, resultText: string, context: CompactRenderContext): string {
	const elapsedMs = context.state.startedAt ? Date.now() - context.state.startedAt : 0;
	const elapsed = elapsedMs >= 1000 ? ` · ${Math.max(1, Math.round(elapsedMs / 1000))}s` : "";
	const lines = nonEmptyLineCount(resultText);
	return `${label}${elapsed}${lines > 0 ? ` · ${lines} lines` : ""}`;
}

function statusBackground(theme: Theme, state: "pending" | "success" | "error"): ToolBackground | undefined {
	currentTheme = theme;
	if (state === "success") return undefined;
	const name = state === "pending" ? "toolPendingBg" : "toolErrorBg";
	return (value) => theme.bg(name, value);
}

function inspectionBackground(theme: Theme, state: "pending" | "success" | "error"): ToolBackground | undefined {
	currentTheme = theme;
	return state === "error" ? statusBackground(theme, state) : undefined;
}

function displayPath(path: string | undefined, cwd: string): string {
	if (!path) return ".";
	if (!isAbsolute(path)) return path.replace(/^\.\//, "") || ".";
	const projectRelative = relative(cwd, path);
	if (!projectRelative) return ".";
	if (projectRelative !== ".." && !projectRelative.startsWith(`..${sep}`) && !isAbsolute(projectRelative)) {
		return projectRelative;
	}
	return path;
}

function countDiff(diff: string): { additions: number; removals: number } {
	let additions = 0;
	let removals = 0;
	for (const line of outputLines(diff)) {
		if (line.startsWith("+") && !line.startsWith("+++")) additions++;
		if (line.startsWith("-") && !line.startsWith("---")) removals++;
	}
	return { additions, removals };
}

function resultLimitSuffix(details: { truncation?: { truncated?: boolean; totalLines?: number } } | undefined): string {
	if (!details?.truncation?.truncated) return "";
	return details.truncation.totalLines ? ` · truncated from ${details.truncation.totalLines}` : " · truncated";
}

export default function builtInToolRenderer(pi: ExtensionAPI) {
	const cwd = process.cwd();
	const grouping = installCompactToolGrouping();
	const toolRendering = installCompactToolRendering(cwd);
	pi.on("session_start", (_event, context) => {
		currentTheme = context.ui.theme;
	});
	pi.on("session_shutdown", () => {
		grouping.shutdown();
		toolRendering.shutdown();
	});

	const originalRead = createReadTool(cwd);
	pi.registerTool({
		name: "read",
		label: "read",
		description: originalRead.description,
		parameters: originalRead.parameters,
		renderShell: "self",
		async execute(toolCallId, params, signal, onUpdate) {
			return originalRead.execute(toolCallId, params, signal, onUpdate);
		},
		renderCall(args, theme, context) {
			let text = theme.fg("toolTitle", theme.bold("read ")) + theme.fg("accent", displayPath(args.path, cwd));
			const range = [
				args.offset !== undefined ? `offset=${args.offset}` : "",
				args.limit !== undefined ? `limit=${args.limit}` : "",
			].filter(Boolean);
			if (range.length) text += theme.fg("dim", ` (${range.join(", ")})`);
			return renderCallLine(text, inspectionBackground(theme, "pending"), context);
		},
		renderResult(result, { expanded, isPartial }, theme, context) {
			const text = textContent(result);
			if (isPartial) {
				updateCallLine(pendingStatus("Reading…", text, context), "pending", inspectionBackground(theme, "pending"), context);
				return emptyResult();
			}
			const content = result.content[0];
			const failed = isErrorResult(text, context);
			const state = failed ? "error" : "success";
			if (content?.type === "image") {
				updateCallLine("Image loaded", state, inspectionBackground(theme, state), context);
				return emptyResult();
			}
			const details = result.details as ReadToolDetails | undefined;
			updateCallLine(
				failed ? ellipsize(outputLines(text)[0] ?? "Failed") : `${outputLines(text).length} lines${resultLimitSuffix(details)}`,
				state,
				inspectionBackground(theme, state),
				context,
			);
			return expanded || failed ? previewText(text, theme, { expanded, isError: failed }) : emptyResult();
		},
	});

	const originalBash = createBashTool(cwd);
	pi.registerTool({
		name: "bash",
		label: "bash",
		description: originalBash.description,
		parameters: originalBash.parameters,
		renderShell: "self",
		async execute(toolCallId, params, signal, onUpdate) {
			return originalBash.execute(toolCallId, params, signal, onUpdate);
		},
		renderCall(args, theme, context) {
			let text = theme.fg("toolTitle", theme.bold("$ ")) + theme.fg("accent", ellipsize(args.command));
			if (args.timeout) text += theme.fg("dim", ` (${args.timeout}s timeout)`);
			return renderCallLine(text, statusBackground(theme, "pending"), context);
		},
		renderResult(result, { expanded, isPartial }, theme, context) {
			const text = textContent(result);
			if (isPartial) {
				updateCallLine(pendingStatus("Running…", text, context), "pending", statusBackground(theme, "pending"), context);
				return text ? previewText(text, theme, { expanded: false, mode: "tail" }) : emptyResult();
			}
			const failed = isErrorResult(text, context);
			const state = failed ? "error" : "success";
			const exitMatch = text.match(/Command exited with code (\d+)/i);
			const details = result.details as BashToolDetails | undefined;
			const status = failed
				? exitMatch
					? `exit ${exitMatch[1]}`
					: ellipsize(outputLines(text).at(-1) ?? "Failed")
				: `done · ${nonEmptyLineCount(text)} lines${resultLimitSuffix(details)}`;
			updateCallLine(status, state, statusBackground(theme, state), context);
			return text ? previewText(text, theme, { expanded, isError: failed, mode: "tail" }) : emptyResult();
		},
	});

	const originalEdit = createEditTool(cwd);
	pi.registerTool({
		name: "edit",
		label: "edit",
		description: originalEdit.description,
		parameters: originalEdit.parameters,
		renderShell: "self",
		async execute(toolCallId, params, signal, onUpdate) {
			return originalEdit.execute(toolCallId, params, signal, onUpdate);
		},
		renderCall(args, theme, context) {
			const count = Array.isArray(args.edits) ? args.edits.length : 1;
			const text = theme.fg("toolTitle", theme.bold("edit ")) + theme.fg("accent", displayPath(args.path, cwd)) + theme.fg("dim", ` (${count} ${count === 1 ? "change" : "changes"})`);
			return renderCallLine(text, statusBackground(theme, "pending"), context);
		},
		renderResult(result, { expanded, isPartial }, theme, context) {
			const resultText = textContent(result);
			if (isPartial) {
				updateCallLine("Editing…", "pending", statusBackground(theme, "pending"), context);
				return emptyResult();
			}
			const failed = isErrorResult(resultText, context);
			const state = failed ? "error" : "success";
			const details = result.details as EditToolDetails | undefined;
			if (failed || !details?.diff) {
				updateCallLine(failed ? ellipsize(outputLines(resultText)[0] ?? "Failed") : "Applied", state, statusBackground(theme, state), context);
				return failed ? previewText(resultText, theme, { expanded, isError: true }) : emptyResult();
			}
			const { additions, removals } = countDiff(details.diff);
			const status = `${theme.fg("success", `+${additions}`)} ${theme.fg("error", `-${removals}`)}`;
			updateCallLine(status, "success", statusBackground(theme, "success"), context);
			return previewText(details.diff, theme, { expanded, style: "diff" });
		},
	});

	const originalWrite = createWriteTool(cwd);
	pi.registerTool({
		name: "write",
		label: "write",
		description: originalWrite.description,
		parameters: originalWrite.parameters,
		renderShell: "self",
		async execute(toolCallId, params, signal, onUpdate) {
			return originalWrite.execute(toolCallId, params, signal, onUpdate);
		},
		renderCall(args, theme, context) {
			context.state.writeContent = args.content;
			const lines = outputLines(args.content).length;
			const text = theme.fg("toolTitle", theme.bold("write ")) + theme.fg("accent", displayPath(args.path, cwd)) + theme.fg("dim", ` (${lines} lines)`);
			return renderCallLine(text, statusBackground(theme, "pending"), context);
		},
		renderResult(result, { expanded, isPartial }, theme, context) {
			const resultText = textContent(result);
			if (isPartial) {
				updateCallLine("Writing…", "pending", statusBackground(theme, "pending"), context);
				return emptyResult();
			}
			const failed = isErrorResult(resultText, context);
			const state = failed ? "error" : "success";
			const written = context.state.writeContent ?? "";
			updateCallLine(failed ? ellipsize(outputLines(resultText)[0] ?? "Failed") : `Written · ${outputLines(written).length} lines`, state, statusBackground(theme, state), context);
			if (failed) return previewText(resultText, theme, { expanded, isError: true });
			return written ? previewText(written, theme, { expanded, style: "write" }) : emptyResult();
		},
	});

	const originalGrep = createGrepTool(cwd);
	pi.registerTool({
		name: "grep",
		label: "grep",
		description: originalGrep.description,
		parameters: originalGrep.parameters,
		renderShell: "self",
		async execute(toolCallId, params, signal, onUpdate) {
			return originalGrep.execute(toolCallId, params, signal, onUpdate);
		},
		renderCall(args, theme, context) {
			let text = theme.fg("toolTitle", theme.bold("grep ")) + theme.fg("accent", `“${ellipsize(args.pattern, 64)}”`);
			text += theme.fg("dim", ` in ${displayPath(args.path, cwd)}${args.glob ? ` · ${args.glob}` : ""}`);
			return renderCallLine(text, inspectionBackground(theme, "pending"), context);
		},
		renderResult(result, { expanded, isPartial }, theme, context) {
			const text = textContent(result);
			if (isPartial) {
				updateCallLine("Searching…", "pending", inspectionBackground(theme, "pending"), context);
				return emptyResult();
			}
			const failed = isErrorResult(text, context);
			const state = failed ? "error" : "success";
			const details = result.details as GrepToolDetails | undefined;
			updateCallLine(failed ? ellipsize(outputLines(text)[0] ?? "Failed") : `${nonEmptyLineCount(text)} matches${resultLimitSuffix(details)}`, state, inspectionBackground(theme, state), context);
			return expanded || failed ? previewText(text, theme, { expanded, isError: failed }) : emptyResult();
		},
	});

	const originalFind = createFindTool(cwd);
	pi.registerTool({
		name: "find",
		label: "find",
		description: originalFind.description,
		parameters: originalFind.parameters,
		renderShell: "self",
		async execute(toolCallId, params, signal, onUpdate) {
			return originalFind.execute(toolCallId, params, signal, onUpdate);
		},
		renderCall(args, theme, context) {
			const text = theme.fg("toolTitle", theme.bold("find ")) + theme.fg("accent", args.pattern) + theme.fg("dim", ` in ${displayPath(args.path, cwd)}`);
			return renderCallLine(text, inspectionBackground(theme, "pending"), context);
		},
		renderResult(result, { expanded, isPartial }, theme, context) {
			const text = textContent(result);
			if (isPartial) {
				updateCallLine("Finding…", "pending", inspectionBackground(theme, "pending"), context);
				return emptyResult();
			}
			const failed = isErrorResult(text, context);
			const state = failed ? "error" : "success";
			const details = result.details as FindToolDetails | undefined;
			updateCallLine(failed ? ellipsize(outputLines(text)[0] ?? "Failed") : `${nonEmptyLineCount(text)} files${resultLimitSuffix(details)}`, state, inspectionBackground(theme, state), context);
			return expanded || failed ? previewText(text, theme, { expanded, isError: failed }) : emptyResult();
		},
	});

	const originalLs = createLsTool(cwd);
	pi.registerTool({
		name: "ls",
		label: "ls",
		description: originalLs.description,
		parameters: originalLs.parameters,
		renderShell: "self",
		async execute(toolCallId, params, signal, onUpdate) {
			return originalLs.execute(toolCallId, params, signal, onUpdate);
		},
		renderCall(args, theme, context) {
			const text = theme.fg("toolTitle", theme.bold("ls ")) + theme.fg("accent", displayPath(args.path, cwd));
			return renderCallLine(text, inspectionBackground(theme, "pending"), context);
		},
		renderResult(result, { expanded, isPartial }, theme, context) {
			const text = textContent(result);
			if (isPartial) {
				updateCallLine("Listing…", "pending", inspectionBackground(theme, "pending"), context);
				return emptyResult();
			}
			const failed = isErrorResult(text, context);
			const state = failed ? "error" : "success";
			const details = result.details as LsToolDetails | undefined;
			updateCallLine(failed ? ellipsize(outputLines(text)[0] ?? "Failed") : `${nonEmptyLineCount(text)} entries${resultLimitSuffix(details)}`, state, inspectionBackground(theme, state), context);
			return expanded || failed ? previewText(text, theme, { expanded, isError: failed }) : emptyResult();
		},
	});
}
