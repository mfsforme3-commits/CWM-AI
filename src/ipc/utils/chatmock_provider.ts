import {
  LanguageModelV2,
  LanguageModelV2CallOptions,
  LanguageModelV2CallWarning,
  LanguageModelV2StreamPart,
} from "@ai-sdk/provider";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { spawn } from "child_process";
import { existsSync, mkdirSync } from "fs";
import { getUserDataPath } from "../../paths/paths";
import log from "electron-log";
import { join } from "path";

const logger = log.scope("chatmock-provider");

const CHATMOCK_REPO_URL = "https://github.com/RayBytes/ChatMock.git";
const CHATMOCK_DIR_NAME = "chatmock";
const CHATMOCK_PORT = 8000;
const CHATMOCK_BASE_URL = `http://127.0.0.1:${CHATMOCK_PORT}/v1`;

interface ChatMockProviderSettings {
  /**
   * Whether to force re-install/update.
   */
  forceUpdate?: boolean;
}

export class ChatMockLanguageModel implements LanguageModelV2 {
  readonly specificationVersion = "v2";
  readonly provider = "chatmock";
  readonly modelId: string;
  readonly settings: ChatMockProviderSettings;

  // Required by LanguageModelV2
  readonly supportedUrls = {};
  // Delegate to the OpenAI Compatible provider once initialized
  private delegate?: LanguageModelV2;

  constructor(modelId: string, settings: ChatMockProviderSettings = {}) {
    this.modelId = modelId;
    this.settings = settings;
  }

  get defaultObjectGenerationMode() {
    return "json" as const;
  }

  private async ensureChatMockSetup(): Promise<void> {
    const userDataPath = getUserDataPath();
    const chatMockDir = join(userDataPath, CHATMOCK_DIR_NAME);
    const chatMockScript = join(chatMockDir, "chatmock.py");

    // 1. Check if installed
    if (!existsSync(chatMockDir) || !existsSync(chatMockScript)) {
      logger.info("ChatMock not found. Installing...");
      await this.installChatMock(userDataPath);
    }

    // 2. Check if requirements installed (naive check: assume if dir exists, we tried installing)
    // In a real scenario, we might want a flag or file to confirm installation success.

    // 3. Check if running
    const isRunning = await this.isServerRunning();
    if (!isRunning) {
      logger.info("ChatMock server not running. Starting...");
      await this.startServer(chatMockDir);
    }

    // 4. Check auth status (optional but good for UX)
    // We can't easily check auth without making a request. We'll let the delegate handle 401/403.
  }

  private async installChatMock(cwd: string) {
    return new Promise<void>((resolve, reject) => {
      if (!existsSync(cwd)) {
        mkdirSync(cwd, { recursive: true });
      }
      
      const git = spawn("git", ["clone", CHATMOCK_REPO_URL, CHATMOCK_DIR_NAME], {
        cwd,
        stdio: "ignore", // or 'pipe' if we want logs
      });

      git.on("close", (code) => {
        if (code !== 0) {
          reject(new Error(`Failed to clone ChatMock repo. Exit code: ${code}`));
          return;
        }
        
        // Install requirements
        const chatMockDir = join(cwd, CHATMOCK_DIR_NAME);
        const pip = spawn("pip", ["install", "-r", "requirements.txt"], {
          cwd: chatMockDir,
          stdio: "ignore",
        });

        pip.on("close", (pipCode) => {
          if (pipCode !== 0) {
            reject(new Error(`Failed to install ChatMock requirements. Exit code: ${pipCode}`));
            return;
          }
          resolve();
        });
      });
    });
  }

