import {
  AnalysisResult,
  AnalysisStage,
  CreateAnalysisInput,
  ReportItem
} from "./types";

const CREATE_ANALYSIS_PATH = "/api/v1/analyses";
const POLL_INTERVAL_MS = 1750;
const MAX_WAIT_MS = 60000;

export class AnalysisApiError extends Error {
  status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "AnalysisApiError";
    this.status = status;
  }
}

export async function createAnalysis(
  input: CreateAnalysisInput
): Promise<unknown> {
  const formData = new FormData();
  const fileName = `${sanitizeFilePart(input.frame.id)}.png`;
  const arrayBuffer = new ArrayBuffer(input.fileBytes.byteLength);
  new Uint8Array(arrayBuffer).set(input.fileBytes);
  const file = new File([arrayBuffer], fileName, {
    type: "image/png"
  });

  formData.append("file", file);
  formData.append("frame_id", input.frame.id);
  formData.append("frame_name", input.frame.name);
  formData.append("width", String(input.frame.width));
  formData.append("height", String(input.frame.height));
  formData.append("export_scale", String(input.exportScale));
  formData.append("plugin_version", input.pluginVersion);

  if (input.modelName) {
    formData.append("model_name", input.modelName);
  }

  if (input.options) {
    formData.append("options", JSON.stringify(input.options));
  }

  const response = await fetch(buildUrl(input.apiBaseUrl, CREATE_ANALYSIS_PATH), {
    method: "POST",
    body: formData
  });

  return readJsonResponse(response);
}

export async function waitForAnalysis(
  createResponse: unknown,
  apiBaseUrl: string,
  onStatusChange: (stage: AnalysisStage) => void
): Promise<AnalysisResult> {
  let result = normalizeAnalysisResponse(createResponse, apiBaseUrl);

  const jobId = result.jobId;
  if (isCompleted(result) || isFailed(result) || !jobId) {
    return result;
  }

  const startedAt = Date.now();
  onStatusChange("queued");

  while (Date.now() - startedAt < MAX_WAIT_MS) {
    await delay(POLL_INTERVAL_MS);
    onStatusChange("running");

    const response = await fetch(
      buildUrl(apiBaseUrl, `${CREATE_ANALYSIS_PATH}/${encodeURIComponent(jobId)}`)
    );
    result = normalizeAnalysisResponse(await readJsonResponse(response), apiBaseUrl);

    if (isCompleted(result) || isFailed(result)) {
      return result;
    }
  }

  return {
    ...result,
    status: "timeout"
  };
}

export function normalizeAnalysisResponse(
  response: unknown,
  apiBaseUrl: string
): AnalysisResult {
  const root = asRecord(response);
  const data = firstRecord(
    root?.result,
    root?.analysis,
    root?.data,
    root?.report,
    root
  );
  const report = firstRecord(data?.report, data);
  const assets = firstRecord(root?.assets, data?.assets);

  const status =
    stringValue(root?.status) ||
    stringValue(data?.status) ||
    stringValue(root?.state) ||
    stringValue(data?.state) ||
    inferStatus(data);

  const jobId =
    stringValue(root?.job_id) ||
    stringValue(root?.jobId) ||
    stringValue(root?.id) ||
    stringValue(root?.analysis_id) ||
    stringValue(data?.job_id) ||
    stringValue(data?.jobId) ||
    stringValue(data?.id) ||
    stringValue(data?.analysis_id);

  const overlayUrl = resolveMaybeUrl(
    stringValue(root?.overlay_url) ||
      stringValue(root?.overlayUrl) ||
      stringValue(root?.heatmap_url) ||
      stringValue(root?.heatmapUrl) ||
      stringValue(data?.overlay_url) ||
      stringValue(data?.overlayUrl) ||
      stringValue(data?.heatmap_url) ||
      stringValue(data?.heatmapUrl),
    apiBaseUrl
  ) || toDataImageUrl(
    stringValue(root?.heatmap_png_base64) ||
      stringValue(data?.heatmap_png_base64) ||
      stringValue(assets?.heatmap_png_base64),
    stringValue(assets?.image_mime_type)
  );

  const summary =
    stringValue(root?.summary) ||
    stringValue(data?.summary) ||
    stringValue(report?.summary);

  const completedAt =
    stringValue(root?.completed_at) ||
    stringValue(root?.completedAt) ||
    stringValue(data?.completed_at) ||
    stringValue(data?.completedAt) ||
    (isTerminalStatus(status) ? new Date().toISOString() : undefined);

  return {
    status,
    jobId,
    overlayUrl,
    summary,
    hotspots: toReportItems(
      root?.hotspots ??
        data?.hotspots ??
        report?.hotspots ??
        root?.attention_hotspots ??
        data?.attention_hotspots ??
        report?.attention_hotspots
    ),
    issues: toReportItems(
      root?.issues ??
        data?.issues ??
        report?.issues ??
        root?.low_attention_areas ??
        data?.low_attention_areas ??
        report?.low_attention_areas
    ),
    recommendations: toReportItems(
      root?.recommendations ?? data?.recommendations ?? report?.recommendations
    ),
    completedAt,
    raw: response
  };
}

