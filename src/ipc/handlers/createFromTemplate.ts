import path from "path";
import fs from "fs-extra";
import git from "isomorphic-git";
import http from "isomorphic-git/http/node";
import { app } from "electron";
import { copyDirectoryRecursive } from "../utils/file_utils";
import { readSettings } from "@/main/settings";
import { getTemplateOrThrow } from "../utils/template_utils";
import log from "electron-log";

const logger = log.scope("createFromTemplate");
const FLUTTER_AI_RULES = `# Tech Stack
- Build everything with Flutter (Dart). Follow the standard project layout that \`flutter create .\` generates.
- Keep widgets and shared logic inside the \`lib/\` directory. The entry point must remain in \`lib/main.dart\`.
- Compose UI with Material 3 widgets. Use \`ThemeData\` for colors/typography and create reusable widgets for shared layouts.
- Manage dependencies through \`pubspec.yaml\`. Add packages with \`flutter pub add <package>\` and run \`flutter pub get\` when it changes.
- Store local fonts/images under \`assets/\` and declare them in \`pubspec.yaml\`.
- Prefer declarative navigation APIs (\`Navigator\`, \`Router\`, or packages like \`go_router\` once added) for multi-page flows.
- Keep platform-specific code in the respective \`android/\`, \`ios/\`, or \`web/\` folders only when absolutely necessary.
- Before writing app code, ensure the Flutter scaffold exists (run \`flutter create .\` in the workspace root if files like \`lib/main.dart\` or \`pubspec.yaml\` are missing).
`;
const FLUTTER_README = `# Flutter Workspace

This template starts empty so you can decide how to structure your Flutter app. Follow these steps before writing application code:

1. **Initialize the project**
   - Run \`flutter create .\` inside this folder. This generates the standard Flutter file layout (lib/, android/, ios/, etc.).
2. **Install dependencies**
   - After editing \`pubspec.yaml\`, run \`flutter pub get\` to install packages.
3. **Run the app on a device or emulator**
   - Use \`flutter devices\` to list available targets.
   - Start the app with \`flutter run -d <device_id>\` (examples: \`-d linux\`, \`-d windows\`, \`-d macos\`, \`-d chrome\`, or an Android/iOS device ID).
4. **Rebuild after code changes**
   - Stop the current run with \`q\` in the terminal, then run the command again with the desired \`-d\` target.

These commands can be triggered directly from Dyad using <dyad-run-command> tags. For common Flutter commands (create, pub get, run), set \`autorun="true"\` so they execute automatically.`;

export async function createFromTemplate({
  fullAppPath,
}: {
  fullAppPath: string;
}) {
  const settings = readSettings();
  const templateId = settings.selectedTemplateId;

  if (templateId === "react") {
    await copyDirectoryRecursive(
      path.join(__dirname, "..", "..", "scaffold"),
      fullAppPath,
    );
    return;
  }

  const template = await getTemplateOrThrow(templateId);
  if (!template.githubUrl) {
    logger.info(
      `Template ${templateId} does not provide a GitHub source. Creating an empty project directory instead.`,
    );
    await fs.ensureDir(fullAppPath);
    await ensureFlutterAiRules(fullAppPath);
    await ensureFlutterReadme(fullAppPath);
    return;
  }
  const repoCachePath = await cloneRepo(template.githubUrl);
  await copyRepoToApp(repoCachePath, fullAppPath);
}

async function ensureFlutterAiRules(appPath: string) {
  const aiRulesPath = path.join(appPath, "AI_RULES.md");
  if (await fs.pathExists(aiRulesPath)) {
    return;
  }
  await fs.writeFile(aiRulesPath, `${FLUTTER_AI_RULES.trim()}\n`, "utf8");
}

async function ensureFlutterReadme(appPath: string) {
  const readmePath = path.join(appPath, "README.md");
  if (await fs.pathExists(readmePath)) {
    return;
  }
  await fs.writeFile(readmePath, `${FLUTTER_README.trim()}\n`, "utf8");
}

