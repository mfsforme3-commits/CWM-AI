import { GoogleGenerativeAI } from "@google/generative-ai";
import log from "electron-log";

const logger = log.scope("gemini-web-search");

const MAX_QUERY_LENGTH = 2000;

export interface GeminiWebSearchResult {
  query: string;
  markdown: string;
}

let cachedClient: {
  apiKey: string;
  client: GoogleGenerativeAI;
} | null = null;

function getGeminiClient(apiKey: string): GoogleGenerativeAI {
  if (!cachedClient || cachedClient.apiKey !== apiKey) {
    cachedClient = {
      apiKey,
      client: new GoogleGenerativeAI(apiKey),
    };
  }
  return cachedClient.client;
}

export async function maybeRunGeminiWebSearch({
  query,
  apiKey,
  abortSignal,
}: {
  query: string;
  apiKey?: string | null;
  abortSignal?: AbortSignal;
}): Promise<GeminiWebSearchResult | null> {
  if (!apiKey) {
    return null;
  }
  const trimmedQuery = query.trim();
  if (!trimmedQuery) {
    return null;
  }
  if (abortSignal?.aborted) {
    return null;
  }

  try {
    const safeQuery = trimmedQuery.slice(0, MAX_QUERY_LENGTH);
    const client = getGeminiClient(apiKey);
    const searchTool: any = { googleSearch: {} };
    const model = client.getGenerativeModel({
      model: "gemini-2.5-flash",
      tools: [searchTool],
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: 1024,
      },
    });

    const today = new Date().toISOString().split("T")[0];
    const response = await model.generateContent({
      contents: [
        {
          role: "user",
          parts: [
            {
              text: `Today is ${today}. Use the Google Search tool to gather news or documentation published after January 1, 2024 whenever possible. Summarize 3-5 key findings as markdown bullet points, each with an inline [Title](URL) citation. If information is older than 2024 or no relevant sources exist, state "No recent results.".

Request:
${safeQuery}`,
            },
          ],
        },
      ],
    });

    if (abortSignal?.aborted) {
      return null;
    }

    const text = response.response?.text()?.trim();
    if (!text) {
      return null;
    }

    return {
      query: safeQuery,
      markdown: text,
    };
  } catch (error) {
    if (!abortSignal?.aborted) {
      logger.warn("Gemini web search failed", error);
    }
    return null;
  }
}