export function friendlyErrorMessage(error: unknown): string {
  if (error instanceof AnalysisApiError) {
    if (error.status === 422) {
      return `분석 요청 형식이 올바르지 않습니다. ${error.message}`;
    }

    if (error.status && error.status >= 500) {
      return "서버에서 분석을 완료하지 못했습니다.";
    }

    return error.message;
  }

  if (error instanceof TypeError) {
    return "분석 서버에 연결할 수 없습니다. 네트워크 상태를 확인해주세요.";
  }

  return "분석 중 오류가 발생했습니다.";
}

export function isCompleted(result: AnalysisResult): boolean {
  return normalizeStatus(result.status) === "completed" || hasVisibleResult(result);
}

export function isFailed(result: AnalysisResult): boolean {
  const status = normalizeStatus(result.status);
  return status === "failed" || status === "timeout";
}

function hasVisibleResult(result: AnalysisResult): boolean {
  return Boolean(
    result.overlayUrl ||
      result.summary ||
      result.hotspots.length > 0 ||
      result.issues.length > 0 ||
      result.recommendations.length > 0
  );
}

function inferStatus(data: Record<string, unknown> | null): AnalysisStage {
  if (!data) {
    return "completed";
  }

  if (
    data.overlay_url ||
    data.overlayUrl ||
    data.heatmap_url ||
    data.heatmapUrl ||
    data.summary ||
    data.report
  ) {
    return "completed";
  }

  return "completed";
}

function normalizeStatus(status: string): AnalysisStage | string {
  return status.trim().toLowerCase();
}

function isTerminalStatus(status: string): boolean {
  const normalized = normalizeStatus(status);
  return normalized === "completed" || normalized === "failed";
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

  if (typeof record.detail === "string") {
    return record.detail;
  }

  if (Array.isArray(record.detail)) {
    return record.detail
      .map((item) => {
        const detail = asRecord(item);
        return stringValue(detail?.msg) || JSON.stringify(item);
      })
      .join(" ");
  }

  return stringValue(record.message) || JSON.stringify(payload);
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function buildUrl(apiBaseUrl: string, path: string): string {
  return `${apiBaseUrl.replace(/\/$/, "")}${path}`;
}

function sanitizeFilePart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]/g, "_");
}

function resolveMaybeUrl(value: string | undefined, apiBaseUrl: string): string | undefined {
  if (!value) {
    return undefined;
  }

  try {
    return new URL(value, apiBaseUrl).toString();
  } catch {
    return value;
  }
}

function toDataImageUrl(
  base64: string | undefined,
  mimeType = "image/png"
): string | undefined {
  if (!base64) {
    return undefined;
  }

  if (base64.startsWith("data:")) {
    return base64;
  }

  return `data:${mimeType};base64,${base64}`;
}

function toReportItems(value: unknown): ReportItem[] {
  if (!value) {
    return [];
  }

  if (typeof value === "string") {
    return value
      .split(/\n+/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((description) => ({ description }));
  }

  if (!Array.isArray(value)) {
    const record = asRecord(value);
    if (!record) {
      return [];
    }

    return Object.entries(record).map(([title, description]) => ({
      title,
      description: stringifyReportValue(description)
    }));
  }

  return value.map((item) => {
    if (typeof item === "string") {
      return { description: item };
    }

    const record = asRecord(item);
    if (!record) {
      return {
        description: stringifyReportValue(item)
      };
    }

    return {
      title:
        stringValue(record.title) ||
        stringValue(record.name) ||
        stringValue(record.area) ||
        stringValue(record.label) ||
        stringValue(record.region) ||
        undefined,
      description:
        stringValue(record.description) ||
        stringValue(record.message) ||
        stringValue(record.text) ||
        stringValue(record.note) ||
        describeStructuredReportItem(record),
      score:
        typeof record.score === "number" || typeof record.score === "string"
          ? record.score
          : typeof record.mean_score === "number" || typeof record.mean_score === "string"
            ? record.mean_score
          : undefined,
      location:
        stringValue(record.location) ||
        stringValue(record.region) ||
        bboxToString(record.bbox) ||
        undefined
    };
  });
}

function describeStructuredReportItem(record: Record<string, unknown>): string {
  const parts: string[] = [];
  const label = stringValue(record.label) || stringValue(record.region);
  const estimate = stringValue(record.estimate);
  const meanScore = stringValue(record.mean_score);
  const bbox = bboxToString(record.bbox);

  if (label) {
    parts.push(label);
  }

  if (estimate) {
    parts.push(`estimate ${estimate}`);
  }

  if (meanScore) {
    parts.push(`mean score ${meanScore}`);
  }

  if (bbox) {
    parts.push(bbox);
  }

  return parts.length > 0 ? parts.join(" · ") : stringifyReportValue(record);
}

function bboxToString(value: unknown): string | undefined {
  const bbox = asRecord(value);
  if (!bbox) {
    return stringValue(value);
  }

  const x = stringValue(bbox.x);
  const y = stringValue(bbox.y);
  const width = stringValue(bbox.width);
  const height = stringValue(bbox.height);

  if (!x || !y || !width || !height) {
    return stringifyReportValue(value);
  }

  return `x ${x}, y ${y}, ${width}×${height}`;
}

function stringifyReportValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  return JSON.stringify(value);
}

function firstRecord(...values: unknown[]): Record<string, unknown> | null {
  for (const value of values) {
    const record = asRecord(value);
    if (record) {
      return record;
    }
  }

  return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  return null;
}

function stringValue(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) {
    return value;
  }

  if (typeof value === "number") {
    return String(value);
  }

  return undefined;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}
