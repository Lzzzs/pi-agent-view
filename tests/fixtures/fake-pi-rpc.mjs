const sessionId = process.env.FAKE_SESSION_ID ?? `fake-${process.pid}`;
const sessionFile = `/tmp/${sessionId}.jsonl`;
const delayMs = Number(process.env.FAKE_DELAY_MS ?? 300);
const startDelayMs = Number(process.env.FAKE_START_DELAY_MS ?? 0);
let firstStateRequest = true;
let isStreaming = false;
let isCompacting = false;
let delayNextMessages = false;
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
          thinkingLevel: "off",
          isStreaming,
          isCompacting,
          steeringMode: "one-at-a-time",
          followUpMode: "one-at-a-time",
          sessionFile,
          sessionId,
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