  private async isServerRunning(): Promise<boolean> {
    try {
      // Try /health endpoint (base URL without /v1)
      const healthUrl = `${CHATMOCK_BASE_URL.replace('/v1', '')}/health`;
      const response = await fetch(healthUrl, {
          method: 'GET'
      }).catch(() => null);
      
      if (response && response.ok) {
          return true;
      }

      // Fallback: try /v1/models
      // We accept 401/403 as "running" because it means the server is there but just needs auth
      const models = await fetch(`${CHATMOCK_BASE_URL}/models`, { method: 'GET' }).catch(() => null);
      return !!models && (models.ok || models.status === 401 || models.status === 403); 
    } catch {
      return false;
    }
  }

  private async startServer(cwd: string): Promise<void> {
    const child = spawn("python", ["chatmock.py", "serve"], {
      cwd,
      detached: true, // Let it run independently
      stdio: "ignore",
    });
    
    child.unref();

    // Wait a bit for it to start
    let attempts = 0;
    while (attempts < 10) {
      await new Promise(r => setTimeout(r, 1000));
      if (await this.isServerRunning()) {
        return;
      }
      attempts++;
    }
    throw new Error("Timed out waiting for ChatMock server to start. Please run `python chatmock.py serve` manually in " + cwd + " to debug.");
  }

  private async getDelegate(): Promise<LanguageModelV2> {
    if (this.delegate) return this.delegate;

    await this.ensureChatMockSetup();

    // Create delegate
    const provider = createOpenAICompatible({
      name: "chatmock",
      baseURL: CHATMOCK_BASE_URL,
      apiKey: "dummy", // ChatMock likely doesn't enforce a specific key, or uses internal auth
    });
    
    this.delegate = provider(this.modelId);
    return this.delegate;
  }

  async doGenerate(options: LanguageModelV2CallOptions) {
    try {
        const delegate = await this.getDelegate();
        return await delegate.doGenerate(options);
    } catch (error: any) {
        this.handleError(error);
        throw error; // Unreachable
    }
  }

  async doStream(
    options: LanguageModelV2CallOptions,
  ): Promise<{
    stream: ReadableStream<LanguageModelV2StreamPart>;
    warnings: LanguageModelV2CallWarning[];
  }> {
    try {
        const delegate = await this.getDelegate();
        const result = await delegate.doStream(options);
        // The delegate (OpenAI compatible) might return an object that doesn't strictly have warnings typed in the overlap,
        // or the type definition in this repo is strict. 
        // We cast or assume empty warnings if missing.
        return {
          stream: result.stream,
          warnings: (result as any).warnings ?? [],
        };
    } catch (error: any) {
        this.handleError(error);
        throw error; // Unreachable
    }
  }

  private handleError(error: any): never {
    // Detect if it's an auth error or connection error and give helpful instructions
    const msg = error.message || "";
    const userDataPath = getUserDataPath();
    const chatMockDir = join(userDataPath, CHATMOCK_DIR_NAME);

    if (msg.includes("ECONNREFUSED") || msg.includes("fetch failed")) {
        throw new Error(
            `Could not connect to ChatMock server. \n` +
            `It seems the installation is present at: ${chatMockDir}\n` +
            `Please verify it is running. You can try running: \n` +
            `cd "${chatMockDir}" && python chatmock.py serve`
        );
    }

    if (msg.includes("401") || msg.includes("403") || msg.includes("unauthorized")) {
        throw new Error(
            `ChatMock Authorization Failed. \n` +
            `You need to login with your ChatGPT account. \n` +
            `Please open a terminal and run: \n` +
            `cd "${chatMockDir}" && python chatmock.py login`
        );
    }

    throw error;
  }
}

export const createChatMockProvider = (
  options: { defaultSettings?: ChatMockProviderSettings } = {},
) => {
  const provider = (modelId: string, settings?: ChatMockProviderSettings) =>
    new ChatMockLanguageModel(modelId, {
      ...options.defaultSettings,
      ...settings,
    });

  provider.languageModel = provider;
  provider.textEmbeddingModel = () => {
    throw new Error("Text embedding not supported");
  };
  provider.imageModel = () => {
    throw new Error("Image model not supported");
  }
  provider.chat = provider;

  return provider;
};
