import { useSettings } from "@/hooks/useSettings";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";

export function AutoApproveTerminalCommandsSwitch() {
    const { settings, updateSettings } = useSettings();
    return (
        <div className="flex items-center space-x-2">
            <Switch
                id="auto-approve-terminal"
                checked={!!settings?.autoApproveTerminalCommands}
                onCheckedChange={(checked) => {
                    updateSettings({ autoApproveTerminalCommands: checked });
                }}
            />
            <Label htmlFor="auto-approve-terminal">Auto-approve Terminal Commands</Label>
        </div>
    );
}
