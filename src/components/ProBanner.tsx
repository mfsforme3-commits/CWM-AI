// @ts-ignore
import openAiLogo from "../../assets/ai-logos/openai-logo.svg";
// @ts-ignore
import googleLogo from "../../assets/ai-logos/google-logo.svg";
// @ts-ignore
import anthropicLogo from "../../assets/ai-logos/anthropic-logo.svg";
import { IpcClient } from "@/ipc/ipc_client";
import { useState } from "react";
import { KeyRound } from "lucide-react";

import { useSettings } from "@/hooks/useSettings";
import { useUserBudgetInfo } from "@/hooks/useUserBudgetInfo";
import { Button } from "./ui/button";

export function ProBanner() {
  const { settings } = useSettings();
  const { userBudget } = useUserBudgetInfo();

  // If we already have Dyad Pro enabled or a budget, we might show management buttons.
  // But for the purpose of "removing advertisements", we will make this component mostly invisible 
  // or just show functional management buttons if applicable.
  
  if (settings?.enableDyadPro || userBudget) {
    return (
      <div className="mt-6 max-w-2xl mx-auto">
        <ManageDyadProButton />
      </div>
    );
  }

  // Return null instead of showing banners
  return null;
}

export function ManageDyadProButton() {
  return (
    <Button
      variant="outline"
      size="lg"
      className="w-full mt-4 bg-(--background-lighter) text-primary"
      onClick={() => {
        IpcClient.getInstance().openExternalUrl(
          "https://academy.dyad.sh/subscription",
        );
      }}
    >
      <KeyRound aria-hidden="true" />
      Manage Dyad Pro subscription
    </Button>
  );
}

export function SetupDyadProButton() {
  return (
    <Button
      variant="outline"
      size="lg"
      className="w-full mt-4 bg-(--background-lighter) text-primary"
      onClick={() => {
        IpcClient.getInstance().openExternalUrl(
          "https://academy.dyad.sh/settings",
        );
      }}
    >
      <KeyRound aria-hidden="true" />
      Already have Dyad Pro? Add your key
    </Button>
  );
}

// These components are no longer used but kept to avoid breaking imports if any other file imports them (unlikely based on grep but safer)
export function AiAccessBanner() {
  return null;
}

export function SmartContextBanner() {
  return null;
}

export function TurboBanner() {
  return null;
}
