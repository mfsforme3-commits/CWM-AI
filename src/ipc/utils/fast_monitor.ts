import log from "electron-log";

const logger = log.scope("fast_monitor");

export interface ViolationResult {
    hasViolation: boolean;
    violationType?: string;
    correction?: string;
    shouldAbort?: boolean;
}

/**
 * Fast pattern-based violation detection with pre-cached corrections
 * NO AI calls - instant detection and correction
 */
export class FastMonitor {
    private mode: string;
    private workflowStep: string | null;
    private detectedViolations: Set<string> = new Set();

    // Pre-cached corrections for instant response
    private static CACHED_CORRECTIONS: Record<string, string> = {
        markdown_code_block: `STOP! You're using markdown code blocks (\`\`\`) which are PROHIBITED.

Use ONLY <dyad-write> tags:
<dyad-write path="src/Component.tsx" description="Create component">
YOUR CODE HERE
</dyad-write>

Continue with <dyad-write> tags.`,

        codex_cli_tool: `STOP! Codex CLI tools (apply_patch, turbo_edit, etc.) DO NOT EXIST in Dyad.

Use ONLY Dyad tags:
<dyad-write path="...">content</dyad-write>

Continue using Dyad tags.`,

        planning_file_creation: `STOP! You're in PLANNING MODE - file creation is PROHIBITED.

Write a Markdown plan only. Use write_to_file tool to create 'implementation_plan.md'.

Continue with planning documentation only.`,

        docs_non_markdown: `STOP! DOCS MODE only allows .md files in docs/ directory.

Only create documentation files.

Continue with .md files only.`,

        agent_dyad_tags: `STOP! AGENT MODE does not support <dyad-write> or other Dyad tags.

Use ONLY MCP tools:
- execute_command for shell commands
- web-search for information

Continue with MCP tools only.`,
    };

    constructor(params: {
        mode: string;
        workflowStep?: string | null;
    }) {
        this.mode = params.mode;
        this.workflowStep = params.workflowStep || null;
    }

    /**
     * FAST pattern detection - no AI, instant results
     */
    checkChunk(chunk: string): ViolationResult {
        // Check for markdown code blocks (most common violation)
        if (this.detectMarkdownCodeBlock(chunk)) {
            if (!this.detectedViolations.has("markdown_code_block")) {
                this.detectedViolations.add("markdown_code_block");
                return {
                    hasViolation: true,
                    violationType: "markdown_code_block",
                    correction: FastMonitor.CACHED_CORRECTIONS.markdown_code_block,
                    shouldAbort: true,
                };
            }
        }

        // Check for Codex CLI tools
        if (this.detectCodexCliTool(chunk)) {
            if (!this.detectedViolations.has("codex_cli_tool")) {
                this.detectedViolations.add("codex_cli_tool");
                return {
                    hasViolation: true,
                    violationType: "codex_cli_tool",
                    correction: FastMonitor.CACHED_CORRECTIONS.codex_cli_tool,
                    shouldAbort: true,
                };
            }
        }

        // Mode-specific violations
        const modeViolation = this.checkModeViolations(chunk);
        if (modeViolation.hasViolation) {
            return modeViolation;
        }

        return { hasViolation: false };
    }

    /**
     * Detect markdown code blocks with opening triple backticks
     */
    private detectMarkdownCodeBlock(text: string): boolean {
        // Match ``` with optional language identifier
        return /```[\w]*\s*\n/.test(text);
    }

    /**
     * Detect Codex CLI tool usage
     */
    private detectCodexCliTool(text: string): boolean {
        const codexTools = [
            "apply_patch",
            "turbo_edit",
            "patch_file",
            "edit_file",
            "write_file",
        ];
        return codexTools.some((tool) => text.includes(tool));
    }

    /**
     * Check mode-specific violations
     */
    private checkModeViolations(text: string): ViolationResult {
        // Planning mode: no file creation
        if (this.workflowStep === "planning" || this.mode === "planning") {
            if (text.includes("<dyad-write")) {
                if (!this.detectedViolations.has("planning_file_creation")) {
                    this.detectedViolations.add("planning_file_creation");
                    return {
                        hasViolation: true,
                        violationType: "planning_file_creation",
                        correction: FastMonitor.CACHED_CORRECTIONS.planning_file_creation,
                        shouldAbort: true,
                    };
                }
            }
        }

        // Docs mode: only .md files
        if (this.workflowStep === "docs" || this.mode === "docs") {
            if (
                text.includes("<dyad-write") &&
                !text.match(/<dyad-write[^>]*path="[^"]*\.md"/)
            ) {
                if (!this.detectedViolations.has("docs_non_markdown")) {
                    this.detectedViolations.add("docs_non_markdown");
                    return {
                        hasViolation: true,
                        violationType: "docs_non_markdown",
                        correction: FastMonitor.CACHED_CORRECTIONS.docs_non_markdown,
                        shouldAbort: true,
                    };
                }
            }
        }

        // Agent mode: no dyad tags
        if (this.mode === "agent") {
            if (
                text.includes("<dyad-write") ||
                text.includes("<dyad-delete") ||
                text.includes("<dyad-rename")
            ) {
                if (!this.detectedViolations.has("agent_dyad_tags")) {
                    this.detectedViolations.add("agent_dyad_tags");
                    return {
                        hasViolation: true,
                        violationType: "agent_dyad_tags",
                        correction: FastMonitor.CACHED_CORRECTIONS.agent_dyad_tags,
                        shouldAbort: true,
                    };
                }
            }
        }

        return { hasViolation: false };
    }

    /**
     * Reset detection state for new response
     */
    reset() {
        this.detectedViolations.clear();
    }
}
