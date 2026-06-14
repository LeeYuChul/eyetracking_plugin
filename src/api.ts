import {
  ChatEntry,
  ExportedFlowPayload,
  FrameAnalysisBundle,
  FrameAnalysisResult,
  FrameInfo,
  PLUGIN_VERSION,
  UxEvaluationResponse,
  UxStreamEvent,
  VisualArtifact
} from "./types";

const FRAME_ANALYZE_PATH = "/api/v1/frames/analyze";
const FRAME_CHAT_STREAM_PATH = "/api/v1/frames/chat/stream";

export class AnalysisApiError extends Error {
  status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "AnalysisApiError";
    this.status = status;
  }
}

export async function analyzeFrames(apiBaseUrl: string, payload: ExportedFlowPayload): Promise<FrameAnalysisBundle> {
  const formData = new FormData();
  const framesMeta = payload.frames.map((item) => frameToMeta(item.frame, payload.exportScale));

  payload.frames.forEach((item) => {
    const file = new File([copyBytes(item.bytes)], item.frame.fileKey, { type: "image/png" });
    formData.append("files", file);
  });

  formData.append("frames_meta", JSON.stringify(framesMeta));
  formData.append("model_name", "umsi++");
  formData.append(
    "options",
    JSON.stringify({
      source: "figma-plugin",
      plugin_version: PLUGIN_VERSION,
      requested_at: new Date().toISOString()
    })
  );

  const response = await fetch(buildUrl(apiBaseUrl, FRAME_ANALYZE_PATH), {
    method: "POST",
    body: formData
  });
  return (await readJsonResponse(response)) as FrameAnalysisBundle;
}

export async function evaluateFrameStream(
  apiBaseUrl: string,
  frame: FrameAnalysisResult,
  question: string,
  history: ChatEntry[],
  onEvent: (event: UxStreamEvent) => void
): Promise<UxEvaluationResponse> {
  const response = await fetch(buildUrl(apiBaseUrl, FRAME_CHAT_STREAM_PATH), {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
    body: JSON.stringify({
      question,
      frame_id: frame.client_frame_id,
      frame_name: frame.frame_name,
      metrics: frame.metrics,
      selected_images: selectedImagesForFrame(frame),
      previous_messages: history.flatMap((entry) => [
        { role: "user" as const, content: entry.question },
        { role: "assistant" as const, content: entry.answer.conclusion }
      ])
    })
  });

  if (!response.ok || !response.body) {
    return (await readJsonResponse(response)) as UxEvaluationResponse;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let finalResponse: UxEvaluationResponse | null = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split("\n\n");
    buffer = parts.pop() || "";
    for (const part of parts) {
      const event = parseSseEvent(part);
      if (!event) {
        continue;
      }
      onEvent(event);
      if (event.event === "final") {
        finalResponse = finalResponseFromEvent(event);
      }
      if (event.event === "error") {
        throw new AnalysisApiError(extractErrorMessage(event.data), 500);
      }
    }
  }

  if (buffer.trim()) {
    const event = parseSseEvent(buffer);
    if (event) {
      onEvent(event);
      if (event.event === "final") {
        finalResponse = finalResponseFromEvent(event);
      }
      if (event.event === "error") {
        throw new AnalysisApiError(extractErrorMessage(event.data), 500);
      }
    }
  }

  if (!finalResponse) {
    throw new AnalysisApiError("SSE 응답에서 최종 답변을 받지 못했습니다.", 500);
  }
  return finalResponse;
}

export function artifactToDataUrl(artifact: VisualArtifact | undefined): string | undefined {
  if (!artifact?.base64) {
    return undefined;
  }
  if (artifact.base64.startsWith("data:")) {
    return artifact.base64;
  }
  return `data:${artifact.mime_type || "image/png"};base64,${artifact.base64}`;
}

export function selectedImagesForFrame(frame: FrameAnalysisResult): VisualArtifact[] {
  return [
    withImageContext(frame.artifacts.original, frame, "original"),
    withImageContext(frame.artifacts.heatmap_overlay, frame, "heatmap_overlay"),
    withImageContext(frame.artifacts.scanpath_overlay, frame, "scanpath_overlay")
  ].filter((item): item is VisualArtifact => Boolean(item?.base64));
}

export function friendlyErrorMessage(error: unknown): string {
  if (error instanceof AnalysisApiError) {
    if (error.status === 413) {
      return "이미지 용량이 너무 큽니다. Export scale을 낮추거나 프레임 수를 줄여주세요.";
    }
    if (error.status && error.status >= 500) {
      return `서버 분석 중 오류가 발생했습니다. ${error.message}`;
    }
    return error.message;
  }

  if (error instanceof TypeError) {
    return "분석 서버에 연결할 수 없습니다.";
  }

  return "요청을 완료하지 못했습니다.";
}

function withImageContext(
  artifact: VisualArtifact | undefined,
  frame: FrameAnalysisResult,
  role: string
): VisualArtifact | undefined {
  if (!artifact) {
    return undefined;
  }
  return {
    ...artifact,
    frame_id: frame.client_frame_id,
    frame_name: frame.frame_name,
    image_role: role
  };
}

function frameToMeta(frame: FrameInfo, exportScale: number): Record<string, unknown> {
  return {
    client_frame_id: frame.clientFrameId,
    figma_node_id: frame.id,
    frame_name: frame.name,
    width: frame.width,
    height: frame.height,
    export_scale: exportScale,
    file_key: frame.fileKey,
    order_index: frame.orderIndex
  };
}

function copyBytes(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

async function readJsonResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  const payload = text ? safeJsonParse(text) : null;
  if (!response.ok) {
    throw new AnalysisApiError(extractErrorMessage(payload), response.status);
  }
  return payload;
}

function parseSseEvent(chunk: string): UxStreamEvent | null {
  const lines = chunk.split(/\r?\n/);
  let event: UxStreamEvent["event"] = "progress";
  const dataLines: string[] = [];
  lines.forEach((line) => {
    if (line.startsWith("event:")) {
      const value = line.slice(6).trim();
      if (
        value === "progress" ||
        value === "thinking" ||
        value === "thinking_delta" ||
        value === "answer_delta" ||
        value === "final" ||
        value === "error"
      ) {
        event = value;
      }
    }
    if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trimStart());
    }
  });
  if (dataLines.length === 0) {
    return null;
  }
  return { event, data: safeJsonParse(dataLines.join("\n")) as Record<string, unknown> };
}

function finalResponseFromEvent(event: UxStreamEvent): UxEvaluationResponse {
  const answer = event.data.answer as UxEvaluationResponse["answer"];
  return {
    answer,
    provider: String(event.data.provider || "ollama"),
    model: String(event.data.model || "unknown"),
    storage_policy: "client_must_store_chat_if_needed"
  };
}

function extractErrorMessage(payload: unknown): string {
  const record = asRecord(payload);
  if (!record) {
    return "서버 응답을 해석할 수 없습니다.";
  }
  if (typeof record.message === "string") {
    return record.message;
  }
  const detail = asRecord(record.detail);
  if (detail && typeof detail.message === "string") {
    return detail.message;
  }
  return JSON.stringify(payload);
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function buildUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/$/, "")}${path}`;
}
