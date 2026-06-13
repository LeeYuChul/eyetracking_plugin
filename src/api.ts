import {
  AnalysisBundle,
  ExportedFlowPayload,
  FrameInfo,
  PLUGIN_VERSION,
  TargetResult,
  ChatEndpointMode,
  UxEvaluationResponse,
  UxStreamEvent,
  VisualArtifact
} from "./types";

const FLOW_ANALYZE_PATH = "/api/v1/flow/analyze";
const PREPARE_TARGET_PATH = "/api/v1/flow/prepare-target";
const UX_CHAT_PATH = "/api/v1/ux/chat";
const UX_CHAT_STREAM_PATH = "/api/v1/ux/chat/stream";
const UX_HEURISTIC_CHAT_PATH = "/api/v1/ux/chat/heuristic";

export class AnalysisApiError extends Error {
  status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "AnalysisApiError";
    this.status = status;
  }
}

export async function analyzeFlow(
  apiBaseUrl: string,
  payload: ExportedFlowPayload
): Promise<AnalysisBundle> {
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

  const response = await fetch(buildUrl(apiBaseUrl, FLOW_ANALYZE_PATH), {
    method: "POST",
    body: formData
  });
  return (await readJsonResponse(response)) as AnalysisBundle;
}

export async function prepareTarget(
  apiBaseUrl: string,
  bundle: AnalysisBundle,
  targetFrameId: string
): Promise<TargetResult> {
  const response = await fetch(buildUrl(apiBaseUrl, PREPARE_TARGET_PATH), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      target_frame_id: targetFrameId,
      flow_tree: bundle.flow_tree,
      frames: bundle.frames.map((frame) => ({
        client_frame_id: frame.client_frame_id,
        frame_name: frame.frame_name,
        original_image: frame.artifacts.original,
        heatmap: frame.artifacts.heatmap,
        scanpath_metrics: frame.metrics,
        parsed: frame.parsed
      })),
      options: {
        blur_strength_base: 8,
        temporal_decay_weight: 1,
        scanpath_weight: 0.6
      }
    })
  });
  return (await readJsonResponse(response)) as TargetResult;
}

export async function evaluateUx(
  apiBaseUrl: string,
  bundle: AnalysisBundle,
  targetResult: TargetResult | null,
  question: string,
  previousMessages: { role: "user" | "assistant"; content: string }[],
  endpointMode: ChatEndpointMode
): Promise<UxEvaluationResponse> {
  const requestBody = buildUxRequestBody(bundle, targetResult, question, previousMessages);
  const path = endpointMode === "heuristic" ? UX_HEURISTIC_CHAT_PATH : UX_CHAT_PATH;
  const response = await fetch(buildUrl(apiBaseUrl, path), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: requestBody
  });
  return (await readJsonResponse(response)) as UxEvaluationResponse;
}

