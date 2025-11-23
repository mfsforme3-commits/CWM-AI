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
import { StringDecoder } from "string_decoder";

interface QwenCodeCliSettings {
  /**
   * Path to the Qwen CLI executable. Defaults to 'qwen'.
   */
  command?: string;
  /**
   * Arguments to pass to the Qwen CLI.
   */
  args?: string[];
  /**
   * Working directory for the Qwen CLI process.
   */
  cwd?: string;
}

export class QwenCodeCliLanguageModel implements LanguageModelV2 {
  readonly specificationVersion = "v2";
  readonly provider = "qwen-code-cli";
  readonly modelId: string;
  readonly settings: QwenCodeCliSettings;

  // Required by LanguageModelV2
  readonly supportedUrls = {};

  constructor(modelId: string, settings: QwenCodeCliSettings = {}) {
    this.modelId = modelId;
    this.settings = settings;
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
        rawSettings: this.settings,
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
    const command = this.settings.command || "qwen";

    let promptText = "";
    for (const msg of options.prompt) {
      if (msg.role === 'user') {
        const content = Array.isArray(msg.content)
          ? msg.content.map(c => c.type === 'text' ? c.text : '').join('')
          : (typeof msg.content === 'string' ? msg.content : '');
        promptText += `User: ${content}\n`;
      } else if (msg.role === 'assistant') {
        const content = Array.isArray(msg.content)
          ? msg.content.map(c => c.type === 'text' ? c.text : '').join('')
          : (typeof msg.content === 'string' ? msg.content : '');
        promptText += `Assistant: ${content}\n`;
      } else if (msg.role === 'system') {
        const content = typeof msg.content === 'string' ? msg.content : '';
        promptText += `System: ${content}\n`;
      }
    }

    const args = [...(this.settings.args || []), "--approval-mode", "plan", "-o", "json"];

    const child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
      cwd: this.settings.cwd,
    });

    child.stdin.write(promptText);
    child.stdin.end();

    const stream = new ReadableStream<LanguageModelV2StreamPart>({
      start(controller) {
        let stdout = "";
        let stderr = "";

        child.stdout.on("data", (data) => {
          stdout += data.toString();
        });

        child.stderr.on("data", (data) => {
          stderr += data.toString();
          console.error(`[Qwen CLI Error]: ${data}`);
        });

        child.on("close", (code) => {
          if (code !== 0) {
            // Check if it's a file-not-found tool error
            if (stderr.includes("FatalToolExecutionError") && stderr.includes("File not found")) {
              // Log as warning but still try to parse response
              console.warn(`[Qwen CLI Warning]: Tool execution failed (file not found), but continuing: ${stderr}`);

              // Try to extract any partial response
              try {
                const result = JSON.parse(stdout);
                const responseText = result.response || "";

                if (responseText) {
                  controller.enqueue({
                    type: "text-delta",
                    delta: responseText,
                    id: "qwen-cli-response",
                  });
                }
              } catch (e) {
                // If no response available, provide a helpful error
                controller.error(new Error(`Qwen CLI encountered file access issues. The AI tried to read files that don't exist in your project.`));
                return;
              }

              controller.enqueue({
                type: "finish",
                finishReason: "stop",
                usage: {
                  inputTokens: 0,
                  outputTokens: 0,
                  totalTokens: 0,
                },
              });
              controller.close();
              return;
            }

            controller.error(new Error(`Qwen CLI exited with code ${code}: ${stderr}`));
            return;
          }

          try {
            const result = JSON.parse(stdout);
            const responseText = result.response || "";

            if (responseText) {
              controller.enqueue({
                type: "text-delta",
                delta: responseText,
                id: "qwen-cli-response",
              });
            }

            controller.enqueue({
              type: "finish",
              finishReason: "stop",
              usage: {
                inputTokens: 0,
                outputTokens: 0,
                totalTokens: 0,
              },
            });
            controller.close();
          } catch (e) {
            controller.error(new Error(`Failed to parse Qwen CLI output: ${e}`));
          }
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

export const createQwenCodeCli = (
  options: { defaultSettings?: QwenCodeCliSettings } = {},
) => {
  const provider = (modelId: string, settings?: QwenCodeCliSettings) =>
    new QwenCodeCliLanguageModel(modelId, {
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