async function cloneRepo(repoUrl: string): Promise<string> {
  let orgName: string;
  let repoName: string;

  const url = new URL(repoUrl);
  if (url.protocol !== "https:") {
    throw new Error("Repository URL must use HTTPS.");
  }
  if (url.hostname !== "github.com") {
    throw new Error("Repository URL must be a github.com URL.");
  }

  // Pathname will be like "/org/repo" or "/org/repo.git"
  const pathParts = url.pathname.split("/").filter((part) => part.length > 0);

  if (pathParts.length !== 2) {
    throw new Error(
      "Invalid repository URL format. Expected 'https://github.com/org/repo'",
    );
  }

  orgName = pathParts[0];
  repoName = path.basename(pathParts[1], ".git"); // Remove .git suffix if present

  if (!orgName || !repoName) {
    // This case should ideally be caught by pathParts.length !== 2
    throw new Error(
      "Failed to parse organization or repository name from URL.",
    );
  }
  logger.info(`Parsed org: ${orgName}, repo: ${repoName} from ${repoUrl}`);

  const cachePath = path.join(
    app.getPath("userData"),
    "templates",
    orgName,
    repoName,
  );

  if (fs.existsSync(cachePath)) {
    try {
      logger.info(
        `Repo ${repoName} already exists in cache at ${cachePath}. Checking for updates.`,
      );

      // Construct GitHub API URL
      const apiUrl = `https://api.github.com/repos/${orgName}/${repoName}/commits/HEAD`;
      logger.info(`Fetching remote SHA from ${apiUrl}`);

      let remoteSha: string | undefined;

      const response = await http.request({
        url: apiUrl,
        method: "GET",
        headers: {
          "User-Agent": "Dyad", // GitHub API requires a User-Agent
          Accept: "application/vnd.github.v3+json",
        },
      });

      if (response.statusCode === 200 && response.body) {
        // Convert AsyncIterableIterator<Uint8Array> to string
        const chunks: Uint8Array[] = [];
        for await (const chunk of response.body) {
          chunks.push(chunk);
        }
        const responseBodyStr = Buffer.concat(chunks).toString("utf8");
        const commitData = JSON.parse(responseBodyStr);
        remoteSha = commitData.sha;
        if (!remoteSha) {
          throw new Error("SHA not found in GitHub API response.");
        }
        logger.info(`Successfully fetched remote SHA: ${remoteSha}`);
      } else {
        throw new Error(
          `GitHub API request failed with status ${response.statusCode}: ${response.statusMessage}`,
        );
      }

      const localSha = await git.resolveRef({
        fs,
        dir: cachePath,
        ref: "HEAD",
      });

      if (remoteSha === localSha) {
        logger.info(
          `Local cache for ${repoName} is up to date (SHA: ${localSha}). Skipping clone.`,
        );
        return cachePath;
      } else {
        logger.info(
          `Local cache for ${repoName} (SHA: ${localSha}) is outdated (Remote SHA: ${remoteSha}). Removing and re-cloning.`,
        );
        fs.rmSync(cachePath, { recursive: true, force: true });
        // Proceed to clone
      }
    } catch (err) {
      logger.warn(
        `Error checking for updates or comparing SHAs for ${repoName} at ${cachePath}. Will attempt to re-clone. Error: `,
        err,
      );
      return cachePath;
    }
  }

  fs.ensureDirSync(path.dirname(cachePath));

  logger.info(`Cloning ${repoUrl} to ${cachePath}`);
  try {
    await git.clone({
      fs,
      http,
      dir: cachePath,
      url: repoUrl,
      singleBranch: true,
      depth: 1,
    });
    logger.info(`Successfully cloned ${repoUrl} to ${cachePath}`);
  } catch (err) {
    logger.error(`Failed to clone ${repoUrl} to ${cachePath}: `, err);
    throw err; // Re-throw the error after logging
  }
  return cachePath;
}

async function copyRepoToApp(repoCachePath: string, appPath: string) {
  logger.info(`Copying from ${repoCachePath} to ${appPath}`);
  try {
    await fs.copy(repoCachePath, appPath, {
      filter: (src, _dest) => {
        const excludedDirs = ["node_modules", ".git"];
        const relativeSrc = path.relative(repoCachePath, src);
        if (excludedDirs.includes(path.basename(relativeSrc))) {
          logger.info(`Excluding ${src} from copy`);
          return false;
        }
        return true;
      },
    });
    logger.info("Finished copying repository contents.");
  } catch (err) {
    logger.error(
      `Error copying repository from ${repoCachePath} to ${appPath}: `,
      err,
    );
    throw err; // Re-throw the error after logging
  }
}
