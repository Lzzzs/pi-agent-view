import type {
  RpcCommand,
  RpcExtensionUIRequest,
  RpcResponse,
  RpcSessionState,
  SessionStats,
} from "@earendil-works/pi-coding-agent";

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, Extract<keyof T, K>> : never;

export type RpcCommandBody = DistributiveOmit<RpcCommand, "id">;

export type WorkerProtocolEvent =
  | { type: "rpc_event"; event: Record<string, unknown> }
  | { type: "extension_ui"; request: RpcExtensionUIRequest }
  | { type: "exit"; expected: boolean; error?: Error };

export interface RuntimeSlashCommand {
  name: string;
  description?: string;
  source: "extension" | "prompt" | "skill";
}

export interface WorkerStartResult {
  state: RpcSessionState;
}

export interface WorkerClient {
  readonly processId?: number;
  start(): Promise<WorkerStartResult>;
  prompt(message: string, streamingBehavior?: "steer" | "followUp"): Promise<void>;
  getState(): Promise<RpcSessionState>;
  getMessages(): Promise<unknown[]>;
  getSessionStats(): Promise<SessionStats>;
  getCommands(): Promise<RuntimeSlashCommand[]>;
  getAvailableModels(): Promise<Array<NonNullable<RpcSessionState["model"]>>>;
  compact(customInstructions?: string): Promise<void>;
  setSessionName(name: string): Promise<void>;
  exportHtml(outputPath?: string): Promise<string>;
  setModel(provider: string, modelId: string): Promise<NonNullable<RpcSessionState["model"]>>;
  onEvent(listener: (event: WorkerProtocolEvent) => void): () => void;
  shutdown(): Promise<void>;
}

export function responseData<T>(response: RpcResponse): T {
  if (!response.success) throw new Error(response.error);
  return ("data" in response ? response.data : undefined) as T;
}
