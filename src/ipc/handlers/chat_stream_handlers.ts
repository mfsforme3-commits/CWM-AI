import { v4 as uuidv4 } from "uuid";
import { ipcMain, IpcMainInvokeEvent } from "electron";
import {
  ModelMessage,
  TextPart,
  ImagePart,
  streamText,
  ToolSet,
  TextStreamPart,
  stepCountIs,
  hasToolCall,
} from "ai";

import { db } from "../../db";
import { chats, messages } from "../../db/schema";
import { and, eq, isNull } from "drizzle-orm";
import {
  constructSystemPrompt,
  readAiRules,
  ROUTER_SYSTEM_PROMPT,
} from "../../prompts/system_prompt";
import {
  SUPABASE_AVAILABLE_SYSTEM_PROMPT,
  SUPABASE_NOT_AVAILABLE_SYSTEM_PROMPT,
} from "../../prompts/supabase_prompt";
import { getDyadAppPath } from "../../paths/paths";
import { readSettings } from "../../main/settings";
import type { ChatResponseEnd, ChatStreamParams } from "../ipc_types";
import {
  CodebaseFile,
  extractCodebase,
  readFileWithCache,
} from "../../utils/codebase";
import { processFullResponseActions } from "../processors/response_processor";
import { streamTestResponse } from "./testing_chat_handlers";
import { getTestResponse } from "./testing_chat_handlers";
import { getModelClient, ModelClient } from "../utils/get_model_client";
import log from "electron-log";
import {
  getSupabaseContext,
  getSupabaseClientCode,
} from "../../supabase_admin/supabase_context";
import { SUMMARIZE_CHAT_SYSTEM_PROMPT } from "../../prompts/summarize_chat_system_prompt";
import fs from "node:fs";
import * as path from "path";
import * as os from "os";
import * as crypto from "crypto";
import { readFile, writeFile, unlink } from "fs/promises";
import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

function handleTextDelta(
  part: any,
  monitor: StreamingMonitor | FastMonitor | null,
  settings: UserSettings | undefined,
  fullResponse: string,
  abortController: AbortController,
): string {
  let chunk = part.text;

  if (monitor && settings?.enableFastCorrection) {
    const result = (monitor as any).checkChunk(fullResponse + chunk);

    if (result.hasViolation && result.correction) {
      logger.warn(`⚡ Instant abort: ${result.violationType}`);

      (abortController as any)._correctionNeeded = result.correction;
      (abortController as any)._violationType = result.violationType;

      abortController.abort();
    }
  }

  if (monitor && settings?.enableRealtimeMonitoring && !(monitor instanceof FastMonitor)) {
    monitor.analyzeChunk(chunk).catch((error: Error) => {
      logger.error("Monitor error:", error);
    });
  }

  return chunk;
}

function handleToolCall(
  part: any,
  isCodexCli: boolean,
  toolCallId: string | undefined,
  codexExecInputs: Map<string, { command?: string; cwd?: string }>,
): { chunk: string; shouldContinue: boolean } {
  if (isCodexCli && part.toolName === "exec" && toolCallId) {
    const parsedInput = parseCodexCommandInput(part.input);
    codexExecInputs.set(toolCallId, parsedInput);
    return { chunk: "", shouldContinue: true };
  }
  const { serverName, toolName } = parseMcpToolKey(part.toolName);
  const content = escapeDyadTags(JSON.stringify(part.input));
  const chunk = `<dyad-mcp-tool-call server="${serverName}" tool="${toolName}">\n${content}\n</dyad-mcp-tool-call>\n`;
  return { chunk, shouldContinue: false };
}

function handleToolResult(
  part: any,
  isCodexCli: boolean,
  toolCallId: string | undefined,
  codexExecInputs: Map<string, { command?: string; cwd?: string }>,
): { chunk: string; shouldContinue: boolean } {
  const toolResult = (part as any).result;
  let chunk = "";

  if (isCodexCli && part.toolName === "patch") {
    const writeTags = codexPatchToDyadWrites(toolResult);
    if (writeTags.length > 0) {
      chunk = writeTags.join("\n") + "\n";
    } else {
      const payload =
        typeof toolResult === "string"
          ? toolResult
          : JSON.stringify(toolResult ?? {});
      const content = escapeDyadTags(payload);
      chunk = `<dyad-output type="warning" message="Codex returned a patch without file content">${content}</dyad-output>\n`;
    }
  } else if (isCodexCli && (part.toolName === "exec" || isCodexCommandExecution(part))) {
    const execInput = toolCallId ? codexExecInputs.get(toolCallId) : undefined;
    if (toolCallId) {
      codexExecInputs.delete(toolCallId);
    }
    const command = (toolResult as any)?.command || execInput?.command || "";
    if (isTrivialCommand(command)) {
      return { chunk: "", shouldContinue: true };
    }
    const { serverName, toolName } = parseMcpToolKey(part.toolName);
    const content = escapeDyadTags(toolResult);
    chunk = `<dyad-mcp-tool-result server="${serverName}" tool="${toolName}">\n${content}\n</dyad-mcp-tool-result>\n`;
  } else {
    const { serverName, toolName } = parseMcpToolKey(part.toolName);
    let content = escapeDyadTags(part.output);
    if (toolName === "exec" || toolName === "execute_command") {
      try {
        const outputObj =
          typeof part.output === "string"
            ? JSON.parse(part.output)
            : part.output;
        if (outputObj && typeof outputObj.stdout === "string") {
          content = escapeDyadTags(outputObj.stdout);
          if (outputObj.stderr) {
            content += `\n\n[Stderr]:\n${escapeDyadTags(outputObj.stderr)}`;
          }
        }
      } catch { }
    }
    chunk = `<dyad-mcp-tool-result server="${serverName}" tool="${toolName}">\n${content}\n</dyad-mcp-tool-result>\n`;
  }

  return { chunk, shouldContinue: false };
}

function handleFinish(part: any): string {
  const googleMetadata = (part as any).providerMetadata?.google;
  if (googleMetadata?.groundingMetadata) {
    const grounding = googleMetadata.groundingMetadata;
    if (grounding.groundingChunks && grounding.groundingChunks.length > 0) {
      let sourcesText = "\n\n**Sources**:\n";
      grounding.groundingChunks.forEach((chunk: any, index: number) => {
        const title = chunk.web?.title || `Source ${index + 1}`;
        const uri = chunk.web?.uri;
        if (uri) {
          sourcesText += `${index + 1}. [${title}](${uri})\n`;
        }
      });
      return sourcesText;
    }
  }
  return "";
}

import { getMaxTokens, getTemperature } from "../utils/token_utils";
import { MAX_CHAT_TURNS_IN_CONTEXT } from "@/constants/settings_constants";
import { validateChatContext } from "../utils/context_paths_utils";
import { GoogleGenerativeAIProviderOptions } from "@ai-sdk/google";
import { mcpServers } from "../../db/schema";
import { requireMcpToolConsent } from "../utils/mcp_consent";

import { getExtraProviderOptions } from "../utils/thinking_utils";
import type { UserSettings } from "../../lib/schemas";

import { safeSend } from "../utils/safe_sender";
import { cleanFullResponse } from "../utils/cleanFullResponse";
import { generateProblemReport } from "../processors/tsc";
import { createProblemFixPrompt } from "@/shared/problem_prompt";
import { AsyncVirtualFileSystem } from "../../../shared/VirtualFilesystem";
import {
  getDyadAddDependencyTags,
  getDyadWriteTags,
  getDyadDeleteTags,
  getDyadRenameTags,
} from "../utils/dyad_tag_parser";
import { fileExists } from "../utils/file_utils";
import { FileUploadsState } from "../utils/file_uploads_state";
import { OpenAIResponsesProviderOptions } from "@ai-sdk/openai";
import { extractMentionedAppsCodebases } from "../utils/mention_apps";
import { parseAppMentions } from "@/shared/parse_mention_apps";
import { prompts as promptsTable } from "../../db/schema";
import { inArray } from "drizzle-orm";
import { replacePromptReference } from "../utils/replacePromptReference";
import { mcpManager } from "../utils/mcp_manager";
import z from "zod";
import { maybeRunGeminiWebSearch } from "../utils/gemini_web_search";
import { detectTaskType } from "../utils/task_detector";
import { WorkflowManager, WorkflowStep } from "../workflow/workflow_manager";
import { StreamingMonitor } from "../utils/streaming_monitor";
import { FastMonitor } from "../utils/fast_monitor";

type AsyncIterableStream<T> = AsyncIterable<T> & ReadableStream<T>;

const logger = log.scope("chat_stream_handlers");

// Track active streams for cancellation
const activeStreams = new Map<number, AbortController>();

// Track partial responses for cancelled streams
const partialResponses = new Map<number, string>();

// Directory for storing temporary files
const TEMP_DIR = path.join(os.tmpdir(), "dyad-attachments");

// Common helper functions
const TEXT_FILE_EXTENSIONS = [
  ".md",
  ".txt",
  ".json",
  ".csv",
  ".js",
  ".ts",
  ".html",
  ".css",
];

