import { streamText } from "ai";
import { getModelClient } from "./get_model_client";
import type { ValidationViolation } from "./response_validator";
import { CORRECTIVE_AGENT_PROMPT } from "../../prompts/corrective_prompt";
import type { LargeLanguageModel, UserSettings } from "../../lib/schemas";
import log from "electron-log";

const logger = log.scope("corrective_agent");

export interface CorrectionAttemptParams {
    userPrompt: string;
    modelResponse: string;
    violations: ValidationViolation[];
    routerModel: LargeLanguageModel;
    settings: UserSettings;
    appPath: string;
    chatId: number;
}

export interface CorrectionResult {
    shouldRetry: boolean;
    prompt?: string;
    reason?: string;
}

/**
 * Uses the router model to generate corrective instructions for a misbehaving model
 */
export async function attemptCorrection(
    params: CorrectionAttemptParams
): Promise<CorrectionResult> {
    const { userPrompt, modelResponse, violations, routerModel, settings, appPath } = params;

    logger.info("Attempting correction with router model:", routerModel.name);

    try {
        // Format violations for the prompt
        const violationsText = violations
            .map((v) => `- ${v.type}: ${v.message}\n  Context: ${v.context.substring(0, 200)}...`)
            .join("\n");

        // Truncate model response to avoid token limits
        const truncatedResponse =
            modelResponse.length > 1000
                ? modelResponse.substring(0, 1000) + "\n...[truncated]"
                : modelResponse;

        // Build corrective agent prompt
        const prompt = CORRECTIVE_AGENT_PROMPT.replace("{{VIOLATIONS}}", violationsText)
            .replace("{{USER_PROMPT}}", userPrompt)
            .replace("{{MODEL_RESPONSE}}", truncatedResponse);

        // Get router model client
        const { modelClient } = await getModelClient(routerModel, settings, appPath);

        // Stream corrective instruction from router
        let correctiveInstruction = "";
        const stream = await streamText({
            model: modelClient.model,
            messages: [{ role: "user", content: prompt }],
        });

        for await (const chunk of stream.textStream) {
            correctiveInstruction += chunk;
        }

        logger.info("Router generated correction:", correctiveInstruction.substring(0, 200));

        // Extract instruction from tags
        const match = correctiveInstruction.match(
            /<corrective-instruction>([\s\S]*?)<\/corrective-instruction>/
        );

        if (match && match[1]) {
            const instruction = match[1].trim();
            return {
                shouldRetry: true,
                prompt: instruction,
            };
        }

        logger.warn("Router did not provide corrective instruction in expected format");
        return {
            shouldRetry: false,
            reason: "Could not generate corrective instruction (no tags found)",
        };
    } catch (error) {
        logger.error("Correction attempt failed:", error);
        return {
            shouldRetry: false,
            reason: `Correction failed: ${(error as Error).message}`,
        };
    }
}
