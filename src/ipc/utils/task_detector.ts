import type { CodebaseFile } from "../../utils/codebase";

export type TaskType = "frontend" | "backend" | "debugging" | "general";

interface TaskDetectionParams {
    userPrompt: string;
    selectedComponent?: { relativePath: string };
    codebaseFiles?: CodebaseFile[];
}

/**
 * Detects the task type based on user prompt, selected component, and codebase context
 */
export function detectTaskType(params: TaskDetectionParams): TaskType {
    const { userPrompt, selectedComponent, codebaseFiles } = params;
    const promptLower = userPrompt.toLowerCase();

    // Debugging keywords - highest priority
    const debuggingKeywords = [
        "error",
        "bug",
        "fix",
        "crash",
        "issue",
        "problem",
        "broken",
        "not working",
        "debug",
        "exception",
        "failed",
        "failing",
        "throws",
        "undefined",
        "null",
        "warning",
        "typescript error",
        "runtime error",
        "syntax error",
    ];

    // Frontend keywords
    const frontendKeywords = [
        "component",
        "ui",
        "button",
        "form",
        "input",
        "style",
        "css",
        "tailwind",
        "react",
        "jsx",
        "tsx",
        "page",
        "layout",
        "modal",
        "dialog",
        "tooltip",
        "animation",
        "hover",
        "click",
        "responsive",
        "mobile",
        "desktop",
        "navigation",
        "menu",
        "sidebar",
        "header",
        "footer",
        "card",
        "icon",
        "image",
        "video",
        "accessibility",
        "a11y",
    ];

    // Backend keywords
    const backendKeywords = [
        "api",
        "endpoint",
        "route",
        "server",
        "database",
        "query",
        "sql",
        "model",
        "schema",
        "migration",
        "authentication",
        "authorization",
        "middleware",
        "validation",
        "service",
        "controller",
        "repository",
        "orm",
        "rest",
        "graphql",
        "websocket",
        "cron",
        "job",
        "queue",
        "cache",
        "redis",
        "postgres",
        "mongo",
        "supabase",
    ];

    // Check for debugging indicators first (highest priority)
    const debuggingScore = debuggingKeywords.filter((keyword) =>
        promptLower.includes(keyword),
    ).length;

    if (debuggingScore >= 1) {
        return "debugging";
    }

    // Check frontend vs backend keywords
    let frontendScore = frontendKeywords.filter((keyword) =>
        promptLower.includes(keyword),
    ).length;
    let backendScore = backendKeywords.filter((keyword) =>
        promptLower.includes(keyword),
    ).length;

    // Analyze file extensions from selected component
    if (selectedComponent) {
        const ext = getFileExtension(selectedComponent.relativePath);
        if (isFrontendExtension(ext)) {
            frontendScore += 2; // Boost frontend score
        } else if (isBackendExtension(ext)) {
            backendScore += 2; // Boost backend score
        }
    }

    // Analyze codebase files if available
    if (codebaseFiles && codebaseFiles.length > 0) {
        const frontendFiles = codebaseFiles.filter((f) =>
            isFrontendExtension(getFileExtension(f.path)),
        ).length;
        const backendFiles = codebaseFiles.filter((f) =>
            isBackendExtension(getFileExtension(f.path)),
        ).length;

        if (frontendFiles > backendFiles) {
            frontendScore += 1;
        } else if (backendFiles > frontendFiles) {
            backendScore += 1;
        }
    }

    // Determine task type based on scores
    if (frontendScore > backendScore && frontendScore > 0) {
        return "frontend";
    } else if (backendScore > frontendScore && backendScore > 0) {
        return "backend";
    }

    // Default to general if no clear signal
    return "general";
}

function getFileExtension(filePath: string): string {
    const parts = filePath.split(".");
    return parts.length > 1 ? parts[parts.length - 1].toLowerCase() : "";
}

function isFrontendExtension(ext: string): boolean {
    const frontendExtensions = [
        "tsx",
        "jsx",
        "css",
        "scss",
        "sass",
        "less",
        "vue",
        "svelte",
        "html",
    ];
    return frontendExtensions.includes(ext);
}

function isBackendExtension(ext: string): boolean {
    const backendExtensions = ["ts", "js"];
    // More specific backend patterns
    const ext2 = ext;
    return (
        backendExtensions.includes(ext2) &&
        !["tsx", "jsx"].includes(ext2) // Exclude frontend TS/JS
    );
}
