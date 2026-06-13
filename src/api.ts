import {
  AnalysisBundle,
  ExportedFlowPayload,
  FrameInfo,
  PLUGIN_VERSION,
  TargetResult,
  UxEvaluationResponse,
  VisualArtifact
} from "./types";

const FLOW_ANALYZE_PATH = "/api/v1/flow/analyze";
const PREPARE_TARGET_PATH = "/api/v1/flow/prepare-target";
const UX_CHAT_PATH = "/api/v1/ux/chat";
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
  previousMessages: { role: "user" | "assistant"; content: string }[]
): Promise<UxEvaluationResponse> {
  const selectedImages = buildSelectedImages(bundle, targetResult);
  const requestBody = JSON.stringify({
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
  const response = await fetch(buildUrl(apiBaseUrl, UX_CHAT_PATH), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: requestBody
  });
  try {
    return (await readJsonResponse(response)) as UxEvaluationResponse;
  } catch (error) {
    if (error instanceof AnalysisApiError && error.status && error.status >= 500) {
      const fallbackResponse = await fetch(buildUrl(apiBaseUrl, UX_HEURISTIC_CHAT_PATH), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: requestBody
      });
      return (await readJsonResponse(fallbackResponse)) as UxEvaluationResponse;
    }
    throw error;
  }
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

function buildSelectedImages(bundle: AnalysisBundle, targetResult: TargetResult | null): VisualArtifact[] {
  const artifacts: VisualArtifact[] = [];
  const targetId = targetResult?.target_frame_id || bundle.flow_tree.ordered_frame_ids[0];
  const targetFrame = bundle.frames.find((frame) => frame.client_frame_id === targetId);
  if (targetFrame?.artifacts.heatmap_overlay) {
    artifacts.push(targetFrame.artifacts.heatmap_overlay);
  }
  if (targetResult) {
    targetResult.frames.slice(0, 3).forEach((frame) => {
      const fullOverlay = frame.artifacts.full_overlay;
      if (fullOverlay) {
        artifacts.push(fullOverlay);
      }
    });
  }
  return artifacts.slice(0, 4);
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

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function buildUrl(apiBaseUrl: string, path: string): string {
  return `${apiBaseUrl.replace(/\/$/, "")}${path}`;
}
