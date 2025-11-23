import {
  LanguageModelV2,
} from "@ai-sdk/provider";
import { spawn } from "child_process";
import { createRequire } from "module";
import path from "path";

export interface QwenProviderSettings {
  /**
   * Path to the qwen executable. Defaults to resolved 'qwen' binary from @qwen-code/qwen-code.
   */
  qwenPath?: string;
}

function resolveQwenPath(): string {
  try {
    const require = createRequire(import.meta.url);
    const pkgPath = require.resolve("@qwen-code/qwen-code/package.json");
    const pkgDir = path.dirname(pkgPath);
    // Check package.json for bin
    const pkg = require(pkgPath);
    if (typeof pkg.bin === "string") {
      return path.join(pkgDir, pkg.bin);
    } else if (typeof pkg.bin === "object" && pkg.bin.qwen) {
      return path.join(pkgDir, pkg.bin.qwen);
    }
    // Fallback to assuming 'cli.js' or similar if bin not standard
    return path.join(pkgDir, "cli.js");
  } catch {
    // Fallback to global/path qwen
    return "qwen";
  }
}

export class QwenLanguageModel implements LanguageModelV2 {
  readonly specificationVersion = "v2";
  readonly provider = "qwen-code-cli";
  readonly modelId: string;
  
  // LanguageModelV2 required properties
  readonly supportsImageUrls = false;
  readonly supportsStructuredOutputs = false;
  readonly supportedUrls = {};

  constructor(
    modelId: string,
    private settings: QwenProviderSettings = {},
  ) {
    this.modelId = modelId;
  }

  get defaultObjectGenerationMode() {
    return "json" as const;
  }

  private buildArgs(options: any, qwenPath: string) {
    const { prompt } = options;
    
    // Construct the prompt string from the message history
    let promptString = "";
    for (const message of prompt) {
      if (message.role === "user") {
        promptString += `User: ${message.content.map((c: any) => c.text || "").join("")}\n`;
      } else if (message.role === "assistant") {
        promptString += `Assistant: ${message.content.map((c: any) => c.text || "").join("")}\n`;
      } else if (message.role === "system") {
        promptString += `System: ${message.content}\n`;
      }
    }

    const args = [
      "-p", promptString, 
      "--output-format", "json",
      "--allowed-tools", "run_shell_command,read_file,write_file,list_files,grep_search"
    ];
    return { cmd: qwenPath, args };
  }

  async doGenerate(options: any) {
    const qwenPath = this.settings.qwenPath || resolveQwenPath();
    const { cmd, args } = this.buildArgs(options, qwenPath);
    
    return new Promise<any>((resolve, reject) => {
      const child = spawn(cmd, args, {
        env: process.env,
      });

      let stdout = "";
      let stderr = "";

      child.stdout.on("data", (data) => {
        stdout += data.toString();
      });

      child.stderr.on("data", (data) => {
        stderr += data.toString();
      });

      child.on("close", (code) => {
        if (code !== 0) {
          reject(new Error(`Qwen CLI exited with code ${code}: ${stderr}`));
          return;
        }

        try {
          const result = JSON.parse(stdout);
          
          if (result.error) {
             reject(new Error(result.error.message || "Unknown Qwen CLI error"));
             return;
          }

          const candidate = result.candidates?.[0];
          const text = candidate?.content?.parts?.[0]?.text || "";
          
          resolve({
            text,
            finishReason: candidate?.finishReason?.toLowerCase() || "stop",
            usage: {
              promptTokens: result.usageMetadata?.promptTokenCount || 0,
              completionTokens: result.usageMetadata?.candidatesTokenCount || 0,
            },
            rawCall: { stdout, stderr },
          });
        } catch (e) {
          // @ts-ignore
          reject(new Error(`Failed to parse Qwen CLI output: ${e.message}\nOutput: ${stdout}`));
        }
      });
      
      child.on("error", (err) => {
        reject(err);
      });
    });
  }

  async doStream(options: any) {
    // Simulate streaming by awaiting full response and emitting it as a single chunk
    // This avoids "Streaming not supported" error while respecting CLI limitations
    const fullResponse = await this.doGenerate(options);
    
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue({
          type: "stream-start",
        });
        
        if (fullResponse.text) {
          controller.enqueue({
            type: "text-delta",
            textDelta: fullResponse.text,
          });
        }
        
        controller.enqueue({
          type: "finish",
          finishReason: fullResponse.finishReason,
          usage: fullResponse.usage,
        });
        
        controller.close();
      }
    });

    return {
      stream,
      rawCall: fullResponse.rawCall,
    };
  }
}

export function createQwenProvider(options: QwenProviderSettings = {}) {
  const createModel = (modelId: string) =>
    new QwenLanguageModel(modelId, options);

  const provider = function (modelId: string) {
    return createModel(modelId);
  };

  provider.languageModel = createModel;
  return provider;
}
