#!/bin/bash

PROMPT="$1"

# Determine how to run Codex
if [[ "$CODEX_CMD" == "node" ]]; then
    # We need to use eval or just construct the command carefully
    # CODEX_ARGS contains the path to the js file
    CODEX_EXEC="node $CODEX_ARGS"
else
    CODEX_EXEC="$CODEX_BIN"
fi

echo "Running Codex..." >&2

# We use a temp file for output to avoid pipe issues
TEMP_OUT=$(mktemp)

# Execute Codex
# We pass the prompt. Note: Codex CLI might expect prompt as argument or stdin.
# Based on codex_provider.ts: args.push(promptText)
# We explicitly set reasoning_effort to medium to avoid 'xhigh' error with gpt-5.1-codex
$CODEX_EXEC exec --experimental-json -m gpt-5-codex -c reasoning_effort=medium "$PROMPT" > "$TEMP_OUT" 2>&1

# Read output
CODEX_RAW=$(cat "$TEMP_OUT")
rm "$TEMP_OUT"

# Extract text.
if command -v jq &> /dev/null; then
    CODEX_TEXT=$(echo "$CODEX_RAW" | jq -r 'select(.type=="item.completed" and .item.type=="assistant_message") | .item.text' | head -n 1)
else
    CODEX_TEXT=$(echo "$CODEX_RAW" | grep '"type":"item.completed"' | grep '"assistant_message"' | sed -E 's/.*"text":"(.*)","index".*/\1/')
    # Decode unicode escapes if any (python is good for this, or node)
    if [ -n "$CODEX_TEXT" ]; then
        CODEX_TEXT=$(echo "$CODEX_TEXT" | node -e 'console.log(JSON.parse(`"` + require("fs").readFileSync("/dev/stdin").toString().trim() + `"`))')
    fi
fi

if [ -z "$CODEX_TEXT" ]; then
    CODEX_TEXT="$CODEX_RAW"
fi

echo "Codex Response:"
echo "$CODEX_TEXT"

echo ""
echo "Running Qwen Review..." >&2

QWEN_PROMPT="Review the following code:\n\n$CODEX_TEXT"

# Execute Qwen
# Qwen CLI: qwen -p "prompt" --output-format json
QWEN_RAW=$($QWEN_BIN -p "$QWEN_PROMPT" --output-format json 2>&1)

# Extract text from Qwen JSON
if command -v jq &> /dev/null; then
    QWEN_TEXT=$(echo "$QWEN_RAW" | jq -r '.candidates[0].content.parts[0].text // empty')
else
    QWEN_TEXT=$(echo "$QWEN_RAW" | node -e '
    try {
        const input = require("fs").readFileSync("/dev/stdin").toString();
        const json = JSON.parse(input);
        if (json.candidates && json.candidates[0] && json.candidates[0].content && json.candidates[0].content.parts) {
            console.log(json.candidates[0].content.parts[0].text);
        } else {
            console.log(input);
        }
    } catch (e) {
        console.log(input);
    }
    ')
fi

echo "--- Qwen Review ---"
echo "$QWEN_TEXT"
