const sessionId = process.env.FAKE_SESSION_ID ?? `fake-${process.pid}`;
const sessionFile = `/tmp/${sessionId}.jsonl`;
const delayMs = Number(process.env.FAKE_DELAY_MS ?? 300);
const startDelayMs = Number(process.env.FAKE_START_DELAY_MS ?? 0);
let firstStateRequest = true;
let isStreaming = false;
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
          isCompacting: false,
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
    case "get_messages":
      response("get_messages", command.id, { messages });
      return;
    case "prompt": {
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
      write({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: `working:${sessionId}` },
      });
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
