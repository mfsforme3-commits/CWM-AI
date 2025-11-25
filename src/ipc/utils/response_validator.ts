import log from "electron-log";
import type { WorkflowStep } from "../workflow/workflow_manager";
import type { ChatMode } from "@/lib/schemas";

const logger = log.scope("response_validator");

export type ViolationType =
    | "code_block"
    | "codex_tool"
    | "mode_violation"
    | "malformed_tag"
    | "prohibited_content";

export interface ValidationViolation {
    type: ViolationType;
    message: string;
    context: string;
    severity: "critical" | "warning";
}

export interface ValidationResult {
    isValid: boolean;
    violations: ValidationViolation[];
    warnings: ValidationViolation[];
}

interface ValidationContext {
    mode: ChatMode;
    workflowStep?: WorkflowStep | null;
    modelProvider?: string;
}

/**
 * Detects markdown code blocks in the response (prohibited for file content)
 */
export function detectMarkdownCodeBlocks(response: string): ValidationViolation[] {
    const violations: ValidationViolation[] = [];
    const codeBlockRegex = /```[\s\S]*?```/g;
    let match;

    while ((match = codeBlockRegex.exec(response)) !== null) {
        const snippet = match[0].substring(0, 100) + (match[0].length > 100 ? "..." : "");

        violations.push({
            type: "code_block",
            severity: "critical",
            message: "Markdown code blocks are prohibited for file content. Use <dyad-write> tags instead.",
            context: snippet,
        });
    }

    return violations;
}

/**
 * Detects attempts to use Codex CLI tools (prohibited in Dyad)
 */
export function detectCodexCliTools(response: string): ValidationViolation[] {
    const violations: ValidationViolation[] = [];
    const prohibitedTools = [
        "apply_patch",
        "turbo_edit",
        "patch_file",
        "edit_file",
        "write_file",
    ];

    for (const tool of prohibitedTools) {
        // Look for tool mentions that appear to be tool calls or instructions
        const toolRegex = new RegExp(`\\b${tool}\\b`, "gi");
        if (toolRegex.test(response)) {
            violations.push({
                type: "codex_tool",
                severity: "critical",
                message: `Detected Codex CLI tool "${tool}". These tools do not exist in Dyad. Use <dyad-write> tags instead.`,
                context: `Found reference to: ${tool}`,
            });
        }
    }

    return violations;
}

/**
 * Validates that dyad tags are properly structured (opened and closed)
 */
export function validateDyadTagStructure(response: string): ValidationViolation[] {
    const violations: ValidationViolation[] = [];

    // Check for unclosed dyad-write tags
    const writeOpenRegex = /<dyad-write[^>]*>/g;
    const writeCloseRegex = /<\/dyad-write>/g;

    const openMatches = response.match(writeOpenRegex) || [];
    const closeMatches = response.match(writeCloseRegex) || [];

    if (openMatches.length !== closeMatches.length) {
        violations.push({
            type: "malformed_tag",
            severity: "critical",
            message: `Mismatched dyad-write tags: ${openMatches.length} opening tags, ${closeMatches.length} closing tags`,
            context: `Found ${openMatches.length} <dyad-write>, ${closeMatches.length} </dyad-write>`,
        });
    }

    return violations;
}

/**
 * Detects instructions or summaries inside dyad-write tags (prohibited)
 */
export function detectProhibitedInstructions(response: string): ValidationViolation[] {
    const violations: ValidationViolation[] = [];

    // Extract content between dyad-write tags
    const writeTagRegex = /<dyad-write[^>]*>([\s\S]*?)<\/dyad-write>/g;
    let match;

    while ((match = writeTagRegex.exec(response)) !== null) {
        const content = match[1];

        // Check for common instruction patterns
        const prohibitedPatterns = [
            /^Summary:/im,
            /^Here's what I changed/im,
            /^I've updated/im,
            /^Click/im,
            /^Please/im,
            /^Now hit refresh/im,
            /^-\s*Fixed/im, // Bullet list of changes
            /^-\s*Added/im,
        ];

        for (const pattern of prohibitedPatterns) {
            if (pattern.test(content)) {
                const snippet = content.substring(0, 100) + (content.length > 100 ? "..." : "");
                violations.push({
                    type: "prohibited_content",
                    severity: "critical",
                    message: "Instructions or summaries found inside <dyad-write> tag. Only file content is allowed.",
                    context: snippet,
                });
                break; // Only report once per tag
            }
        }
    }

    return violations;
}

