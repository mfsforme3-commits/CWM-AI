import { useState } from "react";
import { useAtomValue } from "jotai";
import { selectedChatIdAtom, chatMessagesByIdAtom } from "@/atoms/chatAtoms";
import { Button } from "@/components/ui/button";
import { Minimize2, Loader2 } from "lucide-react";
import {
    Tooltip,
    TooltipContent,
    TooltipProvider,
    TooltipTrigger,
} from "@/components/ui/tooltip";
import { IpcClient } from "@/ipc/ipc_client";
import { useSettings } from "@/hooks/useSettings";
import { showSuccess, showError } from "@/lib/toast";

export function CompactContextButton() {
    const chatId = useAtomValue(selectedChatIdAtom);
    const messagesById = useAtomValue(chatMessagesByIdAtom);
    const { settings } = useSettings();
    const [isCompacting, setIsCompacting] = useState(false);

    // Get message count for current chat
    const messages = chatId ? messagesById.get(chatId) || [] : [];
    const messageCount = messages.filter(
        (m) => m.role === "user" || m.role === "assistant"
    ).length;

    // Calculate threshold (default 10 turns = 20 messages)  
    const maxTurns = settings?.maxChatTurnsInContext || 10;
    const threshold = maxTurns * 2;

    // Only show button if message count exceeds threshold
    if (!chatId || messageCount <= threshold) {
        return null;
    }

    const handleCompact = async () => {
        if (!chatId || isCompacting) return;

        setIsCompacting(true);
        try {
            const result = await (window as any).electron.ipcRenderer.invoke("chat:compact-context", {
                chatId,
                keepRecentTurns: 5,
            });

            if (result.success) {
                showSuccess(
                    `Summarized ${result.compactedMessageCount} messages. Kept ${result.keptMessageCount} recent messages.`
                );
            } else {
                showError(result.error || "Unable to compact context");
            }
        } catch (error) {
            showError((error as Error).message);
        } finally {
            setIsCompacting(false);
        }
    };

    return (
        <TooltipProvider>
            <Tooltip>
                <TooltipTrigger asChild>
                    <Button
                        onClick={handleCompact}
                        variant="ghost"
                        className="has-[>svg]:px-2"
                        size="sm"
                        disabled={isCompacting}
                    >
                        {isCompacting ? (
                            <Loader2 size={14} className="animate-spin" />
                        ) : (
                            <Minimize2 size={14} />
                        )}
                    </Button>
                </TooltipTrigger>
                <TooltipContent>
                    <div className="text-xs">
                        <div>Compact context ({messageCount} messages)</div>
                        <div className="text-muted-foreground">
                            Summarize older messages to save tokens
                        </div>
                    </div>
                </TooltipContent>
            </Tooltip>
        </TooltipProvider>
    );
}
