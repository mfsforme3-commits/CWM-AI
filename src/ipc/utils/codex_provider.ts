import {
  LanguageModelV2,
} from "@ai-sdk/provider";
import { spawn } from "child_process";
import { createRequire } from "module";
import { mkdtempSync, rmSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// Helper to resolve Codex CLI path
function resolveCodexPath(explicitPath?: string): { cmd: string; args: string[] } {
  if (explicitPath) return { cmd: "node", args: [explicitPath] };
  try {
    const require = createRequire(import.meta.url);
    const pkgPath = require.resolve("@openai/codex/package.json");
    const root = pkgPath.replace(/package\.json$/, "");
    return { cmd: "node", args: [root + "bin/codex.js"] };
  } catch {
    return { cmd: "codex", args: [] };
  }
}

export class CodexCliLanguageModel implements LanguageModelV2 {
  readonly specificationVersion = "v2";
  readonly provider = "codex-cli";
  readonly modelId: string;
  
  readonly supportsImageUrls = false;
  readonly supportsStructuredOutputs = true;
  readonly supportedUrls = {};

  constructor(modelId: string, private settings: any = {}) {
    this.modelId = modelId;
  }

  get defaultObjectGenerationMode() {
    return "json" as const;
  }

  private buildArgs(promptText: string) {
    const base = resolveCodexPath(this.settings.codexPath);
    const args = [...base.args, "exec", "--experimental-json"];
    
    // Basic settings mapping
    if (this.settings.approvalMode) args.push("-c", `approval_policy=${this.settings.approvalMode}`);
    args.push("-c", "sandbox_mode=workspace-write"); // Default for this integration
    
    if (this.modelId) args.push("-m", this.modelId);
    
    // Handle temp file for last message if needed
    const dir = mkdtempSync(join(tmpdir(), "codex-cli-"));
    const lastMessagePath = join(dir, "last-message.txt");
    args.push("--output-last-message", lastMessagePath);
    
    args.push(promptText);
    
    return {
      cmd: base.cmd,
      args,
      env: process.env,
      cwd: this.settings.cwd,
      lastMessagePath,
      dir,
    };
  }

  private generatePromptText(options: any): string {
    if (!options?.prompt || !Array.isArray(options.prompt)) {
      return "";
    }
    return options.prompt
      .map((p: any) => {
        if (!p || !p.content) return "";
        if (p.role === "user") {
            const textContent = Array.isArray(p.content) 
                ? p.content.filter((c: any) => c && c.type === "text").map((c: any) => c.text || "").join("\n")
                : (typeof p.content === "string" ? p.content : "");
            return `Human: ${textContent}`;
        }
        if (p.role === "assistant") {
            const textContent = Array.isArray(p.content) 
                ? p.content.filter((c: any) => c && c.type === "text").map((c: any) => c.text || "").join("\n")
                : (typeof p.content === "string" ? p.content : "");
            return `Assistant: ${textContent}`;
        }
        if (p.role === "system") {
            return typeof p.content === "string" ? p.content : "";
        }
        return "";
      })
      .join("\n\n");
  }

  async doGenerate(options: any) {
    const promptText = this.generatePromptText(options);
    const { cmd, args, env, cwd, lastMessagePath, dir } = this.buildArgs(promptText);
    
    return new Promise<any>((resolve, reject) => {
      const child = spawn(cmd, args, {
        env,
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      let text = "";
      let usage = { promptTokens: 0, completionTokens: 0 };

      child.stdout.on("data", (chunk) => {
        const lines = chunk.toString().split(/\r?\n/).filter(Boolean);
        for (const line of lines) {
          try {
            const event = JSON.parse(line);
            if (event.type === "turn.completed" && event.usage) {
                usage.promptTokens = event.usage.input_tokens || 0;
                usage.completionTokens = event.usage.output_tokens || 0;
            }
            if (event.type === "item.completed" && event.item?.type === "assistant_message" && typeof event.item.text === "string") {
                text = event.item.text;
            }
          } catch {}
        }
      });

      child.stderr.on("data", (d) => stderr += d.toString());

      child.on("close", (code) => {
        try { rmSync(dir, { recursive: true, force: true }); } catch {}
        
        if (code !== 0) {
          reject(new Error(`Codex CLI exited with code ${code}: ${stderr}`));
          return;
        }
        
        if (!text && lastMessagePath) {
            try { text = readFileSync(lastMessagePath, "utf-8").trim(); } catch {}
        }

        resolve({
          text: text || "",
          finishReason: "stop",
          usage,
          rawCall: { stdout, stderr }
        });
      });
      
      child.on("error", (err) => {
        try { rmSync(dir, { recursive: true, force: true }); } catch {}
        reject(err);
      });
    });
  }

  async doStream(options: any) {
    const promptText = this.generatePromptText(options);
    const { cmd, args, env, cwd, lastMessagePath, dir } = this.buildArgs(promptText);
    
    const stream = new ReadableStream({
      start(controller) {
        const child = spawn(cmd, args, {
          env,
          cwd,
          stdio: ["ignore", "pipe", "pipe"],
        });
        let stderr = "";
        
        controller.enqueue({ type: "stream-start" });

        child.stdout.on("data", (_chunk) => {
          // Parsing logic (simplified for now as CLI seems to emit full text mostly)
        });

        child.stderr.on("data", (d) => stderr += d.toString());

        child.on("close", (code) => {
            let text = "";
            if (lastMessagePath) {
                try { text = readFileSync(lastMessagePath, "utf-8").trim(); } catch {}
            }
            try { rmSync(dir, { recursive: true, force: true }); } catch {}

            if (code !== 0) {
                controller.error(new Error(`Codex CLI exited with code ${code}: ${stderr}`));
                return;
            }

            if (text) {
                controller.enqueue({ type: "text-delta", textDelta: text });
            }
            
            controller.enqueue({
                type: "finish",
                finishReason: "stop",
                usage: { promptTokens: 0, completionTokens: 0 } // Simplified usage
            });
            controller.close();
        });
        
        child.on("error", (err) => {
            try { rmSync(dir, { recursive: true, force: true }); } catch {}
            controller.error(err);
        });
      }
    });

    return { stream, rawCall: { rawPrompt: promptText, rawSettings: this.settings } };
  }
}

export function createCodexCli(options: any = {}) {
  const createModel = (modelId: string) =>
    new CodexCliLanguageModel(modelId, options);

  const provider = function (modelId: string) {
    return createModel(modelId);
  };

  provider.languageModel = createModel;
  return provider;
}
