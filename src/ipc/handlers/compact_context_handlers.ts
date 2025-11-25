import { ipcMain } from "electron";
import { db } from "../../db";
import { chats, messages } from "../../db/schema";
import { eq } from "drizzle-orm";
import log from "electron-log";
import { streamText } from "ai";
import { getModelClient } from "../utils/get_model_client";
import { readSettings } from "../../main/settings";
import { getDyadAppPath } from "../../paths/paths";
import { SUMMARIZE_CHAT_SYSTEM_PROMPT } from "../../prompts/summarize_chat_system_prompt";

const logger = log.scope("compact_context_handlers");

interface CompactContextParams {
    chatId: number;
    keepRecentTurns?: number; // Number of recent turns to keep in full
}

interface CompactContextResult {
    success: boolean;
    compactedMessageCount: number;
    keptMessageCount: number;
    error?: string;
}

/**
 * Compacts older messages in a chat by summarizing them while keeping recent messages intact
 */
export function registerCompactContextHandlers() {
    ipcMain.handle(
        "chat:compact-context",
        async (_, params: CompactContextParams): Promise<CompactContextResult> => {
            const { chatId, keepRecentTurns = 5 } = params;

            try {
                logger.info(`Compacting context for chat ${chatId}, keeping ${keepRecentTurns} recent turns`);

                // Get the chat with all messages
                const chat = await db.query.chats.findFirst({
                    where: eq(chats.id, chatId),
                    with: {
                        messages: {
                            orderBy: (messages, { asc }) => [asc(messages.createdAt)],
                        },
                        app: true,
                    },
                });

                if (!chat) {
                    throw new Error(`Chat not found: ${chatId}`);
                }

                // Filter out system messages and count user+assistant pairs
                const userAssistantMessages = chat.messages.filter(
                    (m) => m.role === "user" || m.role === "assistant"
                );

                // Calculate how many messages to keep (keepRecentTurns * 2 for user+assistant pairs)
                const messagesToKeep = keepRecentTurns * 2;

                if (userAssistantMessages.length <= messagesToKeep) {
                    logger.info("Not enough messages to compact");
                    return {
                        success: false,
                        compactedMessageCount: 0,
                        keptMessageCount: userAssistantMessages.length,
                        error: "Not enough messages to compact. Need more than the keep threshold.",
                    };
                }

                // Split messages into old (to compress) and recent (to keep)
                const messagesToCompress = userAssistantMessages.slice(0, -messagesToKeep);
                const messagesToKeepIntact = userAssistantMessages.slice(-messagesToKeep);

                logger.info(`Compressing ${messagesToCompress.length} messages, keeping ${messagesToKeepIntact.length} intact`);

                // Create a summary prompt for the AI
                const conversationText = messagesToCompress
                    .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
                    .join("\n\n");

                const summaryPrompt = `Summarize the following conversation history. Focus on:
- Key decisions and progress made
- Important file changes or features implemented
- Technical details that might be relevant later
- Any unresolved issues or pending tasks

Keep the summary concise but comprehensive (3-5 bullet points).

Conversation to summarize:
${conversationText}`;

                // Get AI model to summarize
                const settings = readSettings();
                const appPath = getDyadAppPath(chat.app.path);
                const { modelClient } = await getModelClient(
                    settings.selectedModel,
                    settings,
                    appPath
                );

                let summary = "";
                const summaryStream = await streamText({
                    model: modelClient.model,
                    system: SUMMARIZE_CHAT_SYSTEM_PROMPT,
                    messages: [{ role: "user", content: summaryPrompt }],
                });

                for await (const chunk of summaryStream.textStream) {
                    summary += chunk;
                }

                logger.info("Generated summary:", summary);

                // Delete the old messages from DB
                for (const msg of messagesToCompress) {
                    await db.delete(messages).where(eq(messages.id, msg.id));
                }

                // Insert a new user message with the summary at the beginning
                await db.insert(messages).values({
                    chatId,
                    role: "user",
                    content: `[Compacted Context Summary]\n\nThe following is a summary of earlier conversation history:\n\n${summary}\n\n---\nRecent conversation continues below...`,
                    createdAt: messagesToCompress[0].createdAt, // Use timestamp of first compressed message
                });

                logger.info("Successfully compacted context");

                return {
                    success: true,
                    compactedMessageCount: messagesToCompress.length,
                    keptMessageCount: messagesToKeepIntact.length,
                };
            } catch (error) {
                logger.error("Error compacting context:", error);
                return {
                    success: false,
                    compactedMessageCount: 0,
                    keptMessageCount: 0,
                    error: (error as Error).message,
                };
            }
        }
    );
}