/**
 * Validates response compliance with the current mode
 */
export function validateModeCompliance(
    response: string,
    context: ValidationContext
): ValidationViolation[] {
    const violations: ValidationViolation[] = [];
    const { mode, workflowStep } = context;

    // Check for dyad tags in the response
    const hasDyadWrite = /<dyad-write[^>]*>/.test(response);
    const hasDyadDelete = /<dyad-delete[^>]*>/.test(response);
    const hasDyadRename = /<dyad-rename[^>]*>/.test(response);
    const hasDyadAddDep = /<dyad-add-dependency[^>]*>/.test(response);
    const hasAnyDyadTag = hasDyadWrite || hasDyadDelete || hasDyadRename || hasDyadAddDep;

    // Planning mode: No file operations allowed
    if (workflowStep === "planning") {
        if (hasAnyDyadTag) {
            violations.push({
                type: "mode_violation",
                severity: "critical",
                message: "Planning mode prohibits file creation/modification. Only markdown plans are allowed.",
                context: "Found dyad tags in planning mode",
            });
        }
    }

    // Docs mode: Only markdown files allowed
    if (workflowStep === "docs") {
        if (hasDyadWrite) {
            // Extract file paths from dyad-write tags
            const pathRegex = /<dyad-write\s+path="([^"]+)"/g;
            let pathMatch;

            while ((pathMatch = pathRegex.exec(response)) !== null) {
                const filePath = pathMatch[1];
                const isMarkdown = filePath.endsWith(".md");
                const isDocsFolder = filePath.startsWith("docs/") || filePath === "README.md";

                if (!isMarkdown || !isDocsFolder) {
                    violations.push({
                        type: "mode_violation",
                        severity: "critical",
                        message: `Docs mode only allows markdown files in docs/ or README.md. Found: ${filePath}`,
                        context: filePath,
                    });
                }
            }
        }
    }

    // Agent mode: No dyad tags allowed, only MCP tools
    if (mode === "agent") {
        if (hasAnyDyadTag) {
            violations.push({
                type: "mode_violation",
                severity: "critical",
                message: "Agent mode prohibits dyad tags. Use MCP tools (execute_command, web-search) instead.",
                context: "Found dyad tags in agent mode",
            });
        }
    }

    // Ask mode: No dyad tags allowed at all
    if (mode === "ask") {
        if (hasAnyDyadTag) {
            violations.push({
                type: "mode_violation",
                severity: "critical",
                message: "Ask mode prohibits file operations. This mode is for questions and explanations only.",
                context: "Found dyad tags in ask mode",
            });
        }
    }

    return violations;
}

/**
 * Main validation function that runs all checks
 */
export function validateResponse(
    response: string,
    context: ValidationContext
): ValidationResult {
    const allViolations: ValidationViolation[] = [];

    // Run all validation checks
    allViolations.push(...detectMarkdownCodeBlocks(response));
    allViolations.push(...detectCodexCliTools(response));
    allViolations.push(...validateDyadTagStructure(response));
    allViolations.push(...detectProhibitedInstructions(response));
    allViolations.push(...validateModeCompliance(response, context));

    // Separate critical violations from warnings
    const criticalViolations = allViolations.filter((v) => v.severity === "critical");
    const warnings = allViolations.filter((v) => v.severity === "warning");

    const isValid = criticalViolations.length === 0;

    if (!isValid) {
        logger.warn(
            `Response validation failed with ${criticalViolations.length} critical violations`,
            criticalViolations
        );
    }

    return {
        isValid,
        violations: criticalViolations,
        warnings,
    };
}

/**
 * Formats validation errors into a user-friendly message
 */
export function formatValidationErrors(violations: ValidationViolation[]): string {
    if (violations.length === 0) {
        return "";
    }

    const messages = violations.map((v) => {
        switch (v.type) {
            case "code_block":
                return "⚠️ Markdown code blocks detected. Please use <dyad-write> tags for all file content.";
            case "codex_tool":
                return `⚠️ ${v.message}`;
            case "mode_violation":
                return `⚠️ Mode Violation: ${v.message}`;
            case "malformed_tag":
                return `⚠️ Tag Error: ${v.message}`;
            case "prohibited_content":
                return `⚠️ Invalid Content: ${v.message}`;
            default:
                return `⚠️ ${v.message}`;
        }
    });

    return messages.join("\n\n");
}
