import log from "electron-log";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { WorkflowStep } from "../workflow/workflow_manager";

const logger = log.scope("guardrail_logger");

// Directory for storing guardrail violation logs
const LOGS_DIR = path.join(os.homedir(), ".dyad", "guardrail-logs");

export interface ViolationLog {
    timestamp: Date;
    chatId: number;
    violationType: string;
    mode: string;
    workflowStep?: string;
    model: string;
    provider: string;
    context: string; // Snippet showing the violation
}

interface ViolationStats {
    total: number;
    byType: Record<string, number>;
    byMode: Record<string, number>;
    byModel: Record<string, number>;
}

/**
 * Ensures the logs directory exists
 */
function ensureLogsDir(): void {
    if (!fs.existsSync(LOGS_DIR)) {
        fs.mkdirSync(LOGS_DIR, { recursive: true });
    }
}

/**
 * Gets the current log file path (one file per day)
 */
function getCurrentLogFile(): string {
    const today = new Date().toISOString().split("T")[0]; // YYYY-MM-DD
    return path.join(LOGS_DIR, `violations-${today}.jsonl`);
}

/**
 * Logs a guardrail violation to a file
 */
export function logViolation(violation: ViolationLog): void {
    try {
        ensureLogsDir();
        const logFilePath = getCurrentLogFile();

        const logEntry = JSON.stringify({
            ...violation,
            timestamp: violation.timestamp.toISOString(),
        }) + "\n";

        fs.appendFileSync(logFilePath, logEntry, "utf8");

        logger.info("Logged guardrail violation:", {
            type: violation.violationType,
            mode: violation.mode,
            model: violation.model,
        });
    } catch (error) {
        logger.error("Failed to log guardrail violation:", error);
    }
}

/**
 * Reads all violation logs from a specific date range
 */
export function getViolationLogs(
    startDate?: Date,
    endDate?: Date
): ViolationLog[] {
    const logs: ViolationLog[] = [];

    try {
        ensureLogsDir();

        // Get all log files in the directory
        const files = fs.readdirSync(LOGS_DIR);
        const logFiles = files.filter((f) => f.startsWith("violations-") && f.endsWith(".jsonl"));

        for (const file of logFiles) {
            const filePath = path.join(LOGS_DIR, file);
            const content = fs.readFileSync(filePath, "utf8");
            const lines = content.split("\n").filter((line) => line.trim());

            for (const line of lines) {
                try {
                    const parsed = JSON.parse(line);
                    const logEntry: ViolationLog = {
                        ...parsed,
                        timestamp: new Date(parsed.timestamp),
                    };

                    // Filter by date range if provided
                    if (startDate && logEntry.timestamp < startDate) continue;
                    if (endDate && logEntry.timestamp > endDate) continue;

                    logs.push(logEntry);
                } catch (parseError) {
                    logger.warn("Failed to parse log line:", parseError);
                }
            }
        }
    } catch (error) {
        logger.error("Failed to read violation logs:", error);
    }

    return logs;
}

/**
 * Get aggregated statistics about violations
 */
export function getViolationStats(startDate?: Date, endDate?: Date): ViolationStats {
    const logs = getViolationLogs(startDate, endDate);

    const stats: ViolationStats = {
        total: logs.length,
        byType: {},
        byMode: {},
        byModel: {},
    };

    for (const log of logs) {
        // Count by type
        stats.byType[log.violationType] = (stats.byType[log.violationType] || 0) + 1;

        // Count by mode
        const modeKey = log.workflowStep ? `${log.mode}:${log.workflowStep}` : log.mode;
        stats.byMode[modeKey] = (stats.byMode[modeKey] || 0) + 1;

        // Count by model
        stats.byModel[log.model] = (stats.byModel[log.model] || 0) + 1;
    }

    return stats;
}

/**
 * Get the top N most common violations
 */
export function getTopViolations(limit: number = 10): Array<{
    type: string;
    count: number;
    percentage: number;
}> {
    const stats = getViolationStats();

    const violations = Object.entries(stats.byType).map(([type, count]) => ({
        type,
        count,
        percentage: stats.total > 0 ? (count / stats.total) * 100 : 0,
    }));

    return violations
        .sort((a, b) => b.count - a.count)
        .slice(0, limit);
}

/**
 * Export a detailed violation report
 */
export function exportViolationReport(): string {
    const last7Days = new Date();
    last7Days.setDate(last7Days.getDate() - 7);

    const stats = getViolationStats(last7Days);
    const topViolations = getTopViolations(5);

    let report = "# Guardrail Violation Report (Last 7 Days)\n\n";
    report += `Total Violations: ${stats.total}\n\n`;

    report += "## Top Violations\n";
    for (const violation of topViolations) {
        report += `- ${violation.type}: ${violation.count} (${violation.percentage.toFixed(1)}%)\n`;
    }

    report += "\n## Violations by Mode\n";
    for (const [mode, count] of Object.entries(stats.byMode).sort((a, b) => b[1] - a[1])) {
        report += `- ${mode}: ${count}\n`;
    }

    report += "\n## Violations by Model\n";
    for (const [model, count] of Object.entries(stats.byModel).sort((a, b) => b[1] - a[1])) {
        report += `- ${model}: ${count}\n`;
    }

    return report;
}
