import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useSettings } from "@/hooks/useSettings";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { X } from "lucide-react";
import { ModelPicker } from "@/components/ModelPicker";
import type { LargeLanguageModel } from "@/lib/schemas";

export function UltrathinkModelSelector() {
    const { settings, updateSettings } = useSettings();
    const [showUltrathinkPicker, setShowUltrathinkPicker] = useState(false);
    const [showRouterPicker, setShowRouterPicker] = useState(false);

    const handleUltrathinkModelSelect = (model: LargeLanguageModel) => {
        updateSettings({
            ultrathinkModel: model,
        });
        setShowUltrathinkPicker(false);
    };

    const handleRouterModelSelect = (model: LargeLanguageModel) => {
        updateSettings({
            routerModel: model,
        });
        setShowRouterPicker(false);
    };

    const handleClearUltrathinkModel = () => {
        updateSettings({
            ultrathinkModel: undefined,
        });
    };

    const handleClearRouterModel = () => {
        updateSettings({
            routerModel: undefined,
        });
    };

    const getModelDisplayName = (model?: LargeLanguageModel): string => {
        if (!model) return "Not configured";
        return `${model.provider}/${model.name}`;
    };

    return (
        <div className="space-y-4">
            {/* Ultrathink Model */}
            <div className="space-y-2">
                <div className="flex items-center justify-between">
                    <div>
                        <Label className="text-sm font-medium">Ultrathink Model</Label>
                        <p className="text-xs text-gray-500 dark:text-gray-400">
                            Model used for complex reasoning tasks
                        </p>
                    </div>
                    {settings?.ultrathinkModel && (
                        <Button
                            variant="ghost"
                            size="sm"
                            onClick={handleClearUltrathinkModel}
                            className="h-8 px-2"
                        >
                            <X className="h-4 w-4" />
                        </Button>
                    )}
                </div>
                <div className="flex items-center gap-2">
                    <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setShowUltrathinkPicker(!showUltrathinkPicker)}
                        className="text-sm"
                    >
                        {getModelDisplayName(settings?.ultrathinkModel)}
                    </Button>
                </div>
                {showUltrathinkPicker && (
                    <div className="border rounded-lg p-4 bg-gray-50 dark:bg-gray-900">
                        <ModelPicker onModelSelect={handleUltrathinkModelSelect} />
                    </div>
                )}
            </div>

            {/* AI Router */}
            <div className="space-y-2 pt-2 border-t">
                <div className="flex items-center justify-between">
                    <div>
                        <Label htmlFor="enable-router" className="text-sm font-medium">AI Router</Label>
                        <p className="text-xs text-gray-500 dark:text-gray-400">
                            Use AI to intelligently classify prompts and select models
                        </p>
                    </div>
                    <Switch
                        id="enable-router"
                        checked={!!settings?.enableAIRouter}
                        onCheckedChange={(checked) => {
                            updateSettings({ enableAIRouter: checked });
                        }}
                    />
                </div>

                {settings?.enableAIRouter && (
                    <div className="space-y-2 mt-2">
                        <div className="flex items-center justify-between">
                            <div>
                                <Label className="text-sm font-medium">Router Model</Label>
                                <p className="text-xs text-gray-500 dark:text-gray-400">
                                    Fast model for routing (e.g., GPT-4o-mini)
                                </p>
                            </div>
                            {settings?.routerModel && (
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    onClick={handleClearRouterModel}
                                    className="h-8 px-2"
                                >
                                    <X className="h-4 w-4" />
                                </Button>
                            )}
                        </div>
                        <div className="flex items-center gap-2">
                            <Button
                                variant="outline"
                                size="sm"
                                onClick={() => setShowRouterPicker(!showRouterPicker)}
                                className="text-sm"
                            >
                                {getModelDisplayName(settings?.routerModel)}
                            </Button>
                        </div>
                        {showRouterPicker && (
                            <div className="border rounded-lg p-4 bg-gray-50 dark:bg-gray-900">
                                <ModelPicker onModelSelect={handleRouterModelSelect} />
                            </div>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
}