function getChatMockSystemPrompt(appPath: string, chatMode: "build" | "ask" | "agent" = "build"): string {
  // In agent mode, Codex should use MCP tools, not dyad tags
  if (chatMode === "agent") {
    return `
# ChatMock / Codex in Agent Mode

You are connected to ChatMock (proxying to OpenAI Codex) in DYAD's Agent mode.

## ⚠️ CRITICAL INSTRUCTIONS FOR CODEX IN AGENT MODE

**YOU ARE IN AGENT MODE - NOT BUILD MODE:**
- In this mode, you SHOULD use MCP (Model Context Protocol) tools
- You have access to \`execute_command\` or \`exec\` tool for running shell commands
- You SHOULD NOT use \`<dyad-write>\`, \`<dyad-run-command>\`, or any dyad tags in this phase
- Your job is to gather information using tools, NOT to write code

## Use execute_command Tool For:
- **Running shell commands**: Use the \`execute_command\` or \`exec\` tool with curl, npm, ls, cat, grep, etc.
- **Fetching API docs**: \`curl -s https://api.example.com/docs\`
- **Checking packages**: \`npm view react version\`
- **Exploring codebase**: \`ls -la\`, \`cat package.json\`, \`grep -r "pattern"\`
- **Testing APIs**: \`curl -X GET https://api.example.com/endpoint\`

## Do NOT:
- Use \`<dyad-write>\` tags (not available in agent mode)
- Use \`<dyad-run-command>\` tags (not available in agent mode)  
- Use any Codex CLI native tools (apply_patch, turbo_edit, etc.)
- Use web-search for things you can fetch with execute_command

## Remember:
- You are gathering information, not writing code
- Use execute_command MCP tool to run commands
- Tool outputs will be shown to you and the user
- After you gather info, the build phase will handle code generation

Current app root: ${appPath}
`;
  }

  // Build mode instructions (original)
  return `
# ChatMock Environment
You are connected to ChatMock, which proxies requests to OpenAI via your local machine.
This is a high-capability environment that supports "Vibe Coding" — fast, aesthetic, and functional app building.

- Current app root: ${appPath}

## ⚠️ CRITICAL: YOU DO NOT HAVE CODEX CLI TOOLS ⚠️

**YOU ARE IN DYAD, NOT CODEX CLI. READ THIS CAREFULLY:**

### ❌ PROHIBITED - DO NOT USE THESE:
- **NEVER** use \`apply_patch\`
- **NEVER** use \`turbo_edit\`
- **NEVER** use \`patch_file\`
- **NEVER** use \`edit_file\`
- **NEVER** use \`write_file\`
- **NEVER** use any Codex CLI native tools
- **NEVER** try to use any file editing tools other than Dyad tags

### ✅ REQUIRED - ONLY USE THESE DYAD TAGS:

#### File Operations (MANDATORY)
\`\`\`xml
<dyad-write path="src/file.tsx" description="Brief description">
Full file content here
</dyad-write>
\`\`\`

- **\`<dyad-write>\`** - Create or update files (FULL FILE CONTENT)
- **\`<dyad-rename from="old.tsx" to="new.tsx">\`** - Rename/move files
- **\`<dyad-delete path="file.tsx">\`** - Delete files

#### Commands & Dependencies
- **\`<dyad-run-command command="npm install">\`** - Run shell commands
- **\`<dyad-add-dependency packages="pkg1 pkg2">\`** - Install packages (space-separated, NOT commas)

#### App Lifecycle
- **\`<dyad-command type="rebuild">\`** - Rebuild app
- **\`<dyad-command type="restart">\`** - Restart dev server
- **\`<dyad-command type="refresh">\`** - Refresh preview

## Why Dyad Tags Are Required
Dyad needs to track ALL file changes through its tag system so:
- The UI can display your changes
- Version control works correctly
- Users can see what you're doing
- Turbo Edits can optimize file operations

## If You're Confused
- If you think you should use \`apply_patch\` → Use \`<dyad-write>\` instead
- If you think you should use \`turbo_edit\` → Use \`<dyad-write>\` instead
- If you want to edit a file → Use \`<dyad-write>\` with FULL file content
- If you want to run a command → Use \`<dyad-run-command>\`

## ❌ DO NOT USE WEB SEARCH FOR LOCAL OPERATIONS

**CRITICAL**: Do NOT use web search to inspect this project's files or structure. Use terminal commands instead:

### Use Terminal Commands For:
- **List files**: Use \`<dyad-run-command command="ls">\` NOT web search
- **Current directory**: Use \`<dyad-run-command command="pwd">\` NOT web search
- **Read files**: Use \`<dyad-run-command command="cat file.txt">\` NOT web search
- **Find files**: Use \`<dyad-run-command command="find . -name '*.tsx'">\` NOT web search
- **Search in files**: Use \`<dyad-run-command command="grep -r 'pattern' .">\` NOT web search
- **Check file structure**: Use the codebase context provided to you

### Use Web Search ONLY For:
- External library documentation (e.g., React, Tailwind docs)
- Latest package versions on npm
- API documentation for third-party services
- Current best practices for external tools

**You have full codebase context at the start of the conversation. Use it! Don't search the web for information that's already in your context.**

**REPEAT: You are in DYAD. Use \`<dyad-write>\` tags EXCLUSIVELY for all code changes.**
`;
}

async function isTextFile(filePath: string): Promise<boolean> {
  const ext = path.extname(filePath).toLowerCase();
  return TEXT_FILE_EXTENSIONS.includes(ext);
}

