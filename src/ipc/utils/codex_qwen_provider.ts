import {
    LanguageModelV2,
    LanguageModelV2CallOptions,
    LanguageModelV2CallWarning,
    LanguageModelV2Content,
    LanguageModelV2FinishReason,
    LanguageModelV2StreamPart,
    LanguageModelV2Usage,
} from "@ai-sdk/provider";
import { spawn } from "child_process";
import { createRequire } from "module";
import path from "path";
import { join } from "path";

// Helper to resolve Codex CLI path
function resolveCodexPath(): string {
    try {
        const require = createRequire(import.meta.url);
        const pkgPath = require.resolve("@openai/codex/package.json");
        const root = pkgPath.replace(/package\.json$/, "");
        return join(root, "bin/codex.js");
    } catch {
        return "codex";
    }
}

// Helper to resolve Qwen CLI path
function resolveQwenPath(): string {
    try {
        const require = createRequire(import.meta.url);
        const pkgPath = require.resolve("@qwen-code/qwen-code/package.json");
        const pkgDir = path.dirname(pkgPath);
        const pkg = require(pkgPath);
        if (typeof pkg.bin === "string") {
            return path.join(pkgDir, pkg.bin);
        } else if (typeof pkg.bin === "object" && pkg.bin.qwen) {
            return path.join(pkgDir, pkg.bin.qwen);
        }
        return path.join(pkgDir, "cli.js");
    } catch {
        return "qwen";
    }
}

export class CodexQwenLanguageModel implements LanguageModelV2 {
    readonly specificationVersion = "v2";
    readonly provider = "codex-qwen-cli";
    readonly modelId: string;
    readonly supportedUrls = {};

    constructor(modelId: string) {
        this.modelId = modelId;
    }

    get defaultObjectGenerationMode() {
        return "json" as const;
    }

    async doGenerate(options: LanguageModelV2CallOptions) {
        const { stream } = await this.doStream(options);
        let text = "";
        let usage: LanguageModelV2Usage = {
            inputTokens: 0,
            outputTokens: 0,
            totalTokens: 0,
        };
        let finishReason: LanguageModelV2FinishReason = "stop";

        const reader = stream.getReader();
        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                if (value.type === "text-delta") {
                    text += value.delta;
                }
                if (value.type === "finish") {
                    usage = value.usage;
                    finishReason = value.finishReason;
                }
            }
        } finally {
            reader.releaseLock();
        }

        return {
            content: [{ type: "text", text }] as LanguageModelV2Content[],
            usage,
            finishReason,
            rawCall: {
                rawPrompt: options.prompt,
            },
            warnings: [] as LanguageModelV2CallWarning[],
        };
    }

    async doStream(
        options: LanguageModelV2CallOptions,
    ): Promise<{
        stream: ReadableStream<LanguageModelV2StreamPart>;
        warnings: LanguageModelV2CallWarning[];
    }> {
        let promptText = "";
        for (const msg of options.prompt) {
            if (msg.role === "user") {
                const content = msg.content
                    .map((c) => (c.type === "text" ? c.text : ""))
                    .join("");
                promptText += `User: ${content}\n`;
            } else if (msg.role === "assistant") {
                const content = msg.content
                    .map((c) => (c.type === "text" ? c.text : ""))
                    .join("");
                promptText += `Assistant: ${content}\n`;
            } else if (msg.role === "system") {
                promptText += `System: ${msg.content}\n`;
            }
        }

        const scriptPath = join(__dirname, "scripts", "integrate_agents.sh");
        const codexPath = resolveCodexPath();
        const qwenPath = resolveQwenPath();

        const env = {
            ...process.env,
            CODEX_BIN: codexPath,
            QWEN_BIN: qwenPath,
            CODEX_CMD: codexPath.endsWith(".js") ? "node" : "binary",
            CODEX_ARGS: codexPath.endsWith(".js") ? codexPath : "",
        };

        const child = spawn(scriptPath, [promptText], {
            env,
        });

        const stream = new ReadableStream<LanguageModelV2StreamPart>({
            start(controller) {
                child.stdout.on("data", (data) => {
                    const text = data.toString();
                    if (text) {
                        controller.enqueue({
                            type: "text-delta",
                            delta: text,
                            id: "codex-qwen-response",
                        });
                    }
                });

                child.stderr.on("data", (data) => {
                    console.error(`[Codex-Qwen Error]: ${data}`);
                });

                child.on("close", (code) => {
                    controller.enqueue({
                        type: "finish",
                        finishReason: code === 0 ? "stop" : "error",
                        usage: {
                            inputTokens: 0,
                            outputTokens: 0,
                            totalTokens: 0,
                        },
                    });
                    controller.close();
                });

                child.on("error", (err) => {
                    controller.error(err);
                });
            },
            cancel() {
                child.kill();
            },
        });

        return {
            stream,
            warnings: [],
        };
    }
}

export const createCodexQwenCli = () => {
    const provider = (modelId: string) => new CodexQwenLanguageModel(modelId);

    provider.languageModel = provider;
    provider.textEmbeddingModel = () => {
        throw new Error("Text embedding not supported");
    };
    provider.imageModel = () => {
        throw new Error("Image model not supported");
    };
    provider.chat = provider;

    return provider;
};
