import {
  AnalysisBundle,
  ExportedFlowPayload,
  FrameAnalysisResult,
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
        depth_blur_base: 10,
        depth_blur_step: 10,
        scanpath_weight: 0
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
  const requestBody = await buildUxRequestBody(bundle, targetResult, question, previousMessages);
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
  const requestBody = await buildUxRequestBody(bundle, targetResult, question, previousMessages);
  const response = await fetch(buildUrl(apiBaseUrl, UX_CHAT_STREAM_PATH), {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
    body: requestBody
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

async function buildUxRequestBody(
  bundle: AnalysisBundle,
  targetResult: TargetResult | null,
  question: string,
  previousMessages: { role: "user" | "assistant"; content: string }[]
): Promise<string> {
  const selectedImages = await buildSelectedImages(bundle, targetResult);
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

async function buildSelectedImages(bundle: AnalysisBundle, targetResult: TargetResult | null): Promise<VisualArtifact[]> {
  const artifacts: VisualArtifact[] = [];
  const targetId = targetResult?.target_frame_id || bundle.flow_tree.ordered_frame_ids[0];
  const targetFrame = bundle.frames.find((frame) => frame.client_frame_id === targetId);
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

  if (targetResult) {
    const priorFrameIds = targetResult.path_frame_ids.filter((frameId) => frameId !== targetId);
    const memoryByFrameId = new Map(targetResult.frames.map((frame) => [frame.client_frame_id, frame]));
    for (let index = 0; index < priorFrameIds.length; index += 1) {
      const frameId = priorFrameIds[index];
      const sourceFrame = bundle.frames.find((item) => item.client_frame_id === frameId);
      const memoryFrame = memoryByFrameId.get(frameId);
      if (!sourceFrame || !memoryFrame) {
        continue;
      }
      const cumulativeBlurStrength = priorFrameIds
        .slice(index)
        .reduce((sum, currentFrameId) => sum + depthBlurStrength(memoryByFrameId.get(currentFrameId), targetResult.path_frame_ids, currentFrameId), 0);
      try {
        const clientBlur = await makeClientMemoryBlurArtifact(sourceFrame, cumulativeBlurStrength);
        pushArtifact(clientBlur, sourceFrame, "client_cumulative_memory_blur");
      } catch {
        pushArtifact(memoryFrame.artifacts.memory_blur, sourceFrame, "server_depth_memory_blur_fallback");
      }
    }
  }

  return artifacts.slice(0, 20);
}

function depthBlurStrength(frame: TargetResult["frames"][number] | undefined, pathFrameIds: string[], frameId: string): number {
  if (typeof frame?.memory_metrics.depth_blur_strength === "number") {
    return frame.memory_metrics.depth_blur_strength;
  }
  const index = pathFrameIds.indexOf(frameId);
  const temporalDistance = index >= 0 ? pathFrameIds.length - index - 1 : frame?.temporal_distance || 1;
  return 10 + Math.max(0, temporalDistance) * 10;
}

async function makeClientMemoryBlurArtifact(frame: FrameAnalysisResult, cumulativeBlurStrength: number): Promise<VisualArtifact> {
  const originalImage = await loadArtifactImage(frame.artifacts.original);
  const heatmapImage = await loadArtifactImage(frame.artifacts.heatmap);
  const width = frame.artifacts.original.width || originalImage.naturalWidth;
  const height = frame.artifacts.original.height || originalImage.naturalHeight;
  const originalCanvas = imageToCanvas(originalImage, width, height);
  const blurredCanvas = document.createElement("canvas");
  blurredCanvas.width = width;
  blurredCanvas.height = height;
  const blurredContext = requiredContext(blurredCanvas);
  blurredContext.filter = `blur(${Math.max(1, cumulativeBlurStrength).toFixed(2)}px)`;
  blurredContext.drawImage(originalImage, 0, 0, width, height);

  const heatmapCanvas = imageToCanvas(heatmapImage, width, height);
  const outputCanvas = document.createElement("canvas");
  outputCanvas.width = width;
  outputCanvas.height = height;
  const outputContext = requiredContext(outputCanvas);
  const originalPixels = requiredContext(originalCanvas).getImageData(0, 0, width, height);
  const blurredPixels = blurredContext.getImageData(0, 0, width, height);
  const heatmapPixels = requiredContext(heatmapCanvas).getImageData(0, 0, width, height);
  const outputPixels = outputContext.createImageData(width, height);
  const retentionScale = Math.max(0.08, 1 / (1 + cumulativeBlurStrength / 25));

  for (let offset = 0; offset < outputPixels.data.length; offset += 4) {
    const heatAlpha = heatmapPixels.data[offset + 3] / 255;
    const heatIntensity = (heatmapPixels.data[offset] + heatmapPixels.data[offset + 1] + heatmapPixels.data[offset + 2]) / (255 * 3);
    const clarity = Math.min(1, (heatAlpha + heatIntensity * 0.15) * retentionScale);
    outputPixels.data[offset] = originalPixels.data[offset] * clarity + blurredPixels.data[offset] * (1 - clarity);
    outputPixels.data[offset + 1] = originalPixels.data[offset + 1] * clarity + blurredPixels.data[offset + 1] * (1 - clarity);
    outputPixels.data[offset + 2] = originalPixels.data[offset + 2] * clarity + blurredPixels.data[offset + 2] * (1 - clarity);
    outputPixels.data[offset + 3] = 255;
  }
  outputContext.putImageData(outputPixels, 0, 0);
  const dataUrl = outputCanvas.toDataURL("image/png");
  return {
    artifact_type: "client_cumulative_memory_blur",
    mime_type: "image/png",
    base64: dataUrl.split(",", 2)[1] || dataUrl,
    width,
    height,
    encoding: "base64"
  };
}

function loadArtifactImage(artifact: VisualArtifact): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("이미지를 읽을 수 없습니다."));
    image.src = artifactToDataUrl(artifact) || "";
  });
}

function imageToCanvas(image: HTMLImageElement, width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  requiredContext(canvas).drawImage(image, 0, 0, width, height);
  return canvas;
}

function requiredContext(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("Canvas context를 생성할 수 없습니다.");
  }
  return context;
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
