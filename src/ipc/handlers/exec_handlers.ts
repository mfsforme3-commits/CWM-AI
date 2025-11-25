import { exec } from "node:child_process";
import log from "electron-log";
import { createLoggedHandler } from "./safe_handle";
import { db } from "../../db";
import { apps } from "../../db/schema";
import { eq } from "drizzle-orm";
import { getDyadAppPath } from "../../paths/paths";
import util from "util";

const execAsync = util.promisify(exec);
const logger = log.scope("exec_handlers");
const handle = createLoggedHandler(logger);

export function registerExecHandlers() {
    handle(
        "exec-command",
        async (
            _event,
            { appId, command }: { appId: number; command: string },
        ): Promise<{ stdout: string; stderr: string; exitCode: number }> => {
            if (!command) {
                throw new Error("No command provided.");
            }

            const app = await db.query.apps.findFirst({
                where: eq(apps.id, appId),
            });

            if (!app) {
                throw new Error("App not found");
            }

            const appPath = getDyadAppPath(app.path);
            logger.log(`Executing command for app ${appId}: ${command}`);

            try {
                const { stdout, stderr } = await execAsync(command, {
                    cwd: appPath,
                    maxBuffer: 10 * 1024 * 1024, // 10MB buffer
                });

                return {
                    stdout: stdout.trim(),
                    stderr: stderr.trim(),
                    exitCode: 0,
                };
            } catch (error: any) {
                // exec throws an error if exit code is non-zero
                return {
                    stdout: error.stdout?.toString().trim() || "",
                    stderr: error.stderr?.toString().trim() || error.message,
                    exitCode: error.code || 1,
                };
            }
        },
    );
}
