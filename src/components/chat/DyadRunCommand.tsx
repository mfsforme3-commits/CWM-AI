"use client";

import React, { useState } from "react";
import { useAtomValue } from "jotai";
import { selectedAppIdAtom } from "@/atoms/appAtoms";
import { Button } from "@/components/ui/button";
import { IpcClient } from "@/ipc/ipc_client";
import { showError, showWarning } from "@/lib/toast";

interface DyadRunCommandProps {
  command: string;
  autorun?: boolean;
}

export const DyadRunCommand: React.FC<DyadRunCommandProps> = ({
  command,
  autorun = false,
}) => {
  const appId = useAtomValue(selectedAppIdAtom);
  const [isRunning, setIsRunning] = useState(false);
  const [hasAutoRun, setHasAutoRun] = useState(false);

  const trimmedCommand = command.trim();
  const normalizedCommand = trimmedCommand.replace(/\s+/g, " ");

  const handleRun = async () => {
    if (!normalizedCommand) {
      return;
    }

    if (!appId) {
      showWarning("Select an app before running commands.");
      return;
    }

    const confirmed = window.confirm(
      `Run "${trimmedCommand}" inside your app workspace?`,
    );
    if (!(autorun && isSafeFlutterCommand(normalizedCommand))) {
      const confirmed = window.confirm(
        `Run "${normalizedCommand}" inside your app workspace?`,
      );
      if (!confirmed) {
        return;
      }
    }

    setIsRunning(true);
    try {
      await IpcClient.getInstance().runAppCommand({
        appId,
        command: normalizedCommand,
      });
      if (autorun) {
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
      autorun &&
      !hasAutoRun &&
      isSafeFlutterCommand(normalizedCommand) &&
      trimmedCommand &&
      appId
    ) {
      handleRun();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autorun, hasAutoRun, normalizedCommand, trimmedCommand, appId]);

  const isAutoAllowed = autorun && isSafeFlutterCommand(normalizedCommand);

  return (
    <div className="my-3 rounded-md border border-border bg-muted/40 p-3 text-sm">
      <p className="text-xs text-muted-foreground mb-2">
        Command suggested by the assistant:
      </p>
      <pre className="mb-3 overflow-x-auto rounded bg-background px-3 py-2 text-xs font-mono">
        {normalizedCommand}
      </pre>
      {isAutoAllowed && (
        <p className="text-xs text-muted-foreground mb-2">
          Auto-run enabled for safe Flutter commands.
        </p>
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
  return (
    command.startsWith("flutter create") ||
    command.startsWith("flutter pub get") ||
    command.startsWith("flutter run")
  );
}
