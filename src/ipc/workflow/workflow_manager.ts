import { db } from "../../db";
import { chats } from "../../db/schema";
import { eq } from "drizzle-orm";
import log from "electron-log";

const logger = log.scope("workflow-manager");

export type WorkflowStep = "planning" | "docs" | "frontend" | "backend" | "testing";

export const WORKFLOW_STEPS: WorkflowStep[] = ["planning", "docs", "frontend", "backend", "testing"];

export class WorkflowManager {
  static async getChatState(chatId: number) {
    const chat = await db.query.chats.findFirst({
      where: eq(chats.id, chatId),
      columns: {
        workflowStatus: true,
        workflowStep: true,
      }
    });
    return chat;
  }

  static async startWorkflow(chatId: number) {
    logger.info(`Starting workflow for chat ${chatId}`);
    await db.update(chats)
      .set({
        workflowStatus: "active",
        workflowStep: "planning"
      })
      .where(eq(chats.id, chatId));
    return "planning";
  }

  static async stopWorkflow(chatId: number) {
    logger.info(`Stopping workflow for chat ${chatId}`);
    await db.update(chats)
      .set({
        workflowStatus: "idle",
        workflowStep: null
      })
      .where(eq(chats.id, chatId));
  }

  static async forceStep(chatId: number, step: WorkflowStep) {
    logger.info(`Forcing workflow step for chat ${chatId} to ${step}`);
    await db.update(chats)
      .set({
        workflowStatus: "active",
        workflowStep: step
      })
      .where(eq(chats.id, chatId));
    return step;
  }

  static async advanceStep(chatId: number): Promise<WorkflowStep | null> {
    const chat = await this.getChatState(chatId);
    if (!chat || chat.workflowStatus !== "active") {
        logger.warn(`Cannot advance step: Workflow not active for chat ${chatId}`);
        return null;
    }

    const currentStepIndex = WORKFLOW_STEPS.indexOf(chat.workflowStep as WorkflowStep);
    
    if (currentStepIndex === -1) {
        // Invalid state, reset or start over? Let's start at planning.
        logger.warn(`Invalid step ${chat.workflowStep}, resetting to planning`);
        await this.forceStep(chatId, "planning");
        return "planning";
    }

    if (currentStepIndex === WORKFLOW_STEPS.length - 1) {
      // Finished
      logger.info(`Workflow finished for chat ${chatId}`);
      await db.update(chats)
        .set({ workflowStatus: "idle", workflowStep: null })
        .where(eq(chats.id, chatId));
      return null;
    }

    const nextStep = WORKFLOW_STEPS[currentStepIndex + 1];
    logger.info(`Advancing workflow for chat ${chatId} from ${chat.workflowStep} to ${nextStep}`);
    await db.update(chats)
      .set({ workflowStep: nextStep })
      .where(eq(chats.id, chatId));
    
    return nextStep;
  }

  static getTaskTypeForStep(step: WorkflowStep): "frontend" | "backend" | "debugging" | "general" {
    switch (step) {
      case "frontend": return "frontend";
      case "backend": return "backend";
      case "testing": return "debugging";
      case "planning": 
      case "docs":
      default: return "general";
    }
  }

  static getSystemPromptForStep(step: WorkflowStep): string {
    const prefix = `\n\n# Workflow Step: ${step.toUpperCase()}\n`;
    const checklistInstruction = "\n\n## CHECKLIST REQUIREMENT\nYou must output a checklist of what you have done at the end of your response using markdown checkboxes (e.g., - [x] Task).";
    
    switch (step) {
      case "planning":
        return prefix + "You are a Software Architect. Analyze the request and create a detailed implementation plan. Break down the task into logical components. Do not write code yet. Output the plan in Markdown. Be concise but thorough." + checklistInstruction;
      case "docs":
        return prefix + "You are a Technical Writer. Create or update documentation based on the architecture plan. Ensure 'README.md' and 'docs/architecture.md' (if applicable) are up to date. Verify file paths." + checklistInstruction;
      case "frontend":
        return prefix + "You are a Frontend Developer. Implement the UI components and pages based on the plan. Use Shadcn UI and Tailwind CSS. Focus on creating a polished, responsive, and functional UI. Batch your file edits to avoid partial states." + checklistInstruction;
      case "backend":
        return prefix + "You are a Backend Developer. Implement the API routes, database schema, and server logic. Ensure data integrity and error handling. Follow the project's architectural patterns." + checklistInstruction;
      case "testing":
        return prefix + "You are a QA Engineer. Write and run tests (Vitest/Playwright) to verify the implementation. Fix any bugs found. Ensure the application runs smoothly." + checklistInstruction;
      default:
        return "";
    }
  }
}
