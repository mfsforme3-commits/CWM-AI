"use client";

import React, { useState } from "react";
import { useAtomValue } from "jotai";
import { selectedAppIdAtom } from "@/atoms/appAtoms";
import { useSettings } from "@/hooks/useSettings";
import { Button } from "@/components/ui/button";
import { IpcClient } from "@/ipc/ipc_client";
import { showError, showWarning } from "@/lib/toast";

interface DyadRunCommandProps {
  command: string;
  autorun?: boolean;
  chatId?: number | null;
}

export const DyadRunCommand: React.FC<DyadRunCommandProps> = ({
  command,
  autorun = false,
  chatId,
}) => {
  const { settings } = useSettings();
  const appId = useAtomValue(selectedAppIdAtom);
  const [isRunning, setIsRunning] = useState(false);
  const [hasAutoRun, setHasAutoRun] = useState(false);
  const [commandOutput, setCommandOutput] = useState<{
    stdout: string;
    stderr: string;
  } | null>(null);

  const trimmedCommand = command.trim();
  const normalizedCommand = trimmedCommand.replace(/\s+/g, " ");

  // Determine if this is an ephemeral command that should use execCommand
  // instead of runAppCommand (which spawns a long-running process)
  const isEphemeral = isEphemeralCommand(normalizedCommand);

  // Check if auto-run is allowed based on props OR global settings
  const isAutoAllowed =
    (autorun && isSafeFlutterCommand(normalizedCommand)) ||
    (!!settings?.autoApproveTerminalCommands && isEphemeral);

  const handleRun = async () => {
    if (!normalizedCommand) {
      return;
    }

    if (!appId) {
      showWarning("Select an app before running commands.");
      return;
    }

    if (!isAutoAllowed) {
      const confirmed = window.confirm(
        `Run "${normalizedCommand}" inside your app workspace?`,
      );
      if (!confirmed) {
        return;
      }
    }

    setIsRunning(true);
    setCommandOutput(null);

    try {
      if (isEphemeral) {
        // Use execCommand for ephemeral commands to capture output
        const result = await IpcClient.getInstance().execCommand(
          appId,
          normalizedCommand,
        );

        setCommandOutput({
          stdout: result.stdout,
          stderr: result.stderr,
        });

        // If we have a chatId, send the output back to the chat context
        // so the AI can see it.
        if (chatId) {
          const outputContent = (result.stdout || result.stderr) 
            ? `\`\`\`\n${result.stdout ? result.stdout + "\n" : ""}${result.stderr ? "STDERR:\n" + result.stderr : ""}\`\`\``
            : "(no output)";
            
          const outputMessage = `Command \`${normalizedCommand}\` output:\n${outputContent}`;

          // We use streamMessage to inject this into the chat flow
          // Note: This will trigger the AI to respond to the output
          IpcClient.getInstance().streamMessage(outputMessage, {
            chatId,
            selectedComponent: null, // No component context needed for command output
            onUpdate: () => { }, // We don't need to track the response here
            onEnd: () => { },
            onError: () => { },
          });
        }
      } else {
        // Use runAppCommand for long-running processes or those needing PTY
        await IpcClient.getInstance().runAppCommand({
          appId,
          command: normalizedCommand,
        });
      }

      if (isAutoAllowed) {
        setHasAutoRun(true);
      }
    } catch (error) {
      showError(
        error instanceof Error
          ? error.message
          : "Failed to run the requested command.",
      );
    } finally {
      setIsRunning(false);
    }
  };

  React.useEffect(() => {
    if (
      isAutoAllowed &&
      !hasAutoRun &&
      trimmedCommand &&
      appId
    ) {
      handleRun();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAutoAllowed, hasAutoRun, normalizedCommand, trimmedCommand, appId]);

  return (
    <div className="my-3 rounded-md border border-border bg-muted/40 p-3 text-sm">
      <div className="flex items-center justify-between mb-2">
        <p className="text-xs text-muted-foreground">
          Command suggested by the assistant:
        </p>
        {isAutoAllowed && (
          <span className="text-[10px] bg-green-100 dark:bg-green-900 text-green-800 dark:text-green-100 px-1.5 py-0.5 rounded">
            Auto-run
          </span>
        )}
      </div>
      <pre className="mb-3 overflow-x-auto rounded bg-background px-3 py-2 text-xs font-mono">
        {normalizedCommand}
      </pre>

      {commandOutput && (
        <div className="mb-3">
          <p className="text-xs text-muted-foreground mb-1">Output:</p>
          <pre className="overflow-x-auto rounded bg-black text-white px-3 py-2 text-xs font-mono max-h-40 overflow-y-auto">
            {commandOutput.stdout}
            {commandOutput.stderr && (
              <span className="text-red-400 block mt-1">
                STDERR: {commandOutput.stderr}
              </span>
            )}
          </pre>
        </div>
      )}

      <Button
        size="sm"
        onClick={handleRun}
        disabled={!normalizedCommand || isRunning || (isAutoAllowed && hasAutoRun)}
      >
        {isRunning
          ? "Running..."
          : isAutoAllowed && hasAutoRun
            ? "Ran automatically"
            : "Run command"}
      </Button>
    </div>
  );
};

function isSafeFlutterCommand(command: string): boolean {
  // We expand this to include common JS/TS commands for "Turbo" experience
  return (
    command.startsWith("flutter create") ||
    command.startsWith("flutter pub get") ||
    command.startsWith("flutter run") ||
    command.startsWith("npm install") ||
    command.startsWith("npm i") ||
    command.startsWith("npm run build") ||
    command.startsWith("yarn install") ||
    command.startsWith("yarn add") ||
    command.startsWith("pnpm install") ||
    command.startsWith("pnpm add") ||
    command.startsWith("bun install") ||
    command.startsWith("bun add") ||
    isEphemeralCommand(command)
  );
}

function isEphemeralCommand(command: string): boolean {
  const cmd = command.trim();
  const safePrefixes = [
    "ls", "pwd", "cat", "find", "grep", "echo", "dir", "whoami", "date",
    "git status", "git log", "git diff", "git show", "git branch",
    "node -v", "npm -v", "npm list", "flutter --version", "dart --version",
    "tree", "head", "tail", "wc", "du", "df", "ps", "who", "id", "uname", "uptime",
    "printenv", "env",
    "curl", "wget",
    "npm test", "npm run test", "npm audit", "npm outdated",
    "flutter doctor", "flutter analyze", "flutter test", "flutter pub outdated"
  ];
  
  return safePrefixes.some(prefix => cmd.startsWith(prefix));
}
