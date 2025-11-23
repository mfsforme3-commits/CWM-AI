import * as path from "node:path";
import { Worker } from "node:worker_threads";

import { ProblemReport } from "../ipc_types";
import log from "electron-log";
import { WorkerInput, WorkerOutput } from "../../../shared/tsc_types";

import {
  getDyadDeleteTags,
  getDyadRenameTags,
  getDyadWriteTags,
} from "../utils/dyad_tag_parser";
import { getTypeScriptCachePath } from "@/paths/paths";

const logger = log.scope("tsc");

export async function generateProblemReport({
  fullResponse,
  appPath,
}: {
  fullResponse: string;
  appPath: string;
}): Promise<ProblemReport> {
  return new Promise((resolve, reject) => {
    // Determine the worker script path
    // In production/packaged app, it's likely adjacent to main.js or in a known location
    // When running with vite, it might be different.
    // Based on electron-forge + vite config, the worker should be built to .vite/build/tsc_worker.js
    // But __dirname in main process points to .vite/build usually.
    let workerPath = path.join(__dirname, "tsc_worker.js");

    // If we are in dev mode, we might need to adjust or it might just work if vite puts it there.
    // The error says: Cannot find module '/home/darsh/Downloads/dyad-main/.vite/build/tsc_worker.js'
    // This implies __dirname is correct, but the file isn't there.
    // We need to ensure vite.worker.config.mts builds it to the right place.
    // Let's try to be robust:
    if (process.env.NODE_ENV === 'development') {
      // In dev, it might be in a different spot if not built yet?
      // Actually, the previous error showed it WAS looking in .vite/build/tsc_worker.js
      // So the path logic is likely fine, but the file wasn't built/written there.
    }

    logger.info(`Starting TSC worker for app ${appPath}`);

    // Create the worker
    const worker = new Worker(workerPath);

    // Handle worker messages
    worker.on("message", (output: WorkerOutput) => {
      worker.terminate();

      if (output.success && output.data) {
        logger.info(`TSC worker completed successfully for app ${appPath}`);
        resolve(output.data);
      } else {
        logger.error(`TSC worker failed for app ${appPath}: ${output.error}`);
        reject(new Error(output.error || "Unknown worker error"));
      }
    });

    // Handle worker errors
    worker.on("error", (error) => {
      logger.error(`TSC worker error for app ${appPath}:`, error);
      worker.terminate();
      reject(error);
    });

    // Handle worker exit
    worker.on("exit", (code) => {
      if (code !== 0) {
        logger.error(`TSC worker exited with code ${code} for app ${appPath}`);
        reject(new Error(`Worker exited with code ${code}`));
      }
    });

    const writeTags = getDyadWriteTags(fullResponse);
    const renameTags = getDyadRenameTags(fullResponse);
    const deletePaths = getDyadDeleteTags(fullResponse);
    const virtualChanges = {
      deletePaths,
      renameTags,
      writeTags,
    };

    // Send input to worker
    const input: WorkerInput = {
      virtualChanges,
      appPath,
      tsBuildInfoCacheDir: getTypeScriptCachePath(),
    };

    logger.info(`Sending input to TSC worker for app ${appPath}`);

    worker.postMessage(input);
  });
}
