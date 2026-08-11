/**
 * Built-in Tool Renderer Example - Custom rendering for built-in tools
 *
 * Demonstrates how to override the rendering of built-in tools (read, bash,
 * edit, write) without changing their behavior. Each tool is re-registered
 * with the same name, delegating execution to the original implementation
 * while providing compact custom renderCall/renderResult functions.
 *
 * This is useful for users who prefer more concise tool output, or who want
 * to highlight specific information (e.g., showing only the diff stats for
 * edit, or just the exit code for bash).
 *
 * How it works:
 * - registerTool() with the same name as a built-in replaces it entirely
 * - We create instances of the original tools via createReadTool(), etc.
 *   and delegate execute() to them
 * - renderCall() controls what's shown when the tool is invoked
 * - renderResult() controls what's shown after execution completes
 * - renderShell: "self" lets a tool render its own outer shell instead of
 *   using the default boxed shell from ToolExecutionComponent
 * - The `expanded` flag in renderResult indicates whether the user has
 *   toggled the tool output open (via ctrl+e or clicking)
 *
 * Usage:
 *   pi -e ./built-in-tool-renderer.ts
 */

import type { BashToolDetails, EditToolDetails, ExtensionAPI, ReadToolDetails } from "@earendil-works/pi-coding-agent";
import { createBashTool, createEditTool, createReadTool, createWriteTool } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

type CompactRenderContext = {
	lastComponent?: unknown;
	state: {
		callComponent?: Text;
		callText?: string;
	};
};

type ToolBackground = (text: string) => string;

function renderCallLine(text: string, background: ToolBackground, context: CompactRenderContext): Text {
	const component = new Text(text, 0, 1, background);
	context.state.callComponent = component;
	context.state.callText = text;
	return component;
}

function renderCollapsedStatus(
	status: string,
	expanded: boolean,
	background: ToolBackground,
	context: CompactRenderContext,
): Text | undefined {
	const { callComponent, callText = "" } = context.state;
	callComponent?.setCustomBgFn(background);
	if (expanded) {
		callComponent?.setText(callText);
		return undefined;
	}

	callComponent?.setText(`${callText} ${status}`);
	return new Text("", 0, 0);
}

