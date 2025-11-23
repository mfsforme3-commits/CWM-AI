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
            const content = msg.content.map(c => c.type === 'text' ? c.text : '').join('');
            promptText += `User: ${content}\n`;
        } else if (msg.role === 'assistant') {
            const content = msg.content.map(c => c.type === 'text' ? c.text : '').join('');
            promptText += `Assistant: ${content}\n`;
        } else if (msg.role === 'system') {
            promptText += `System: ${msg.content}\n`;
        }
    }
    
    const args = [...(this.settings.args || []), "chat", "--stream"];

    const child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });

    child.stdin.write(promptText);
    child.stdin.end();

    const stream = new ReadableStream<LanguageModelV2StreamPart>({
      start(controller) {
        const decoder = new StringDecoder("utf8");

        child.stdout.on("data", (data) => {
          const text = decoder.write(data);
          if (text) {
            controller.enqueue({
              type: "text-delta",
              delta: text,
              id: "qwen-cli-response", // Mock ID
            });
          }
        });

        child.stderr.on("data", (data) => {
          console.error(`[Qwen CLI Error]: ${data}`);
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