function escapeXml(unsafe: string): string {
  return unsafe
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Safely parse an MCP tool key that combines server and tool names.
// We split on the LAST occurrence of "__" to avoid ambiguity if either
// side contains "__" as part of its sanitized name.
function parseMcpToolKey(toolKey: string): {
  serverName: string;
  toolName: string;
} {
  if (!toolKey || typeof toolKey !== "string") {
    return { serverName: "", toolName: "" };
  }
  const separator = "__";
  const lastIndex = toolKey.lastIndexOf(separator);
  if (lastIndex === -1) {
    return { serverName: "", toolName: toolKey };
  }
  const serverName = toolKey.slice(0, lastIndex);
  const toolName = toolKey.slice(lastIndex + separator.length);
  return { serverName, toolName };
}

// Ensure the temp directory exists
if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

// Helper function to process stream chunks
async function processStreamChunks({
  fullStream,
  fullResponse,
  abortController,
  chatId,
  processResponseChunkUpdate,
  isCodexCli = false,
  monitor = null,
  settings,
}: {
  fullStream: AsyncIterableStream<TextStreamPart<ToolSet>>;
  fullResponse: string;
  abortController: AbortController;
  chatId: number;
  processResponseChunkUpdate: (params: {
    fullResponse: string;
  }) => Promise<string>;
  isCodexCli?: boolean;
  monitor?: StreamingMonitor | FastMonitor | null;
  settings?: UserSettings;
}): Promise<{ fullResponse: string; incrementalResponse: string }> {
  let incrementalResponse = "";
  let inThinkingBlock = false;
  const codexExecInputs = new Map<
    string,
    { command?: string; cwd?: string }
  >();

  for await (const part of fullStream) {
    let chunk = "";
    if (
      inThinkingBlock &&
      !["reasoning-delta", "reasoning-end", "reasoning-start"].includes(
        part.type,
      )
    ) {
      chunk = "</think>";
      inThinkingBlock = false;
    }
    const toolCallId =
      typeof (part as any).toolCallId === "string"
        ? (part as any).toolCallId
        : undefined;

    if (part.type === "text-delta") {
      chunk += handleTextDelta(part, monitor, settings, fullResponse, abortController);
    } else if (part.type === "reasoning-delta") {
      if (!inThinkingBlock) {
        chunk = "<think>";
        inThinkingBlock = true;
      }

      chunk += escapeDyadTags(part.text);
    } else if (part.type === "tool-call") {
      const result = handleToolCall(part, isCodexCli, toolCallId, codexExecInputs);
      if (result.shouldContinue) continue;
      chunk = result.chunk;
    } else if (part.type === "tool-result") {
      const result = handleToolResult(part, isCodexCli, toolCallId, codexExecInputs);
      if (result.shouldContinue) continue;
      chunk = result.chunk;
    } else if (part.type === "finish") {
      chunk = handleFinish(part);
    }

    if (!chunk) {
      continue;
    }

    fullResponse += chunk;
    incrementalResponse += chunk;
    fullResponse = cleanFullResponse(fullResponse);
    fullResponse = await processResponseChunkUpdate({
      fullResponse,
    });

    // If the stream was aborted, exit early
    if (abortController.signal.aborted) {
      logger.log(`Stream for chat ${chatId} was aborted`);
      break;
    }
  }

  return { fullResponse, incrementalResponse };
}

function parseCodexCommandInput(input: unknown): {
  command?: string;
  cwd?: string;
} {
  if (!input) {
    return {};
  }
  if (typeof input === "string") {
    try {
      const parsed = JSON.parse(input);
      return {
        command:
          typeof parsed?.command === "string" ? parsed.command : undefined,
        cwd: typeof parsed?.cwd === "string" ? parsed.cwd : undefined,
      };
    } catch {
      return {};
    }
  }
  if (typeof input === "object") {
    return {
      command:
        typeof (input as any)?.command === "string"
          ? (input as any).command
          : undefined,
      cwd:
        typeof (input as any)?.cwd === "string"
          ? (input as any).cwd
          : undefined,
    };
  }
  return {};
}

function isCodexCommandExecution(part: TextStreamPart<ToolSet>): boolean {
  const metadata = (part as any)?.providerMetadata?.["codex-cli"];
  const toolName = (part as any)?.toolName;
  return (
    metadata?.itemType === "command_execution" || toolName === "exec"
  );
}

// formatCodexCommandResult removed; Codex exec results now emit dyad-run-command for native UI.

function isTrivialCommand(command: string | undefined): boolean {
  if (!command) return false;
  const normalized = command.trim().toLowerCase();
  const patterns = [/^ls\b/, /^pwd\b/, /^whoami\b/, /^echo\b/];
  return patterns.some((re) => re.test(normalized));
}

function codexPatchToDyadWrites(result: any): string[] {
  if (!result || typeof result !== "object") {
    return [];
  }
  const changes = Array.isArray((result as any).changes)
    ? (result as any).changes
    : [];
  const writes: string[] = [];
  for (const change of changes) {
    const path = typeof change?.path === "string" ? change.path : undefined;
    const content =
      typeof change?.content === "string"
        ? change.content
        : typeof change?.new_content === "string"
          ? change.new_content
          : undefined;
    if (path && content !== undefined) {
      writes.push(
        `<dyad-write path="${escapeXml(path)}" description="Update from Codex patch">${escapeDyadTags(content)}</dyad-write>`,
      );
    }
  }
  return writes;
}

export function registerChatStreamHandlers() {
  ipcMain.handle("chat:stream", async (event, req: ChatStreamParams) => {
    let abortController: AbortController;
    let attachmentPaths: string[] = [];
    let placeholderAssistantMessage: any;

    try {
      const fileUploadsState = FileUploadsState.getInstance();
      let dyadRequestId: string | undefined;
      // Create an AbortController for this stream
      abortController = new AbortController();
      activeStreams.set(req.chatId, abortController);

      // Get the chat to check for existing messages
      const chat = await db.query.chats.findFirst({
        where: eq(chats.id, req.chatId),
        with: {
          messages: {
            orderBy: (messages, { asc }) => [asc(messages.createdAt)],
          },
          app: true, // Include app information
        },
      });

      if (!chat) {
        throw new Error(`Chat not found: ${req.chatId}`);
      }

      // Handle redo option: remove the most recent messages if needed
      if (req.redo) {
        // Get the most recent messages
        const chatMessages = [...chat.messages];

        // Find the most recent user message
        let lastUserMessageIndex = chatMessages.length - 1;
        while (
          lastUserMessageIndex >= 0 &&
          chatMessages[lastUserMessageIndex].role !== "user"
        ) {
          lastUserMessageIndex--;
        }

        if (lastUserMessageIndex >= 0) {
          // Delete the user message
          await db
            .delete(messages)
            .where(eq(messages.id, chatMessages[lastUserMessageIndex].id));

          // If there's an assistant message after the user message, delete it too
          if (
            lastUserMessageIndex < chatMessages.length - 1 &&
            chatMessages[lastUserMessageIndex + 1].role === "assistant"
          ) {
            await db
              .delete(messages)
              .where(
                eq(messages.id, chatMessages[lastUserMessageIndex + 1].id),
              );
          }
        }
      }

      // Process attachments if any
      let attachmentInfo = "";
      attachmentPaths = [];

      if (req.attachments && req.attachments.length > 0) {
        attachmentInfo = "\n\nAttachments:\n";

        for (const [index, attachment] of req.attachments.entries()) {
          // Generate a unique filename
          const hash = crypto
            .createHash("md5")
            .update(attachment.name + Date.now())
            .digest("hex");
          const fileExtension = path.extname(attachment.name);
          const filename = `${hash}${fileExtension}`;
          const filePath = path.join(TEMP_DIR, filename);

          // Extract the base64 data (remove the data:mime/type;base64, prefix)
          const base64Data = attachment.data.split(";base64,").pop() || "";

          await writeFile(filePath, Buffer.from(base64Data, "base64"));
          attachmentPaths.push(filePath);

          if (attachment.attachmentType === "upload-to-codebase") {
            // For upload-to-codebase, create a unique file ID and store the mapping
            const fileId = `DYAD_ATTACHMENT_${index}`;

            fileUploadsState.addFileUpload(
              { chatId: req.chatId, fileId },
              {
                filePath,
                originalName: attachment.name,
              },
            );

            // Add instruction for AI to use dyad-write tag
            attachmentInfo += `\n\nFile to upload to codebase: ${attachment.name} (file id: ${fileId})\n`;
          } else {
            // For chat-context, use the existing logic
            attachmentInfo += `- ${attachment.name} (${attachment.type})\n`;
            // If it's a text-based file, try to include the content
            if (await isTextFile(filePath)) {
              try {
                attachmentInfo += `<dyad-text-attachment filename="${attachment.name}" type="${attachment.type}" path="${filePath}">
                </dyad-text-attachment>
                \n\n`;
              } catch (err) {
                logger.error(`Error reading file content: ${err}`);
              }
            }
          }
        }
      }

      // Add user message to database with attachment info
      let userPrompt = req.prompt + (attachmentInfo ? attachmentInfo : "");
      // Inline referenced prompt contents for mentions like @prompt:<id>
      try {
        const matches = Array.from(userPrompt.matchAll(/@prompt:(\d+)/g));
        if (matches.length > 0) {
          const ids = Array.from(new Set(matches.map((m) => Number(m[1]))));
          const referenced = await db
            .select()
            .from(promptsTable)
            .where(inArray(promptsTable.id, ids));
          if (referenced.length > 0) {
            const promptsMap: Record<number, string> = {};
            for (const p of referenced) {
              promptsMap[p.id] = p.content;
            }
            userPrompt = replacePromptReference(userPrompt, promptsMap);
          }
        }
      } catch (e) {
        logger.error("Failed to inline referenced prompts:", e);
      }
      if (req.selectedComponent) {
        let componentSnippet = "[component snippet not available]";
        try {
          const componentFileContent = await readFile(
            path.join(
              getDyadAppPath(chat.app.path),
              req.selectedComponent.relativePath,
            ),
            "utf8",
          );
          const lines = componentFileContent.split("\n");
          const selectedIndex = req.selectedComponent.lineNumber - 1;

          // Let's get one line before and three after for context.
          const startIndex = Math.max(0, selectedIndex - 1);
          const endIndex = Math.min(lines.length, selectedIndex + 4);

          const snippetLines = lines.slice(startIndex, endIndex);
          const selectedLineInSnippetIndex = selectedIndex - startIndex;

          if (snippetLines[selectedLineInSnippetIndex]) {
            snippetLines[selectedLineInSnippetIndex] =
              `${snippetLines[selectedLineInSnippetIndex]} // <-- EDIT HERE`;
          }

          componentSnippet = snippetLines.join("\n");
        } catch (err) {
          logger.error(`Error reading selected component file content: ${err}`);
        }

        userPrompt += `\n\nSelected component: ${req.selectedComponent.name} (file: ${req.selectedComponent.relativePath})

Snippet:
\`\`\`
${componentSnippet}
\`\`\`
`;
      }
      await db
        .insert(messages)
        .values({
          chatId: req.chatId,
          role: "user",
          content: userPrompt,
        })
        .returning();
      const settings = readSettings();
      // Only Dyad Pro requests have request ids.
      if (settings.enableDyadPro) {
        // Generate requestId early so it can be saved with the message
        dyadRequestId = uuidv4();
      }

      // Add a placeholder assistant message immediately
      [placeholderAssistantMessage] = await db
        .insert(messages)
        .values({
          chatId: req.chatId,
          role: "assistant",
          content: "", // Start with empty content
          requestId: dyadRequestId,
        })
        .returning();

      // Fetch updated chat data after possible deletions and additions
      const updatedChat = await db.query.chats.findFirst({
        where: eq(chats.id, req.chatId),
        with: {
          messages: {
            orderBy: (messages, { asc }) => [asc(messages.createdAt)],
          },
          app: true, // Include app information
        },
      });

      if (!updatedChat) {
        throw new Error(`Chat not found: ${req.chatId}`);
      }

      // Send the messages right away so that the loading state is shown for the message.
      safeSend(event.sender, "chat:response:chunk", {
        chatId: req.chatId,
        messages: updatedChat.messages,
      });

      let fullResponse = "";

      // Check if this is a test prompt
      const testResponse = getTestResponse(req.prompt);

      let targetModel = settings.selectedModel;

      if (testResponse) {
        // For test prompts, use the dedicated function
        fullResponse = await streamTestResponse(
          event,
          req.chatId,
          testResponse,
          abortController,
          updatedChat,
        );
      } else {
        // Normal AI processing for non-test prompts

        // Extract codebase first for task detection
        const appPath = getDyadAppPath(updatedChat.app.path);
        const chatContext = validateChatContext(updatedChat.app.chatContext);
        const { formattedOutput: codebaseInfo, files } = await extractCodebase({
          appPath,
          chatContext,
        });

        // AI Router: Use a model to classify the prompt and select target model
        targetModel = settings.selectedModel;
        let effectiveTaskType: any = undefined;
        let cleanedPrompt = req.prompt;
        let routerClassification: string | null = null;
        let systemPromptSuffix = "";

        // Check for workflow commands
        if (req.prompt.trim().startsWith("/workflow stop")) {
          await WorkflowManager.stopWorkflow(req.chatId);
          cleanedPrompt = "Workflow stopped.";
          logger.info("Workflow stopped by user");
        } else if (req.prompt.trim().startsWith("/workflow")) {
          const step = await WorkflowManager.startWorkflow(req.chatId);
          // Update the prompt for the AI context (the user still sees the original command in history)
          cleanedPrompt =
            req.prompt.replace("/workflow", "").trim() || "Start planning.";
          logger.info(`Starting workflow: ${step}`);
        } else if (req.prompt.trim().startsWith("/next")) {
          const step = await WorkflowManager.advanceStep(req.chatId);
          if (step) {
            cleanedPrompt = `Proceed to the next step: ${step}.`;
            logger.info(`Advancing workflow to: ${step}`);
          } else {
            cleanedPrompt = "Workflow completed.";
            logger.info("Workflow completed");
          }
        }

        // Fetch the latest chat state (including workflow updates)
        const chatState = await WorkflowManager.getChatState(req.chatId);
        const isWorkflowActive = chatState?.workflowStatus === "active";

        // IMMEDIATE UI UPDATE: Send the updated chat state to the frontend
        // This ensures the workflow indicator updates instantly
        const refreshedChat = await db.query.chats.findFirst({
          where: eq(chats.id, req.chatId),
          with: {
            messages: {
              orderBy: (messages, { asc }) => [asc(messages.createdAt)],
            },
            app: true,
          },
        });

        if (refreshedChat) {
          safeSend(event.sender, "chat:response:chunk", {
            chatId: req.chatId,
            messages: refreshedChat.messages,
            // We send the full chat object if possible, or rely on messages triggering a refresh
            // Since we can't change the frontend, sending the chunk is the best we can do.
            // However, we can try to send a custom event if the frontend supports it,
            // but for now we stick to the standard channel.
          });
        }

        // AI Router: Classify prompt if enabled
        if (settings.enableAIRouter && settings.routerModel) {
          try {
            logger.log("AI Router enabled. Calling router model to classify prompt...");
            const { modelClient: routerClient } = await getModelClient(
              settings.routerModel,
              settings,
              appPath,
            );

            const routerMessages: ModelMessage[] = [
              { role: "user", content: req.prompt }
            ];

            let routerResponse = "";
            const routerStream = await streamText({
              model: routerClient.model,
              system: ROUTER_SYSTEM_PROMPT,
              messages: routerMessages,
            });

            for await (const chunk of routerStream.textStream) {
              routerResponse += chunk;
            }

            routerClassification = routerResponse.trim().toLowerCase();
            logger.log(`Router classified prompt as: "${routerClassification}"`);
          } catch (error) {
            logger.error("Router failed, will fall back to other methods:", error);
          }
        }

        if (isWorkflowActive && chatState?.workflowStep) {
          // Check if we should override workflow with debugging
          if (routerClassification === "debugging" && settings.taskModels?.debugging) {
            targetModel = settings.taskModels.debugging;
            effectiveTaskType = "debugging";
            logger.log("Workflow active but Router detected Debugging: Overriding model");
          } else {
            const step = chatState.workflowStep as WorkflowStep;
            const taskType = WorkflowManager.getTaskTypeForStep(step);

            // Override effectiveTaskType for model selection
            if (settings.taskModels?.useTaskBasedSwitching) {
              effectiveTaskType = taskType;
              // If we have a specific model for this task type, use it.
              // Otherwise, we stick with the default/selected model but use the task type context if applicable.
              if (taskType !== "general" && settings.taskModels[taskType]) {
                targetModel = settings.taskModels[taskType]!;
              }
            }

            // For system prompt, we want to use the specific step name if taskType is generic
            if (taskType === "general") {
              effectiveTaskType = step;
            }

            // Add step-specific system prompt
            systemPromptSuffix += WorkflowManager.getSystemPromptForStep(step);
            logger.info(
              `Workflow active: step=${step}, taskType=${taskType}, model=${targetModel.name}`,
            );
          }
        } else if (routerClassification) {
          // Use classification to select model
          if (routerClassification === "ultrathink" && settings.ultrathinkModel) {
            targetModel = settings.ultrathinkModel;
            cleanedPrompt = req.prompt.replace(/\bultrathink\b/gi, "").trim();
            logger.log("Router selected Ultrathink model");
          } else if (settings.taskModels?.useTaskBasedSwitching) {
            // Map router classification to task type
            if (routerClassification === "frontend" && settings.taskModels.frontend) {
              targetModel = settings.taskModels.frontend;
              logger.log("Router selected Frontend model");
            } else if (routerClassification === "backend" && settings.taskModels.backend) {
              targetModel = settings.taskModels.backend;
              logger.log("Router selected Backend model");
            } else if (routerClassification === "debugging" && settings.taskModels.debugging) {
              targetModel = settings.taskModels.debugging;
              logger.log("Router selected Debugging model");
            }
          }
        } else {
          // Fallback: use keyword detection if router is disabled or failed
          const isUltrathink = req.prompt.toLowerCase().includes("ultrathink");
          if (isUltrathink) {
            cleanedPrompt = req.prompt.replace(/\bultrathink\b/gi, "").trim();
            if (settings.ultrathinkModel) {
              targetModel = settings.ultrathinkModel;
              logger.log("Keyword detection: Ultrathink detected");
            }
          } else {
            effectiveTaskType = settings.taskModels?.useTaskBasedSwitching
              ? detectTaskType({
                userPrompt: req.prompt,
                selectedComponent: req.selectedComponent || undefined,
                codebaseFiles: files,
              })
              : undefined;
          }
        }

        logger.log(`Final model selection: ${targetModel.name}, Task type: ${effectiveTaskType || "none"}`);

        const { modelClient, isEngineEnabled, isSmartContextEnabled } =
          await getModelClient(
            targetModel,
            settings,
            appPath,
            effectiveTaskType,
          );
        const isChatMock =
          modelClient.builtinProviderId === "chatmock";

        // For smart context and selected component, we will mark the selected component's file as focused.
        // This means that we don't do the regular smart context handling, but we'll allow fetching
        // additional files through <dyad-read> as needed.
        if (isSmartContextEnabled && req.selectedComponent) {
          for (const file of files) {
            if (file.path === req.selectedComponent.relativePath) {
              file.focused = true;
            }
          }
        }

        // Parse app mentions from the prompt
        const mentionedAppNames = parseAppMentions(req.prompt);

        // Extract codebases for mentioned apps
        const mentionedAppsCodebases = await extractMentionedAppsCodebases(
          mentionedAppNames,
          updatedChat.app.id, // Exclude current app
        );

        // Combine current app codebase with mentioned apps' codebases
        let otherAppsCodebaseInfo = "";
        if (mentionedAppsCodebases.length > 0) {
          const mentionedAppsSection = mentionedAppsCodebases
            .map(
              ({ appName, codebaseInfo }) =>
                `\n\n=== Referenced App: ${appName} ===\n${codebaseInfo}`,
            )
            .join("");

          otherAppsCodebaseInfo = mentionedAppsSection;

          logger.log(
            `Added ${mentionedAppsCodebases.length} mentioned app codebases`,
          );
        }

        logger.log(`Extracted codebase information from ${appPath}`);
        logger.log(
          "codebaseInfo: length",
          codebaseInfo.length,
          "estimated tokens",
          codebaseInfo.length / 4,
        );

        // Prepare message history for the AI
        const messageHistory = updatedChat.messages.map((message) => ({
          role: message.role as "user" | "assistant" | "system",
          content: message.content,
        }));

        // Replace the last user message with cleaned prompt if it was cleaned
        if (cleanedPrompt !== req.prompt && messageHistory.length > 0) {
          const lastMessage = messageHistory[messageHistory.length - 1];
          if (lastMessage.role === "user") {
            lastMessage.content = cleanedPrompt;
          }
        }

        // Limit chat history based on maxChatTurnsInContext setting
        // We add 1 because the current prompt counts as a turn.
        const maxChatTurns =
          (settings.maxChatTurnsInContext || MAX_CHAT_TURNS_IN_CONTEXT) + 1;

        // If we need to limit the context, we take only the most recent turns
        let limitedMessageHistory = messageHistory;
        if (messageHistory.length > maxChatTurns * 2) {
          // Each turn is a user + assistant pair
          // Calculate how many messages to keep (maxChatTurns * 2)
          let recentMessages = messageHistory
            .filter((msg) => msg.role !== "system")
            .slice(-maxChatTurns * 2);

          // Ensure the first message is a user message
          if (recentMessages.length > 0 && recentMessages[0].role !== "user") {
            // Find the first user message
            const firstUserIndex = recentMessages.findIndex(
              (msg) => msg.role === "user",
            );
            if (firstUserIndex > 0) {
              // Drop assistant messages before the first user message
              recentMessages = recentMessages.slice(firstUserIndex);
            } else if (firstUserIndex === -1) {
              logger.warn(
                "No user messages found in recent history, set recent messages to empty",
              );
              recentMessages = [];
            }
          }

          limitedMessageHistory = [...recentMessages];

          logger.log(
            `Limiting chat history from ${messageHistory.length} to ${limitedMessageHistory.length} messages (max ${maxChatTurns} turns)`,
          );
        }

        // Check if the current provider supports thinking to inject THINKING_PROMPT
        const isThinkingProvider = modelClient.builtinProviderId === "google" || modelClient.builtinProviderId === "vertex" || modelClient.builtinProviderId === "auto" || modelClient.builtinProviderId === "chatmock";

        let systemPrompt = constructSystemPrompt({
          aiRules: await readAiRules(getDyadAppPath(updatedChat.app.path)),
          chatMode:
            settings.selectedChatMode === "agent"
              ? "build"
              : settings.selectedChatMode,
          enableThinking: isThinkingProvider,
          taskType: effectiveTaskType || routerClassification || undefined,
        });

        if (systemPromptSuffix) {
          systemPrompt += systemPromptSuffix;
        }

        // Remind the model about terminal scope and Dyad command tags.
        systemPrompt += `

# Terminal Access & File Editing
- App root: ${appPath}
- Keep commands scoped to this directory unless the user specifies another path.
- Surface commands and important output explicitly; avoid long-running daemons unless requested.
- Use <dyad-run-command command="..."> for ANY shell command you want to execute or suggest. The user will run it.
- Use <dyad-write path="...">...</dyad-write> for creating or editing files.
- Use <dyad-delete path="...">...</dyad-delete> for deleting files.
- Use <dyad-rename from="..." to="...">...</dyad-rename> for renaming/moving files.

# ⚠️ WEB SEARCH RESTRICTIONS
- **DO NOT** use web search to find information about the local codebase (files, structure, etc.). Use \`<dyad-run-command>\` with \`ls\`, \`find\`, \`grep\`, \`cat\` instead.
- **ONLY** use web search for:
  1. External library documentation (e.g., "Tailwind v4 migration guide")
  2. Real-time information (e.g., "latest npm package version")
  3. When the user **explicitly asks** you to search the web.
- If you can answer based on your knowledge or the provided context, **DO NOT** search the web.
`;

        if (isChatMock) {
          systemPrompt += getChatMockSystemPrompt(appPath, settings.selectedChatMode);
        }

        // Add information about mentioned apps if any
        if (otherAppsCodebaseInfo) {
          const mentionedAppsList = mentionedAppsCodebases
            .map(({ appName }) => appName)
            .join(", ");

          systemPrompt += `\n\n# Referenced Apps\nThe user has mentioned the following apps in their prompt: ${mentionedAppsList}. Their codebases have been included in the context for your reference. When referring to these apps, you can understand their structure and code to provide better assistance, however you should NOT edit the files in these referenced apps. The referenced apps are NOT part of the current app and are READ-ONLY.`;
        }
        if (
          updatedChat.app?.supabaseProjectId &&
          settings.supabase?.accessToken?.value
        ) {
          systemPrompt +=
            "\n\n" +
            SUPABASE_AVAILABLE_SYSTEM_PROMPT +
            "\n\n" +
            (await getSupabaseContext({
              supabaseProjectId: updatedChat.app.supabaseProjectId,
            }));
        } else if (
          // Neon projects don't need Supabase.
          !updatedChat.app?.neonProjectId
        ) {
          systemPrompt += "\n\n" + SUPABASE_NOT_AVAILABLE_SYSTEM_PROMPT;
        }
        const isSummarizeIntent = req.prompt.startsWith(
          "Summarize from chat-id=",
        );
        if (isSummarizeIntent) {
          systemPrompt = SUMMARIZE_CHAT_SYSTEM_PROMPT;
        }

        // Update the system prompt for images if there are image attachments
        const hasImageAttachments =
          req.attachments &&
          req.attachments.some((attachment) =>
            attachment.type.startsWith("image/"),
          );

        const hasUploadedAttachments =
          req.attachments &&
          req.attachments.some(
            (attachment) => attachment.attachmentType === "upload-to-codebase",
          );
        // If there's mixed attachments (e.g. some upload to codebase attachments and some upload images as chat context attachemnts)
        // we will just include the file upload system prompt, otherwise the AI gets confused and doesn't reliably
        // print out the dyad-write tags.
        // Usually, AI models will want to use the image as reference to generate code (e.g. UI mockups) anyways, so
        // it's not that critical to include the image analysis instructions.
        if (hasUploadedAttachments) {
          systemPrompt += `
  
When files are attached to this conversation, upload them to the codebase using this exact format:

<dyad-write path="path/to/destination/filename.ext" description="Upload file to codebase">
DYAD_ATTACHMENT_X
</dyad-write>

Example for file with id of DYAD_ATTACHMENT_0:
<dyad-write path="src/components/Button.jsx" description="Upload file to codebase">
DYAD_ATTACHMENT_0
</dyad-write>

  `;
        } else if (hasImageAttachments) {
          systemPrompt += `

# Image Analysis Instructions
This conversation includes one or more image attachments. When the user uploads images:
1. If the user explicitly asks for analysis, description, or information about the image, please analyze the image content.
2. Describe what you see in the image if asked.
3. You can use images as references when the user has coding or design-related questions.
4. For diagrams or wireframes, try to understand the content and structure shown.
5. For screenshots of code or errors, try to identify the issue or explain the code.
`;
        }

        const codebasePrefix = isEngineEnabled
          ? // No codebase prefix if engine is set, we will take of it there.
          []
          : ([
            {
              role: "user",
              content: createCodebasePrompt(codebaseInfo),
            },
            {
              role: "assistant",
              content: "OK, got it. I'm ready to help",
            },
          ] as const);

        // If engine is enabled, we will send the other apps codebase info to the engine
        // and process it with smart context.
        const otherCodebasePrefix =
          otherAppsCodebaseInfo && !isEngineEnabled
            ? ([
              {
                role: "user",
                content: createOtherAppsCodebasePrompt(otherAppsCodebaseInfo),
              },
              {
                role: "assistant",
                content: "OK.",
              },
            ] as const)
            : [];

        const limitedHistoryChatMessages = limitedMessageHistory.map((msg) => ({
          role: msg.role as "user" | "assistant" | "system",
          // Why remove thinking tags?
          // Thinking tags are generally not critical for the context
          // and eats up extra tokens.
          content:
            settings.selectedChatMode === "ask"
              ? removeDyadTags(removeNonEssentialTags(msg.content))
              : removeNonEssentialTags(msg.content),
        }));

        let chatMessages: ModelMessage[] = [
          ...codebasePrefix,
          ...otherCodebasePrefix,
          ...limitedHistoryChatMessages,
        ];

        const webSearchTools = createWebSearchTool({
          settings,
          abortSignal: abortController.signal,
        });

        // Check if the last message should include attachments
        if (chatMessages.length >= 2 && attachmentPaths.length > 0) {
          const lastUserIndex = chatMessages.length - 2;
          const lastUserMessage = chatMessages[lastUserIndex];

          if (lastUserMessage.role === "user") {
            // Replace the last message with one that includes attachments
            chatMessages[lastUserIndex] = await prepareMessageWithAttachments(
              lastUserMessage,
              attachmentPaths,
            );
          }
        }

        if (isSummarizeIntent) {
          const previousChat = await db.query.chats.findFirst({
            where: eq(chats.id, parseInt(req.prompt.split("=")[1])),
            with: {
              messages: {
                orderBy: (messages, { asc }) => [asc(messages.createdAt)],
              },
            },
          });
          chatMessages = [
            {
              role: "user",
              content:
                "Summarize the following chat: " +
                formatMessagesForSummary(previousChat?.messages ?? []),
            } satisfies ModelMessage,
          ];
        }
        const simpleStreamText = async ({
          chatMessages,
          modelClient,
          tools,
          systemPromptOverride = systemPrompt,
          dyadDisableFiles = false,
          files,
        }: {
          chatMessages: ModelMessage[];
          modelClient: ModelClient;
          files: CodebaseFile[];
          tools?: ToolSet;
          systemPromptOverride?: string;
          dyadDisableFiles?: boolean;
        }) => {
          if (isEngineEnabled) {
            logger.log(
              "sending AI request to engine with request id:",
              dyadRequestId,
            );
          } else {
            logger.log("sending AI request");
          }
          // Build provider options with correct Google/Vertex thinking config gating
          const providerOptions: Record<string, any> = {
            "dyad-engine": {
              dyadRequestId,
              dyadDisableFiles,
              dyadFiles: files,
              dyadMentionedApps: mentionedAppsCodebases.map(
                ({ files, appName }) => ({
                  appName,
                  files,
                }),
              ),
            },
            "dyad-gateway": getExtraProviderOptions(
              modelClient.builtinProviderId,
              settings,
            ),
            openai: {
              reasoningSummary: "auto",
            } satisfies OpenAIResponsesProviderOptions,
          };

          // Explicitly handle gemini-cli options key
          if (modelClient.builtinProviderId === "gemini-cli") {
            providerOptions["gemini-cli"] = {
              thinkingConfig: { includeThoughts: true },
              useSearchGrounding: settings.enableProWebSearch,
            };
          }

          // Conditionally include Google thinking config only for supported models
          const selectedModelName = settings.selectedModel.name || "";
          const providerId = modelClient.builtinProviderId;
          const isVertex = providerId === "vertex";
          const isGoogle = providerId === "google" || providerId === "gemini-cli";
          const isAnthropic = providerId === "anthropic";
          const isPartnerModel = selectedModelName.includes("/");
          const isGeminiModel = selectedModelName.startsWith("gemini");
          const isFlashLite = selectedModelName.includes("flash-lite");

          // Keep Google provider behavior unchanged: always include includeThoughts
          if (isGoogle) {
            const googleOptions: GoogleGenerativeAIProviderOptions = {
              thinkingConfig: {
                includeThoughts: true,
              },
            };

            if (settings.enableProWebSearch) {
              (googleOptions as any).useSearchGrounding = true;
            }

            providerOptions.google = googleOptions;
          }

          // Vertex-specific fix: only enable thinking on supported Gemini models
          if (isVertex && isGeminiModel && !isFlashLite && !isPartnerModel) {
            const googleOptions: GoogleGenerativeAIProviderOptions = {
              thinkingConfig: {
                includeThoughts: true,
              },
            };

            // Vertex AI also supports search grounding if configured
            if (settings.enableProWebSearch) {
              (googleOptions as any).useSearchGrounding = true;
            }

            providerOptions.google = googleOptions;
          }

          return streamText({
            headers: isAnthropic
              ? {
                "anthropic-beta": "context-1m-2025-08-07",
              }
              : undefined,
            maxOutputTokens: await getMaxTokens(settings.selectedModel),
            temperature: await getTemperature(settings.selectedModel),
            maxRetries: 2,
            model: modelClient.model,
            stopWhen: [stepCountIs(20), hasToolCall("edit-code")],
            providerOptions,
            system: systemPromptOverride,
            tools,
            messages: chatMessages.filter((m) => m.content),
            onError: (error: any) => {
              logger.error("Error streaming text:", error);
              let errorMessage = (error as any)?.error?.message;
              const responseBody = error?.error?.responseBody;
              if (errorMessage && responseBody) {
                errorMessage += "\n\nDetails: " + responseBody;
              }
              const message = errorMessage || JSON.stringify(error);
              const requestIdPrefix = isEngineEnabled
                ? `[Request ID: ${dyadRequestId}] `
                : "";
              event.sender.send("chat:response:error", {
                chatId: req.chatId,
                error: `Sorry, there was an error from the AI: ${requestIdPrefix}${message}`,
              });
              // Clean up the abort controller
              activeStreams.delete(req.chatId);
            },
            abortSignal: abortController.signal,
          });
        };

        let lastDbSaveAt = 0;

        const processResponseChunkUpdate = async ({
          fullResponse,
        }: {
          fullResponse: string;
        }) => {
          if (
            fullResponse.includes("$$SUPABASE_CLIENT_CODE$$") &&
            updatedChat.app?.supabaseProjectId
          ) {
            const supabaseClientCode = await getSupabaseClientCode({
              projectId: updatedChat.app?.supabaseProjectId,
            });
            fullResponse = fullResponse.replace(
              "$$SUPABASE_CLIENT_CODE$$",
              supabaseClientCode,
            );
          }
          // Store the current partial response
          partialResponses.set(req.chatId, fullResponse);
          // Save to DB (in case user is switching chats during the stream)
          const now = Date.now();
          if (now - lastDbSaveAt >= 150) {
            await db
              .update(messages)
              .set({ content: fullResponse })
              .where(eq(messages.id, placeholderAssistantMessage.id));

            lastDbSaveAt = now;
          }

          // Update the placeholder assistant message content in the messages array
          const currentMessages = [...updatedChat.messages];
          if (
            currentMessages.length > 0 &&
            currentMessages[currentMessages.length - 1].role === "assistant"
          ) {
            currentMessages[currentMessages.length - 1].content = fullResponse;
          }

          // Update the assistant message in the database
          safeSend(event.sender, "chat:response:chunk", {
            chatId: req.chatId,
            messages: currentMessages,
          });
          return fullResponse;
        };

        if (settings.selectedChatMode === "agent") {
          const tools = await getMcpTools(event);

          const { fullStream } = await simpleStreamText({
            chatMessages: limitedHistoryChatMessages,
            modelClient,
            tools: combineToolSets(
              tools,
              {
                "generate-code": {
                  description:
                    "ALWAYS use this tool whenever generating or editing code for the codebase.",
                  inputSchema: z.object({}),
                  execute: async () => "",
                },
                "execute_command": {
                  description:
                    "Run a shell command on the local machine. Use this for listing files, reading files, running tests, etc.",
                  inputSchema: z.object({
                    command: z.string().describe("The shell command to execute"),
                  }),
                  execute: async ({ command }) => {
                    try {
                      const { stdout, stderr } = await execAsync(command, {
                        cwd: getDyadAppPath(updatedChat.app.path),
                      });
                      return JSON.stringify({ stdout, stderr });
                    } catch (error: any) {
                      return JSON.stringify({
                        stdout: error.stdout || "",
                        stderr: error.stderr || error.message,
                        error: error.message,
                      });
                    }
                  },
                },
                "exec": {
                  description:
                    "Alias for execute_command. Run a shell command on the local machine.",
                  inputSchema: z.object({
                    command: z.string().describe("The shell command to execute"),
                  }),
                  execute: async ({ command }) => {
                    try {
                      const { stdout, stderr } = await execAsync(command, {
                        cwd: getDyadAppPath(updatedChat.app.path),
                      });
                      return JSON.stringify({ stdout, stderr });
                    } catch (error: any) {
                      return JSON.stringify({
                        stdout: error.stdout || "",
                        stderr: error.stderr || error.message,
                        error: error.message,
                      });
                    }
                  },
                },
              },
              webSearchTools,
            ),
            systemPromptOverride: constructSystemPrompt({
              aiRules: await readAiRules(getDyadAppPath(updatedChat.app.path)),
              chatMode: "agent",
              enableThinking: isThinkingProvider,
            }),
            files: files,
            dyadDisableFiles: true,
          });

          const result = await processStreamChunks({
            fullStream,
            fullResponse,
            abortController,
            chatId: req.chatId,
            processResponseChunkUpdate,
            isCodexCli: false,
          });
          fullResponse = result.fullResponse;
          chatMessages.push({
            role: "assistant",
            content: fullResponse,
          });
          chatMessages.push({
            role: "user",
            content: "OK.",
          });
        }

        // When calling streamText, the messages need to be properly formatted for mixed content
        let { fullStream } = await simpleStreamText({
          chatMessages,
          modelClient,
          files: files,
          tools: combineToolSets(webSearchTools),
        });

        // Process the stream as before
        // Process the stream with support for stop-correct-resume
        let correctionAttempts = 0;
        const MAX_CORRECTION_ATTEMPTS = settings.maxCorrectionAttempts || 2;

        while (true) {
          try {
            // Initialize monitor if enabled
            let monitor: StreamingMonitor | FastMonitor | null = null;
            if (settings.enableFastCorrection) {
              monitor = new FastMonitor({
                mode: settings.selectedChatMode || 'build',
                workflowStep: (chat as any).workflowStep,
              });
            } else if (settings.enableRealtimeMonitoring && settings.routerModel) {
              monitor = new StreamingMonitor({
                routerModel: settings.routerModel,
                settings,
                appPath: getDyadAppPath(chat.app.path),
                mode: settings.selectedChatMode || 'build',
                workflowStep: (chat as any).workflowStep,
              });
            }

            const result = await processStreamChunks({
              fullStream,
              fullResponse,
              abortController,
              chatId: req.chatId,
              processResponseChunkUpdate,
              isCodexCli: false,
              monitor,
              settings,
            });
            fullResponse = result.fullResponse;

            // Check if stream was aborted for correction
            if (abortController.signal.aborted && (abortController as any)._correctionNeeded) {
              if (correctionAttempts >= MAX_CORRECTION_ATTEMPTS) {
                logger.warn("Max correction attempts reached, stopping correction loop");
                break;
              }

              const correctionMessage = (abortController as any)._correctionNeeded;
              const violationType = (abortController as any)._violationType;
              logger.info(`Resuming stream with correction: ${violationType}`);

              // 1. Inject correction into database (Skipped to keep invisible and avoid schema issues)
              // System messages are not supported in messages table and we want this to be invisible in history anyway.

              // 2. Update chat messages for next stream
              chatMessages.push({
                role: "assistant",
                content: fullResponse, // Keep what was generated so far
              });
              chatMessages.push({
                role: "system",
                content: correctionMessage,
              });

              // 3. Reset for resume
              correctionAttempts++;
              abortController = new AbortController(); // Reset controller
              activeStreams.set(req.chatId, abortController); // Update active stream map

              // 4. Restart stream with new context
              const streamResult = await simpleStreamText({
                chatMessages,
                modelClient,
                files: files,
                tools: combineToolSets(webSearchTools),
              });
              fullStream = streamResult.fullStream;

              // Loop continues to process new stream
              continue;
            }

            // If normal finish or aborted without correction, break loop
            break;
          } catch (error) {
            throw error;
          }
        }

        if (
          !abortController.signal.aborted &&
          settings.selectedChatMode !== "ask" &&
          hasUnclosedDyadWrite(fullResponse)
        ) {
          let continuationAttempts = 0;
          while (
            hasUnclosedDyadWrite(fullResponse) &&
            continuationAttempts < 2 &&
            !abortController.signal.aborted
          ) {
            logger.warn(
              `Received unclosed dyad-write tag, attempting to continue, attempt #${continuationAttempts + 1}`,
            );
            continuationAttempts++;

            const { fullStream: contStream } = await simpleStreamText({
              // Build messages: replay history then pre-fill assistant with current partial.
              chatMessages: [
                ...chatMessages,
                { role: "assistant", content: fullResponse },
              ],
              modelClient,
              files: files,
            });
            for await (const part of contStream) {
              // If the stream was aborted, exit early
              if (abortController.signal.aborted) {
                logger.log(`Stream for chat ${req.chatId} was aborted`);
                break;
              }
              if (part.type !== "text-delta") continue; // ignore reasoning for continuation
              fullResponse += part.text;
              fullResponse = cleanFullResponse(fullResponse);
              fullResponse = await processResponseChunkUpdate({
                fullResponse,
              });
            }
          }
        }
        const addDependencies = getDyadAddDependencyTags(fullResponse);
        if (
          !abortController.signal.aborted &&
          // If there are dependencies, we don't want to auto-fix problems
          // because there's going to be type errors since the packages aren't
          // installed yet.
          addDependencies.length === 0 &&
          settings.enableAutoFixProblems &&
          settings.selectedChatMode !== "ask"
        ) {
          try {
            // IF auto-fix is enabled
            let problemReport = await generateProblemReport({
              fullResponse,
              appPath: getDyadAppPath(updatedChat.app.path),
            });

            let autoFixAttempts = 0;
            const originalFullResponse = fullResponse;
            const previousAttempts: ModelMessage[] = [];
            while (
              problemReport.problems.length > 0 &&
              autoFixAttempts < 2 &&
              !abortController.signal.aborted
            ) {
              fullResponse += `<dyad-problem-report summary="${problemReport.problems.length} problems">
${problemReport.problems
                  .map(
                    (problem) =>
                      `<problem file="${escapeXml(problem.file)}" line="${problem.line}" column="${problem.column}" code="${problem.code}">${escapeXml(problem.message)}</problem>`,
                  )
                  .join("\n")}
</dyad-problem-report>`;

              logger.info(
                `Attempting to auto-fix problems, attempt #${autoFixAttempts + 1}`,
              );
              autoFixAttempts++;
              const problemFixPrompt = createProblemFixPrompt(problemReport);

              const virtualFileSystem = new AsyncVirtualFileSystem(
                getDyadAppPath(updatedChat.app.path),
                {
                  fileExists: (fileName: string) => fileExists(fileName),
                  readFile: (fileName: string) => readFileWithCache(fileName),
                },
              );
              const writeTags = getDyadWriteTags(fullResponse);
              const renameTags = getDyadRenameTags(fullResponse);
              const deletePaths = getDyadDeleteTags(fullResponse);
              virtualFileSystem.applyResponseChanges({
                deletePaths,
                renameTags,
                writeTags,
              });

              const { formattedOutput: codebaseInfo, files } =
                await extractCodebase({
                  appPath,
                  chatContext,
                  virtualFileSystem,
                });
              const { modelClient } = await getModelClient(
                settings.selectedModel,
                settings,
                appPath,
              );

              const { fullStream } = await simpleStreamText({
                modelClient,
                files: files,
                chatMessages: [
                  ...chatMessages.map((msg, index) => {
                    if (
                      index === 0 &&
                      msg.role === "user" &&
                      typeof msg.content === "string" &&
                      msg.content.startsWith(CODEBASE_PROMPT_PREFIX)
                    ) {
                      return {
                        role: "user",
                        content: createCodebasePrompt(codebaseInfo),
                      } as const;
                    }
                    return msg;
                  }),
                  {
                    role: "assistant",
                    content: removeNonEssentialTags(originalFullResponse),
                  },
                  ...previousAttempts,
                  { role: "user", content: problemFixPrompt },
                ],
              });
              previousAttempts.push({
                role: "user",
                content: problemFixPrompt,
              });
              const result = await processStreamChunks({
                fullStream,
                fullResponse,
                abortController,
                chatId: req.chatId,
                processResponseChunkUpdate,
                isCodexCli: false,
              });
              fullResponse = result.fullResponse;
              previousAttempts.push({
                role: "assistant",
                content: removeNonEssentialTags(result.incrementalResponse),
              });

              problemReport = await generateProblemReport({
                fullResponse,
                appPath: getDyadAppPath(updatedChat.app.path),
              });
            }
          } catch (error) {
            logger.error(
              "Error generating problem report or auto-fixing:",
              settings.enableAutoFixProblems,
              error,
            );
          }
        }
      }

      // Only save the response and process it if we weren't aborted
      if (!abortController.signal.aborted && fullResponse) {
        // Scrape from: <dyad-chat-summary>Renaming profile file</dyad-chat-title>
        const chatTitle = fullResponse.match(
          /<dyad-chat-summary>(.*?)<\/dyad-chat-summary>/,
        );
        if (chatTitle) {
          await db
            .update(chats)
            .set({ title: chatTitle[1] })
            .where(and(eq(chats.id, req.chatId), isNull(chats.title)));
        }
        const chatSummary = chatTitle?.[1];

        // Update the placeholder assistant message with the full response
        await db
          .update(messages)
          .set({
            content: fullResponse,
            model: targetModel?.name
          })
          .where(eq(messages.id, placeholderAssistantMessage.id));
        const settings = readSettings();
        if (
          settings.autoApproveChanges &&
          settings.selectedChatMode !== "ask"
        ) {
          const status = await processFullResponseActions(
            fullResponse,
            req.chatId,
            {
              chatSummary,
              messageId: placeholderAssistantMessage.id,
            }, // Use placeholder ID
          );

          const chat = await db.query.chats.findFirst({
            where: eq(chats.id, req.chatId),
            with: {
              messages: {
                orderBy: (messages, { asc }) => [asc(messages.createdAt)],
              },
            },
          });

          safeSend(event.sender, "chat:response:chunk", {
            chatId: req.chatId,
            messages: chat!.messages,
          });

          // Handle correction requests from router model
          if (status.needsCorrection && status.correctivePrompt) {
            logger.info('Response needs correction - router provided guidance');

            // Send correction notification to user
            safeSend(event.sender, "chat:response:chunk", {
              chatId: req.chatId,
              messages: [
                ...chat!.messages,
                {
                  id: -1, // Temporary ID for system message
                  chatId: req.chatId,
                  role: 'user',
                  content: `[System: Correcting response]\n\n${status.correctivePrompt}`,
                  createdAt: new Date().toISOString(),
                  model: null,
                } as any,
              ],
            });

            // Insert corrective instruction as user message
            const [correctionMessage] = await db.insert(messages).values({
              chatId: req.chatId,
              role: 'user',
              content: `${status.correctivePrompt}\n\nPlease fix your previous response according to these instructions.`,
            }).returning();

            logger.info('Correction message inserted, continuing stream with guidance');
            // The next iteration will pick up the correction in context
            // No need to explicitly retry - model will see correction in message history
          }

          if (status.error) {
            safeSend(event.sender, "chat:response:error", {
              chatId: req.chatId,
              error: `Sorry, there was an error applying the AI's changes: ${status.error}`,
            });
          }

          // Signal that the stream has completed
          safeSend(event.sender, "chat:response:end", {
            chatId: req.chatId,
            updatedFiles: status.updatedFiles ?? false,
            extraFiles: status.extraFiles,
            extraFilesError: status.extraFilesError,
          } satisfies ChatResponseEnd);
        } else {
          safeSend(event.sender, "chat:response:end", {
            chatId: req.chatId,
            updatedFiles: false,
          } satisfies ChatResponseEnd);
        }
      }

      // Clean up any temporary files
      if (attachmentPaths.length > 0) {
        for (const filePath of attachmentPaths) {
          try {
            // We don't immediately delete files because they might be needed for reference
            // Instead, schedule them for deletion after some time
            setTimeout(
              async () => {
                if (fs.existsSync(filePath)) {
                  await unlink(filePath);
                  logger.log(`Deleted temporary file: ${filePath}`);
                }
              },
              30 * 60 * 1000,
            ); // Delete after 30 minutes
          } catch (error) {
            logger.error(`Error scheduling file deletion: ${error}`);
          }
        }
      }

      // Return the chat ID for backwards compatibility
      return req.chatId;
    } catch (error) {
      // Check if this was an abort error
      if (abortController.signal.aborted) {
        const chatId = req.chatId;
        const partialResponse = partialResponses.get(req.chatId);
        // If we have a partial response, save it to the database
        if (partialResponse) {
          try {
            // Update the placeholder assistant message with the partial content and cancellation note
            await db
              .update(messages)
              .set({
                content: `${partialResponse}

[Response cancelled by user]`,
              })
              .where(eq(messages.id, placeholderAssistantMessage.id));

            logger.log(
              `Updated cancelled response for placeholder message ${placeholderAssistantMessage.id} in chat ${chatId}`,
            );
            partialResponses.delete(req.chatId);
          } catch (saveError) {
            logger.error(
              `Error saving partial response for chat ${chatId}:`,
              saveError,
            );
          }
        }
        return req.chatId;
      }

      logger.error("Error calling LLM:", error);
      safeSend(event.sender, "chat:response:error", {
        chatId: req.chatId,
        error: `Sorry, there was an error processing your request: ${error}`,
      });
      // Clean up the abort controller
      activeStreams.delete(req.chatId);
      // Clean up file uploads state on error
      FileUploadsState.getInstance().clear(req.chatId);
      return "error";
    }
  });

  // Handler to cancel an ongoing stream
  ipcMain.handle("chat:cancel", async (event, chatId: number) => {
    const abortController = activeStreams.get(chatId);

    if (abortController) {
      // Abort the stream
      abortController.abort();
      activeStreams.delete(chatId);
      logger.log(`Aborted stream for chat ${chatId}`);
    } else {
      logger.warn(`No active stream found for chat ${chatId}`);
    }

    // Send the end event to the renderer
    safeSend(event.sender, "chat:response:end", {
      chatId,
      updatedFiles: false,
    } satisfies ChatResponseEnd);

    // Clean up uploads state for this chat
    try {
      FileUploadsState.getInstance().clear(chatId);
    } catch { }

    return true;
  });
}

export function formatMessagesForSummary(
  messages: { role: string; content: string | undefined }[],
) {
  if (messages.length <= 8) {
    // If we have 8 or fewer messages, include all of them
    return messages
      .map((m) => `<message role="${m.role}">${m.content}</message>`)
      .join("\n");
  }

  // Take first 2 messages and last 6 messages
  const firstMessages = messages.slice(0, 2);
  const lastMessages = messages.slice(-6);

  // Combine them with an indicator of skipped messages
  const combinedMessages = [
    ...firstMessages,
    {
      role: "system",
      content: `[... ${messages.length - 8} messages omitted ...]`,
    },
    ...lastMessages,
  ];

  return combinedMessages
    .map((m) => `<message role="${m.role}">${m.content}</message>`)
    .join("\n");
}

// Helper function to replace text attachment placeholders with full content
async function replaceTextAttachmentWithContent(
  text: string,
  filePath: string,
  fileName: string,
): Promise<string> {
  try {
    if (await isTextFile(filePath)) {
      // Read the full content
      const fullContent = await readFile(filePath, "utf-8");

      // Replace the placeholder tag with the full content
      const escapedPath = filePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const tagPattern = new RegExp(
        `<dyad-text-attachment filename="[^"]*" type="[^"]*" path="${escapedPath}">\\s*<\\/dyad-text-attachment>`,
        "g",
      );

      const replacedText = text.replace(
        tagPattern,
        `Full content of ${fileName}:\n\`\`\`\n${fullContent}\n\`\`\``,
      );

      logger.log(
        `Replaced text attachment content for: ${fileName} - length before: ${text.length} - length after: ${replacedText.length}`,
      );
      return replacedText;
    }
    return text;
  } catch (error) {
    logger.error(`Error processing text file: ${error}`);
    return text;
  }
}

// Helper function to convert traditional message to one with proper image attachments
async function prepareMessageWithAttachments(
  message: ModelMessage,
  attachmentPaths: string[],
): Promise<ModelMessage> {
  let textContent = message.content;
  // Get the original text content
  if (typeof textContent !== "string") {
    logger.warn(
      "Message content is not a string - shouldn't happen but using message as-is",
    );
    return message;
  }

  // Process text file attachments - replace placeholder tags with full content
  for (const filePath of attachmentPaths) {
    const fileName = path.basename(filePath);
    textContent = await replaceTextAttachmentWithContent(
      textContent,
      filePath,
      fileName,
    );
  }

  // For user messages with attachments, create a content array
  const contentParts: (TextPart | ImagePart)[] = [];

  // Add the text part first with possibly modified content
  contentParts.push({
    type: "text",
    text: textContent,
  });

  // Add image parts for any image attachments
  for (const filePath of attachmentPaths) {
    const ext = path.extname(filePath).toLowerCase();
    if ([".jpg", ".jpeg", ".png", ".gif", ".webp"].includes(ext)) {
      try {
        // Read the file as a buffer
        const imageBuffer = await readFile(filePath);

        // Add the image to the content parts
        contentParts.push({
          type: "image",
          image: imageBuffer,
        });

        logger.log(`Added image attachment: ${filePath}`);
      } catch (error) {
        logger.error(`Error reading image file: ${error}`);
      }
    }
  }

  // Return the message with the content array
  return {
    role: "user",
    content: contentParts,
  };
}

function removeNonEssentialTags(text: string): string {
  return removeProblemReportTags(removeThinkingTags(text));
}

function removeThinkingTags(text: string): string {
  const thinkRegex = /<think>([\s\S]*?)<\/think>/g;
  return text.replace(thinkRegex, "").trim();
}

export function removeProblemReportTags(text: string): string {
  const problemReportRegex =
    /<dyad-problem-report[^>]*>[\s\S]*?<\/dyad-problem-report>/g;
  return text.replace(problemReportRegex, "").trim();
}

export function removeDyadTags(text: string): string {
  const dyadRegex = /<dyad-[^>]*>[\s\S]*?<\/dyad-[^>]*>/g;
  return text.replace(dyadRegex, "").trim();
}

export function hasUnclosedDyadWrite(text: string): boolean {
  // Find the last opening dyad-write tag
  const openRegex = /<dyad-write[^>]*>/g;
  let lastOpenIndex = -1;
  let match;

  while ((match = openRegex.exec(text)) !== null) {
    lastOpenIndex = match.index;
  }

  // If no opening tag found, there's nothing unclosed
  if (lastOpenIndex === -1) {
    return false;
  }

  // Look for a closing tag after the last opening tag
  const textAfterLastOpen = text.substring(lastOpenIndex);
  const hasClosingTag = /<\/dyad-write>/.test(textAfterLastOpen);

  return !hasClosingTag;
}

function escapeDyadTags(text: unknown): string {
  // Tool outputs can return structured objects. Convert them to strings
  // before escaping so we do not crash while trying to call .replace.
  let safeText: string;
  if (typeof text === "string") {
    safeText = text;
  } else if (text === null || text === undefined) {
    safeText = "";
  } else if (typeof text === "object") {
    try {
      safeText = JSON.stringify(text, null, 2);
    } catch {
      safeText = String(text);
    }
  } else {
    safeText = String(text);
  }

  // Escape dyad tags in reasoning content
  // We are replacing the opening tag with a look-alike character
  // to avoid issues where thinking content includes dyad tags
  // and are mishandled by:
  // 1. FE markdown parser
  // 2. Main process response processor
  return safeText
    .replace(/<dyad/g, "＜dyad")
    .replace(/<\/dyad/g, "＜/dyad");
}

const CODEBASE_PROMPT_PREFIX = "This is my codebase.";
function createCodebasePrompt(codebaseInfo: string): string {
  return `${CODEBASE_PROMPT_PREFIX} ${codebaseInfo}`;
}

function createOtherAppsCodebasePrompt(otherAppsCodebaseInfo: string): string {
  return `
# Referenced Apps

These are the other apps that I've mentioned in my prompt. These other apps' codebases are READ-ONLY.

${otherAppsCodebaseInfo}
`;
}

function combineToolSets(
  ...toolSets: Array<ToolSet | undefined>
): ToolSet | undefined {
  const merged: ToolSet = {};
  for (const set of toolSets) {
    if (!set) continue;
    Object.assign(merged, set);
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
}

function getGeminiApiKeyFromSettings(
  settings: UserSettings,
): string | undefined {
  return (
    settings.providerSettings?.google?.apiKey?.value ||
    process.env.GEMINI_API_KEY ||
    process.env.GOOGLE_API_KEY ||
    process.env.GENERATIVE_LANGUAGE_API_KEY
  );
}

function createWebSearchTool({
  settings,
  abortSignal,
}: {
  settings: UserSettings;
  abortSignal: AbortSignal;
}): ToolSet | undefined {
  if (!settings.enableProWebSearch) {
    return undefined;
  }

  return {
    "web-search": {
      description:
        "Search the web for CONCEPTUAL documentation and general information. DO NOT use for: API documentation (use curl instead), JSON data (use curl instead), package info (use npm view instead), or local codebase exploration (use ls/grep/cat instead). ONLY use for conceptual guides, tutorials, best practices, and information that cannot be fetched directly via HTTP or command-line tools.",
      inputSchema: z.object({
        query: z
          .string()
          .describe(
            "A concise search query that describes the information you need.",
          ),
      }),
      execute: async ({ query }: { query: string }) => {
        const trimmedQuery = (query || "").trim();
        if (!trimmedQuery) {
          return `<dyad-web-search-result>Please provide a search query.</dyad-web-search-result>`;
        }

        const apiKey = getGeminiApiKeyFromSettings(settings);
        if (!apiKey) {
          return `<dyad-web-search>${escapeXml(
            trimmedQuery,
          )}</dyad-web-search>
<dyad-web-search-result>Gemini web search is not configured. Please set a Google Gemini API key.</dyad-web-search-result>`;
        }

        const result = await maybeRunGeminiWebSearch({
          query: trimmedQuery,
          apiKey,
          abortSignal,
        });

        if (!result) {
          return `<dyad-web-search>${escapeXml(
            trimmedQuery,
          )}</dyad-web-search>
<dyad-web-search-result>Unable to retrieve web results right now.</dyad-web-search-result>`;
        }

        return `<dyad-web-search>${escapeXml(
          result.query,
        )}</dyad-web-search>
<dyad-web-search-result>${result.markdown}</dyad-web-search-result>`;
      },
    },
  };
}

async function getMcpTools(event: IpcMainInvokeEvent): Promise<ToolSet> {
  const mcpToolSet: ToolSet = {};
  try {
    const servers = await db
      .select()
      .from(mcpServers)
      .where(eq(mcpServers.enabled, true as any));
    for (const s of servers) {
      const client = await mcpManager.getClient(s.id);
      const toolSet = await client.tools();
      for (const [name, tool] of Object.entries(toolSet)) {
        const key = `${String(s.name || "").replace(/[^a-zA-Z0-9_-]/g, "-")}__${String(name).replace(/[^a-zA-Z0-9_-]/g, "-")}`;
        const original = tool;
        mcpToolSet[key] = {
          description: original?.description,
          inputSchema: original?.inputSchema,
          execute: async (args: any, execCtx: any) => {
            const inputPreview =
              typeof args === "string"
                ? args
                : Array.isArray(args)
                  ? args.join(" ")
                  : JSON.stringify(args).slice(0, 500);
            const ok = await requireMcpToolConsent(event, {
              serverId: s.id,
              serverName: s.name,
              toolName: name,
              toolDescription: original?.description,
              inputPreview,
            });

            if (!ok) throw new Error(`User declined running tool ${key}`);
            const res = await original.execute?.(args, execCtx);

            return typeof res === "string" ? res : JSON.stringify(res);
          },
        };
      }
    }
  } catch (e) {
    logger.warn("Failed building MCP toolset", e);
  }
  return mcpToolSet;
}
