import { streamText } from "ai";
import { getModelClient } from "./get_model_client";
import type { LargeLanguageModel, UserSettings } from "../../lib/schemas";
import log from "electron-log";

const logger = log.scope("streaming_monitor");

interface ViolationDetection {
    type: string;
    context: string;
}

export interface MonitorAnalysis {
    hasViolation: boolean;
    violationType?: string;
    correction?: string;
}

export class StreamingMonitor {
    private routerModel: LargeLanguageModel;
    private settings: UserSettings;
    private appPath: string;
    private accumulatedResponse: string = "";
    private violationsDetected: Set<string> = new Set();
    private correctionCallback?: (correction: string) => void;
    private mode: string;
    private workflowStep: string | null;

    constructor(params: {
        routerModel: LargeLanguageModel;
        settings: UserSettings;
        appPath: string;
        mode: string;
        workflowStep?: string | null;
        onCorrection?: (correction: string) => void;
    }) {
        this.routerModel = params.routerModel;
        this.settings = params.settings;
        this.appPath = params.appPath;
        this.mode = params.mode;
        this.workflowStep = params.workflowStep || null;
        this.correctionCallback = params.onCorrection;
    }

    /**
     * Analyze a new chunk of the streaming response
     */
    async analyzeChunk(chunk: string): Promise<MonitorAnalysis> {
        this.accumulatedResponse += chunk;

        // Quick pattern-based detection for common violations
        const violations = this.detectQuickViolations(this.accumulatedResponse);

        if (violations.length > 0) {
            for (const violation of violations) {
                // Only generate correction once per violation type
                if (!this.violationsDetected.has(violation.type)) {
                    this.violationsDetected.add(violation.type);

                    logger.warn(`Monitor detected violation: ${violation.type}`);

                    const correction = await this.generateCorrection(violation);

                    if (correction && this.correctionCallback) {
                        this.correctionCallback(correction);
                    }

                    return {
                        hasViolation: true,
                        violationType: violation.type,
                        correction,
                    };
                }
            }
        }

        return { hasViolation: false };
    }

    /**
     * Fast pattern detection without AI - checks for common violations
     */
    private detectQuickViolations(text: string): ViolationDetection[] {
        const violations: ViolationDetection[] = [];

        // Check for markdown code blocks
        const codeBlockMatch = text.match(/```[\w]*\n/);
        if (codeBlockMatch) {
            violations.push({
                type: "markdown_code_block",
                context: codeBlockMatch[0],
            });
        }

        // Check for Codex CLI tools
        const codexTools = ["apply_patch", "turbo_edit", "patch_file", "edit_file"];
        for (const tool of codexTools) {
            if (text.includes(tool)) {
                violations.push({
                    type: "codex_cli_tool",
                    context: tool,
                });
            }
        }

        // Check for mode-specific violations
        if (this.workflowStep === "planning" || this.mode === "planning") {
            if (text.includes("<dyad-write")) {
                violations.push({
                    type: "planning_mode_violation",
                    context: "<dyad-write in planning mode",
                });
            }
        }

        if (this.workflowStep === "docs" || this.mode === "docs") {
            if (text.includes("<dyad-write") && !text.match(/<dyad-write[^>]*path="[^"]*\.md"/)) {
                violations.push({
                    type: "docs_mode_violation",
                    context: "Non-markdown file in docs mode",
                });
            }
        }

        if (this.mode === "agent") {
            if (text.includes("<dyad-write") || text.includes("<dyad-delete") || text.includes("<dyad-rename")) {
                violations.push({
                    type: "agent_mode_violation",
                    context: "Dyad tags in agent mode",
                });
            }
        }

        return violations;
    }

    /**
     * Generate correction using router model
     */
    private async generateCorrection(violation: ViolationDetection): Promise<string | undefined> {
        try {
            const prompt = this.buildCorrectionPrompt(violation);

            const { modelClient } = await getModelClient(
                this.routerModel,
                this.settings,
                this.appPath
            );

            let correction = "";
            const stream = await streamText({
                model: modelClient.model,
                messages: [{ role: "user", content: prompt }],
            });

            for await (const chunk of stream.textStream) {
                correction += chunk;
            }

            logger.info(`Generated correction for ${violation.type}`);
            return correction.trim();
        } catch (error) {
            logger.error("Failed to generate correction:", error);
            return undefined;
        }
    }

    /**
     * Build concise correction prompt for router
     */
    private buildCorrectionPrompt(violation: ViolationDetection): string {
        const prompts: Record<string, string> = {
            markdown_code_block: `STOP! You're using markdown code blocks (\`\`\`) which are PROHIBITED.

Use ONLY <dyad-write> tags for file content:
<dyad-write path="src/file.ts" description="Description">
FILE CONTENT HERE
</dyad-write>

Continue your response using the correct format.`,

            codex_cli_tool: `STOP! You're trying to use Codex CLI tool "${violation.context}" which DOES NOT EXIST in Dyad.

Use ONLY these Dyad tags:
- <dyad-write path="...">content</dyad-write>
- <dyad-delete path="..." />
- <dyad-rename from="..." to="..." />

Continue your response using only Dyad tags.`,

            planning_mode_violation: `STOP! You're in PLANNING MODE which PROHIBITS creating files.

You CANNOT use <dyad-write> or any file operation tags in planning mode.

Write your plan in Markdown format only. Use the write_to_file tool to create implementation_plan.md.`,

            docs_mode_violation: `STOP! You're in DOCS MODE which only allows Markdown files.

You can ONLY create .md files in the docs/ directory or README.md.

Continue with documentation files only.`,

            agent_mode_violation: `STOP! You're in AGENT MODE which does NOT support Dyad tags.

Use ONLY MCP tools:
- execute_command for running shell commands
- web-search for finding information

Do NOT use <dyad-write> or any Dyad tags. Your job is information gathering, not code generation.`,
        };

        return prompts[violation.type] || "Fix the violation and continue correctly.";
    }

    /**
     * Reset monitor state for new response
     */
    reset() {
        this.accumulatedResponse = "";
        this.violationsDetected.clear();
    }
}
