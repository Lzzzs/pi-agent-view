const sessionId = process.env.FAKE_SESSION_ID ?? `fake-${process.pid}`;
const sessionFile = `/tmp/${sessionId}.jsonl`;
const delayMs = Number(process.env.FAKE_DELAY_MS ?? 300);
const startDelayMs = Number(process.env.FAKE_START_DELAY_MS ?? 0);
let firstStateRequest = true;
let isStreaming = false;
let isCompacting = false;
let delayNextMessages = false;
let currentModel = { provider: "fake", id: "model-a", name: "Model A", contextWindow: 100000, reasoning: false };
let sessionName;
let commandCatalogRequests = 0;
let messages = [];
let buffer = "";

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function response(command, id, data) {
  write({ type: "response", command, success: true, ...(id ? { id } : {}), ...(data !== undefined ? { data } : {}) });
}

function handle(command) {
  switch (command.type) {
    case "get_state": {
      const sendState = () =>
        response("get_state", command.id, {
          model: currentModel,
          thinkingLevel: "off",
          isStreaming,
          isCompacting,
          steeringMode: "one-at-a-time",
          followUpMode: "one-at-a-time",
          sessionFile,
          sessionId,
          ...(sessionName ? { sessionName } : {}),
          autoCompactionEnabled: true,
          messageCount: messages.length,
          pendingMessageCount: 0,
        });
      if (firstStateRequest && startDelayMs > 0) setTimeout(sendState, startDelayMs);
      else sendState();
      firstStateRequest = false;
      return;
    }
    case "get_messages": {
      const snapshot = structuredClone(messages);
      if (delayNextMessages) {
        delayNextMessages = false;
        setTimeout(() => response("get_messages", command.id, { messages: snapshot }), 100);
      } else {
        response("get_messages", command.id, { messages: snapshot });
      }
      return;
    }
    case "get_commands": {
      commandCatalogRequests += 1;
      if (process.env.FAKE_CATALOG_FAILURE === "1") {
        write({ type: "response", command: "get_commands", success: false, id: command.id, error: "catalog unavailable" });
        return;
      }
      const refreshed = process.env.FAKE_ROTATE_COMMANDS === "1" && commandCatalogRequests > 1;
      response("get_commands", command.id, {
        commands: [
          {
            name: refreshed ? "refreshed-command" : "fake-command",
            description: "Fake extension command",
            source: "extension",
            sourceInfo: { path: import.meta.filename },
          },
          { name: "skill:fake", description: "Fake skill", source: "skill", sourceInfo: { path: import.meta.filename } },
        ],
      });
      return;
    }
    case "get_available_models":
      if (process.env.FAKE_CATALOG_FAILURE === "1") {
        write({
          type: "response",
          command: "get_available_models",
          success: false,
          id: command.id,
          error: "models unavailable",
        });
        return;
      }
      response("get_available_models", command.id, {
        models: [currentModel, { provider: "fake", id: "model-b", name: "Model B", contextWindow: 200000, reasoning: true }],
      });
      return;
    case "set_model":
      currentModel = {
        provider: command.provider,
        id: command.modelId,
        name: command.modelId === "model-b" ? "Model B" : "Model A",
        contextWindow: command.modelId === "model-b" ? 200000 : 100000,
        reasoning: command.modelId === "model-b",
      };
      write({ type: "model_select", model: currentModel });
      response("set_model", command.id, currentModel);
      return;
    case "set_session_name":
      sessionName = command.name;
      write({ type: "session_info_changed", name: sessionName });
      response("set_session_name", command.id);
      return;
    case "export_html":
      response("export_html", command.id, { path: command.outputPath ?? `/tmp/${sessionId}.html` });
      return;
    case "compact":
      isCompacting = true;
      write({ type: "compaction_start", reason: "manual" });
      isCompacting = false;
      write({
        type: "compaction_end",
        reason: "manual",
        result: { summary: "rpc compacted transcript", tokensBefore: 100 },
        aborted: false,
        willRetry: false,
      });
      response("compact", command.id, { summary: "rpc compacted transcript", tokensBefore: 100 });
      return;
    case "get_session_stats":
      response("get_session_stats", command.id, {
        sessionFile,
        sessionId,
        userMessages: messages.filter((message) => message.role === "user").length,
        assistantMessages: messages.filter((message) => message.role === "assistant").length,
        toolCalls: 0,
        toolResults: 0,
        totalMessages: messages.length,
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        cost: 0,
      });
      return;
    case "prompt": {
      if (command.message === "reject-queued") {
        write({ type: "response", command: "prompt", success: false, id: command.id, error: "synthetic rejection" });
        return;
      }
      const timestamp = Date.now();
      const user = { role: "user", content: [{ type: "text", text: command.message }], timestamp };
      messages.push(user);
      isStreaming = true;
      response("prompt", command.id);
      write({ type: "agent_start" });
      write({ type: "message_start", message: user });
      write({ type: "message_end", message: user });

      if (command.message === "crash") {
        setTimeout(() => process.exit(23), 80);
        return;
      }

      if (command.message === "same-timestamp-users") {
        const first = { role: "user", content: [{ type: "text", text: "queued-a" }], timestamp: timestamp + 1 };
        const second = { role: "user", content: [{ type: "text", text: "queued-b" }], timestamp: timestamp + 1 };
        messages.push(first, second);
        write({ type: "message_end", message: first });
        write({ type: "message_end", message: second });
        isStreaming = false;
        write({ type: "agent_settled" });
        return;
      }

      if (command.message === "parallel-results") {
        const first = {
          role: "toolResult",
          toolCallId: "tool-a",
          toolName: "read",
          content: [{ type: "text", text: "result-a" }],
          isError: false,
          timestamp: timestamp + 1,
        };
        const second = { ...first, toolCallId: "tool-b", content: [{ type: "text", text: "result-b" }] };
        messages.push(first, second);
        write({ type: "message_end", message: first });
        write({ type: "message_end", message: second });
        isStreaming = false;
        write({ type: "agent_settled" });
        return;
      }

      if (command.message === "slow-compact") {
        isCompacting = true;
        write({ type: "compaction_start", reason: "manual" });
        setTimeout(() => {
          isCompacting = false;
          isStreaming = false;
          write({
            type: "compaction_end",
            reason: "manual",
            result: { summary: "slow compacted transcript", tokensBefore: 100 },
            aborted: false,
            willRetry: false,
          });
          write({ type: "agent_settled" });
        }, 100);
        return;
      }

      if (command.message === "fast-after-compaction") {
        const assistant = {
          role: "assistant",
          content: [{ type: "text", text: "fast-after-compaction-complete" }],
          stopReason: "stop",
          timestamp: timestamp + 1,
        };
        messages.push(assistant);
        write({ type: "message_end", message: assistant });
        isStreaming = false;
        write({ type: "agent_settled" });
        return;
      }

      if (command.message === "compact" || command.message === "compact-race") {
        isCompacting = true;
        write({ type: "compaction_start", reason: "manual" });
        messages = [
          {
            role: "compactionSummary",
            summary: "compacted transcript",
            tokensBefore: 100,
            timestamp: timestamp + 1,
          },
        ];
        isStreaming = false;
        isCompacting = false;
        if (command.message === "compact-race") delayNextMessages = true;
        write({
          type: "compaction_end",
          reason: "manual",
          result: { summary: "compacted transcript", tokensBefore: 100 },
          aborted: false,
          willRetry: false,
        });
        write({ type: "agent_settled" });
        return;
      }

      if (command.message === "agent-error") {
        const assistant = {
          role: "assistant",
          content: [],
          stopReason: "error",
          errorMessage: "synthetic agent failure",
          timestamp: timestamp + 1,
        };
        messages.push(assistant);
        write({ type: "message_end", message: assistant });
        isStreaming = false;
        write({ type: "agent_end", messages: [user, assistant], willRetry: false });
        write({ type: "agent_settled" });
        return;
      }

      const assistantStart = {
        role: "assistant",
        content: [],
        stopReason: "stop",
        timestamp: timestamp + 1,
      };
      write({ type: "message_start", message: assistantStart });
      if (command.message === "stream-tool-args") {
        write({ type: "message_update", assistantMessageEvent: { type: "toolcall_start", contentIndex: 0 } });
        write({
          type: "message_update",
          assistantMessageEvent: { type: "toolcall_delta", contentIndex: 0, delta: '{"path":' },
        });
        write({
          type: "message_update",
          assistantMessageEvent: { type: "toolcall_delta", contentIndex: 0, delta: '"x"}' },
        });
        write({
          type: "message_update",
          assistantMessageEvent: { type: "toolcall_end", contentIndex: 0, toolCall: { type: "toolCall", id: "call-x", name: "read" } },
        });
      } else {
        write({
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: `working:${sessionId}` },
        });
      }
      setTimeout(() => {
        const assistant = {
          ...assistantStart,
          content: [{ type: "text", text: `done:${sessionId}` }],
        };
        messages.push(assistant);
        write({ type: "message_end", message: assistant });
        isStreaming = false;
        write({ type: "agent_end", messages: [user, assistant], willRetry: false });
        write({ type: "agent_settled" });
      }, delayMs);
      return;
    }
    case "extension_ui_response":
      return;
    default:
      write({ type: "response", command: command.type, success: false, id: command.id, error: "unsupported" });
  }
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  while (true) {
    const newline = buffer.indexOf("\n");
    if (newline < 0) break;
    let line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (line.endsWith("\r")) line = line.slice(0, -1);
    if (line) handle(JSON.parse(line));
  }
});