export default function (pi: ExtensionAPI) {
	const cwd = process.cwd();

	// --- Read tool: show path and line count ---
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
			let text = theme.fg("toolTitle", theme.bold("read "));
			text += theme.fg("accent", args.path);
			if (args.offset || args.limit) {
				const parts: string[] = [];
				if (args.offset) parts.push(`offset=${args.offset}`);
				if (args.limit) parts.push(`limit=${args.limit}`);
				text += theme.fg("dim", ` (${parts.join(", ")})`);
			}
			return renderCallLine(text, (value) => theme.bg("toolPendingBg", value), context);
		},

		renderResult(result, { expanded, isPartial }, theme, context) {
			if (isPartial) {
				return renderCollapsedStatus(
					theme.fg("warning", "Reading..."),
					false,
					(value) => theme.bg("toolPendingBg", value),
					context,
				)!;
			}
			const successBackground = (value: string) => theme.bg("toolSuccessBg", value);
			const errorBackground = (value: string) => theme.bg("toolErrorBg", value);

			const details = result.details as ReadToolDetails | undefined;
			const content = result.content[0];

			if (content?.type === "image") {
				const status = theme.fg("success", "Image loaded");
				return (
					renderCollapsedStatus(status, expanded, successBackground, context) ??
					new Text(status, 0, 0, successBackground)
				);
			}

			if (content?.type !== "text") {
				const status = theme.fg("error", "No content");
				return (
					renderCollapsedStatus(status, expanded, errorBackground, context) ??
					new Text(status, 0, 0, errorBackground)
				);
			}

			const lineCount = content.text.split("\n").length;
			let text = theme.fg("success", `${lineCount} lines`);

			if (details?.truncation?.truncated) {
				text += theme.fg("warning", ` (truncated from ${details.truncation.totalLines})`);
			}

			const collapsed = renderCollapsedStatus(text, expanded, successBackground, context);
			if (collapsed) return collapsed;

			if (expanded) {
				const lines = content.text.split("\n").slice(0, 15);
				for (const line of lines) {
					text += `\n${theme.fg("dim", line)}`;
				}
				if (lineCount > 15) {
					text += `\n${theme.fg("muted", `... ${lineCount - 15} more lines`)}`;
				}
			}

			return new Text(text, 0, 0, successBackground);
		},
	});

	// --- Bash tool: show command and exit code ---
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
			let text = theme.fg("toolTitle", theme.bold("$ "));
			const cmd = args.command.length > 80 ? `${args.command.slice(0, 77)}...` : args.command;
			text += theme.fg("accent", cmd);
			if (args.timeout) {
				text += theme.fg("dim", ` (timeout: ${args.timeout}s)`);
			}
			return renderCallLine(text, (value) => theme.bg("toolPendingBg", value), context);
		},

		renderResult(result, { expanded, isPartial }, theme, context) {
			if (isPartial) {
				return renderCollapsedStatus(
					theme.fg("warning", "Running..."),
					false,
					(value) => theme.bg("toolPendingBg", value),
					context,
				)!;
			}
			const successBackground = (value: string) => theme.bg("toolSuccessBg", value);
			const errorBackground = (value: string) => theme.bg("toolErrorBg", value);

			const details = result.details as BashToolDetails | undefined;
			const content = result.content[0];
			const output = content?.type === "text" ? content.text : "";

			const exitMatch = output.match(/exit code: (\d+)/);
			const exitCode = exitMatch ? parseInt(exitMatch[1], 10) : null;
			const lineCount = output.split("\n").filter((l) => l.trim()).length;

			let text = "";
			if (exitCode === 0 || exitCode === null) {
				text += theme.fg("success", "done");
			} else {
				text += theme.fg("error", `exit ${exitCode}`);
			}
			text += theme.fg("dim", ` (${lineCount} lines)`);

			if (details?.truncation?.truncated) {
				text += theme.fg("warning", " [truncated]");
			}

			const background = exitCode === null || exitCode === 0 ? successBackground : errorBackground;
			const collapsed = renderCollapsedStatus(text, expanded, background, context);
			if (collapsed) return collapsed;

			if (expanded) {
				const lines = output.split("\n").slice(0, 20);
				for (const line of lines) {
					text += `\n${theme.fg("dim", line)}`;
				}
				if (output.split("\n").length > 20) {
					text += `\n${theme.fg("muted", "... more output")}`;
				}
			}

			return new Text(text, 0, 0, background);
		},
	});

	// --- Edit tool: show path and diff stats ---
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
			let text = theme.fg("toolTitle", theme.bold("edit "));
			text += theme.fg("accent", args.path);
			return renderCallLine(text, (value) => theme.bg("toolPendingBg", value), context);
		},

		renderResult(result, { expanded, isPartial }, theme, context) {
			if (isPartial) {
				return renderCollapsedStatus(
					theme.fg("warning", "Editing..."),
					false,
					(value) => theme.bg("toolPendingBg", value),
					context,
				)!;
			}
			const successBackground = (value: string) => theme.bg("toolSuccessBg", value);
			const errorBackground = (value: string) => theme.bg("toolErrorBg", value);

			const details = result.details as EditToolDetails | undefined;
			const content = result.content[0];

			if (content?.type === "text" && content.text.startsWith("Error")) {
				const status = theme.fg("error", content.text.split("\n")[0]);
				return (
					renderCollapsedStatus(status, expanded, errorBackground, context) ??
					new Text(status, 0, 0, errorBackground)
				);
			}

			if (!details?.diff) {
				const status = theme.fg("success", "Applied");
				return (
					renderCollapsedStatus(status, expanded, successBackground, context) ??
					new Text(status, 0, 0, successBackground)
				);
			}

			// Count additions and removals from the diff
			const diffLines = details.diff.split("\n");
			let additions = 0;
			let removals = 0;
			for (const line of diffLines) {
				if (line.startsWith("+") && !line.startsWith("+++")) additions++;
				if (line.startsWith("-") && !line.startsWith("---")) removals++;
			}

			let text = theme.fg("success", `+${additions}`);
			text += theme.fg("dim", " / ");
			text += theme.fg("error", `-${removals}`);

			const collapsed = renderCollapsedStatus(text, expanded, successBackground, context);
			if (collapsed) return collapsed;

			if (expanded) {
				for (const line of diffLines.slice(0, 30)) {
					if (line.startsWith("+") && !line.startsWith("+++")) {
						text += `\n${theme.fg("success", line)}`;
					} else if (line.startsWith("-") && !line.startsWith("---")) {
						text += `\n${theme.fg("error", line)}`;
					} else {
						text += `\n${theme.fg("dim", line)}`;
					}
				}
				if (diffLines.length > 30) {
					text += `\n${theme.fg("muted", `... ${diffLines.length - 30} more diff lines`)}`;
				}
			}

			return new Text(text, 0, 0, successBackground);
		},
	});

	// --- Write tool: show path and size ---
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
			let text = theme.fg("toolTitle", theme.bold("write "));
			text += theme.fg("accent", args.path);
			const lineCount = args.content.split("\n").length;
			text += theme.fg("dim", ` (${lineCount} lines)`);
			return renderCallLine(text, (value) => theme.bg("toolPendingBg", value), context);
		},

		renderResult(result, { expanded, isPartial }, theme, context) {
			if (isPartial) {
				return renderCollapsedStatus(
					theme.fg("warning", "Writing..."),
					false,
					(value) => theme.bg("toolPendingBg", value),
					context,
				)!;
			}
			const successBackground = (value: string) => theme.bg("toolSuccessBg", value);
			const errorBackground = (value: string) => theme.bg("toolErrorBg", value);

			const content = result.content[0];
			if (content?.type === "text" && content.text.startsWith("Error")) {
				const status = theme.fg("error", content.text.split("\n")[0]);
				return (
					renderCollapsedStatus(status, expanded, errorBackground, context) ??
					new Text(status, 0, 0, errorBackground)
				);
			}

			const status = theme.fg("success", "Written");
			return (
				renderCollapsedStatus(status, expanded, successBackground, context) ??
				new Text(status, 0, 0, successBackground)
			);
		},
	});
}