export async function evaluateUxStream(
  apiBaseUrl: string,
  bundle: AnalysisBundle,
  targetResult: TargetResult | null,
  question: string,
  previousMessages: { role: "user" | "assistant"; content: string }[],
  onEvent: (event: UxStreamEvent) => void
): Promise<UxEvaluationResponse> {
  const response = await fetch(buildUrl(apiBaseUrl, UX_CHAT_STREAM_PATH), {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
    body: buildUxRequestBody(bundle, targetResult, question, previousMessages)
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

function buildUxRequestBody(
  bundle: AnalysisBundle,
  targetResult: TargetResult | null,
  question: string,
  previousMessages: { role: "user" | "assistant"; content: string }[]
): string {
  const selectedImages = buildSelectedImages(bundle, targetResult);
  return JSON.stringify({
    question,
    target_frame_id: targetResult?.target_frame_id || bundle.flow_tree.ordered_frame_ids[0],
    flow_tree: bundle.flow_tree,
    evidence: {
      frames: bundle.frames.map((frame) => ({
        client_frame_id: frame.client_frame_id,
        frame_name: frame.frame_name,
        parsed: frame.parsed,
        metrics: frame.metrics
      })),
      target_result: targetResult,
      selected_images: selectedImages
    },
    previous_messages: previousMessages
  });
}

function buildSelectedImages(bundle: AnalysisBundle, targetResult: TargetResult | null): VisualArtifact[] {
  const artifacts: VisualArtifact[] = [];
  const targetId = targetResult?.target_frame_id || bundle.flow_tree.ordered_frame_ids[0];
  const targetFrame = bundle.frames.find((frame) => frame.client_frame_id === targetId);
  const pathIds = targetResult?.path_frame_ids || pathToTarget(bundle, targetId);
  const pushed = new Set<string>();

  const pushArtifact = (
    artifact: VisualArtifact | undefined,
    frame: { client_frame_id: string; frame_name: string },
    role: string
  ): void => {
    if (!artifact?.base64) {
      return;
    }
    const key = `${frame.client_frame_id}:${artifact.artifact_type}`;
    if (pushed.has(key)) {
      return;
    }
    pushed.add(key);
    artifacts.push({
      ...artifact,
      frame_id: frame.client_frame_id,
      frame_name: frame.frame_name,
      image_role: role
    } as VisualArtifact);
  };

  if (targetFrame?.artifacts.original) {
    pushArtifact(targetFrame.artifacts.original, targetFrame, "target_original");
  }
  if (targetFrame?.artifacts.heatmap_overlay) {
    pushArtifact(targetFrame.artifacts.heatmap_overlay, targetFrame, "target_heatmap_overlay");
  }
  if (targetFrame?.artifacts.scanpath_overlay) {
    pushArtifact(targetFrame.artifacts.scanpath_overlay, targetFrame, "target_scanpath_overlay");
  }

  pathIds.forEach((frameId) => {
    const frame = bundle.frames.find((item) => item.client_frame_id === frameId);
    if (frame) {
      pushArtifact(frame.artifacts.original, frame, frameId === targetId ? "target_path_original" : "path_original");
    }
  });

  if (targetResult) {
    targetResult.frames.forEach((frame) => {
      const sourceFrame = bundle.frames.find((item) => item.client_frame_id === frame.client_frame_id);
      const frameContext = sourceFrame || { client_frame_id: frame.client_frame_id, frame_name: frame.client_frame_id };
      pushArtifact(frame.artifacts.memory_blur, frameContext, "memory_blur");
      pushArtifact(frame.artifacts.full_overlay, frameContext, "memory_full_overlay");
    });
  }

  bundle.frames.forEach((frame) => {
    pushArtifact(frame.artifacts.original, frame, "flow_original");
  });

  return artifacts.slice(0, 20);
}

function pathToTarget(bundle: AnalysisBundle, targetFrameId: string): string[] {
  for (const flow of bundle.flow_tree.flows) {
    const index = flow.ordered_frame_ids.indexOf(targetFrameId);
    if (index >= 0) {
      return flow.ordered_frame_ids.slice(0, index + 1);
    }
  }
  const fallbackIndex = bundle.flow_tree.ordered_frame_ids.indexOf(targetFrameId);
  return fallbackIndex >= 0 ? bundle.flow_tree.ordered_frame_ids.slice(0, fallbackIndex + 1) : [];
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

function parseSseEvent(chunk: string): UxStreamEvent | null {
  const lines = chunk.split(/\r?\n/);
  let event: UxStreamEvent["event"] = "progress";
  const dataLines: string[] = [];
  lines.forEach((line) => {
    if (line.startsWith("event:")) {
      const value = line.slice(6).trim();
      if (value === "progress" || value === "thinking" || value === "final" || value === "error") {
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
  const data = safeJsonParse(dataLines.join("\n"));
  return {
    event,
    data: asRecord(data) || { message: String(data) }
  };
}

function finalResponseFromEvent(event: UxStreamEvent): UxEvaluationResponse {
  const answer = asRecord(event.data.answer);
  if (!answer) {
    throw new AnalysisApiError("최종 답변 형식이 올바르지 않습니다.", 500);
  }
  return {
    answer: answer as unknown as UxEvaluationResponse["answer"],
    provider: String(event.data.provider || "ollama"),
    model: String(event.data.model || ""),
    storage_policy: "client_must_store_chat_if_needed"
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function buildUrl(apiBaseUrl: string, path: string): string {
  return `${apiBaseUrl.replace(/\/$/, "")}${path}`;
}
