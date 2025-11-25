import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useSettings } from "@/hooks/useSettings";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { X } from "lucide-react";
import { ModelPicker } from "@/components/ModelPicker";
import type { LargeLanguageModel } from "@/lib/schemas";

export function TaskBasedModelsSelector() {
    const { settings, updateSettings } = useSettings();
    const [showFrontendPicker, setShowFrontendPicker] = useState(false);
    const [showBackendPicker, setShowBackendPicker] = useState(false);
    const [showDebuggingPicker, setShowDebuggingPicker] = useState(false);

    const isEnabled = settings?.taskModels?.useTaskBasedSwitching ?? false;

    const handleToggle = (checked: boolean) => {
        updateSettings({
            taskModels: {
                ...settings?.taskModels,
                useTaskBasedSwitching: checked,
            },
        });
    };

    const handleModelSelect = (
        taskType: "frontend" | "backend" | "debugging",
        model: LargeLanguageModel,
    ) => {
        updateSettings({
            taskModels: {
                ...settings?.taskModels,
                [taskType]: model,
            },
        });

        // Close the picker
        if (taskType === "frontend") setShowFrontendPicker(false);
        if (taskType === "backend") setShowBackendPicker(false);
        if (taskType === "debugging") setShowDebuggingPicker(false);
    };

    const handleClearModel = (taskType: "frontend" | "backend" | "debugging") => {
        updateSettings({
            taskModels: {
                ...settings?.taskModels,
                [taskType]: undefined,
            },
        });
    };

    const getModelDisplayName = (model?: LargeLanguageModel): string => {
        if (!model) return "Not configured";
        return `${model.provider}/${model.name}`;
    };

    return (
        <div className="space-y-4">
            <div className="flex items-center justify-between">
                <div className="space-y-1">
                    <Label htmlFor="task-switching">Task-Based Model Switching</Label>
                    <p className="text-sm text-gray-500 dark:text-gray-400">
                        Automatically use different models for frontend, backend, and
                        debugging tasks
                    </p>
                </div>
                <Switch
                    id="task-switching"
                    checked={isEnabled}
                    onCheckedChange={handleToggle}
                />
            </div>

            {isEnabled && (
                <div className="space-y-4 pt-2 border-t">
                    <div className="text-sm text-gray-500 dark:text-gray-400">
                        <p>
                            Configure specialized models for different task types. Dyad will
                            analyze your prompts and automatically select the appropriate
                            model.
                        </p>
                        <p className="mt-2">
                            <strong>Note:</strong> If not configured, tasks will use your
                            main selected model.
                        </p>
                    </div>

                    {/* Frontend Model */}
                    <div className="space-y-2">
                        <div className="flex items-center justify-between">
                            <div>
                                <Label className="text-sm font-medium">Frontend Model</Label>
                                <p className="text-xs text-gray-500 dark:text-gray-400">
                                    Used for UI components, styling, and user interactions
                                </p>
                            </div>
                            {settings?.taskModels?.frontend && (
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    onClick={() => handleClearModel("frontend")}
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
                                onClick={() => setShowFrontendPicker(!showFrontendPicker)}
                                className="text-sm"
                            >
                                {getModelDisplayName(settings?.taskModels?.frontend)}
                            </Button>
                        </div>
                        {showFrontendPicker && (
                            <div className="border rounded-lg p-4 bg-gray-50 dark:bg-gray-900">
                                <ModelPicker
                                    onModelSelect={(model) => handleModelSelect("frontend", model)}
                                />
                            </div>
                        )}
                    </div>

                    {/* Backend Model */}
                    <div className="space-y-2">
                        <div className="flex items-center justify-between">
                            <div>
                                <Label className="text-sm font-medium">Backend Model</Label>
                                <p className="text-xs text-gray-500 dark:text-gray-400">
                                    Used for APIs, databases, and server logic
                                </p>
                            </div>
                            {settings?.taskModels?.backend && (
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    onClick={() => handleClearModel("backend")}
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
                                onClick={() => setShowBackendPicker(!showBackendPicker)}
                                className="text-sm"
                            >
                                {getModelDisplayName(settings?.taskModels?.backend)}
                            </Button>
                        </div>
                        {showBackendPicker && (
                            <div className="border rounded-lg p-4 bg-gray-50 dark:bg-gray-900">
                                <ModelPicker
                                    onModelSelect={(model) => handleModelSelect("backend", model)}
                                />
                            </div>
                        )}
                    </div>

                    {/* Debugging Model */}
                    <div className="space-y-2">
                        <div className="flex items-center justify-between">
                            <div>
                                <Label className="text-sm font-medium">Debugging Model</Label>
                                <p className="text-xs text-gray-500 dark:text-gray-400">
                                    Used for error analysis and systematic fixes
                                </p>
                            </div>
                            {settings?.taskModels?.debugging && (
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    onClick={() => handleClearModel("debugging")}
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
                                onClick={() => setShowDebuggingPicker(!showDebuggingPicker)}
                                className="text-sm"
                            >
                                {getModelDisplayName(settings?.taskModels?.debugging)}
                            </Button>
                        </div>
                        {showDebuggingPicker && (
                            <div className="border rounded-lg p-4 bg-gray-50 dark:bg-gray-900">
                                <ModelPicker
                                    onModelSelect={(model) =>
                                        handleModelSelect("debugging", model)
                                    }
                                />
                            </div>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
}
