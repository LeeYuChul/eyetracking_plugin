import {
  createAnalysis,
  friendlyErrorMessage,
  isFailed,
  normalizeAnalysisResponse,
  waitForAnalysis
} from "./api";
import "./styles.css";
import {
  API_BASE_OPTIONS,
  AnalysisResult,
  AnalysisStage,
  DEFAULT_API_BASE_URL,
  ExportScale,
  ExportedFramePayload,
  MainToUiMessage,
  PLUGIN_WINDOW_LIMITS,
  PLUGIN_VERSION,
  ReportItem,
  SelectionInfo,
  UiToMainMessage
} from "./types";

const STAGE_MESSAGES: Record<AnalysisStage, string> = {
  idle: "분석을 준비하고 있습니다.",
  exporting: "Figma 프레임을 이미지로 변환 중입니다.",
  uploading: "서버로 이미지를 업로드 중입니다.",
  queued: "분석 대기 중입니다.",
  running: "아이트래킹 히트맵을 생성 중입니다.",
  completed: "분석이 완료되었습니다.",
  failed: "분석 중 오류가 발생했습니다.",
  timeout: "분석 시간이 오래 걸리고 있습니다. 다시 시도해주세요."
};

const REPORT_NOTICE =
  "본 결과는 실제 사용자의 아이트래킹 실험 결과가 아니라, UI 이미지 기반 시선 예측 모델을 통해 생성된 참고용 분석 결과입니다.";

let selectedFrame: SelectionInfo | null = null;
let exportScale: ExportScale = 1;
let apiBaseUrl = DEFAULT_API_BASE_URL;
let isRunning = false;
let lastExport: ExportedFramePayload | null = null;
let lastResult: AnalysisResult | null = null;
let frameImageUrl: string | null = null;

const elements = {
  closeButton: byId<HTMLButtonElement>("closeButton"),
  refreshButton: byId<HTMLButtonElement>("refreshButton"),
  runButton: byId<HTMLButtonElement>("runButton"),
  retryButton: byId<HTMLButtonElement>("retryButton"),
  retryFromErrorButton: byId<HTMLButtonElement>("retryFromErrorButton"),
  copyButton: byId<HTMLButtonElement>("copyButton"),
  closeResultButton: byId<HTMLButtonElement>("closeResultButton"),
  serverSelect: byId<HTMLSelectElement>("serverSelect"),
  frameSummary: byId<HTMLDivElement>("frameSummary"),
  selectionMessages: byId<HTMLUListElement>("selectionMessages"),
  progressPanel: byId<HTMLElement>("progressPanel"),
  errorPanel: byId<HTMLElement>("errorPanel"),
  errorMessage: byId<HTMLParagraphElement>("errorMessage"),
  resultPanel: byId<HTMLElement>("resultPanel"),
  selectionPanel: byId<HTMLElement>("selectionPanel"),
  stageMessage: byId<HTMLParagraphElement>("stageMessage"),
  resultFrameName: byId<HTMLHeadingElement>("resultFrameName"),
  completedAt: byId<HTMLParagraphElement>("completedAt"),
  overlayShell: byId<HTMLDivElement>("overlayShell"),
  frameImage: byId<HTMLImageElement>("frameImage"),
  overlayImage: byId<HTMLImageElement>("overlayImage"),
  summarySection: byId<HTMLElement>("summarySection"),
  summaryText: byId<HTMLParagraphElement>("summaryText"),
  hotspotsSection: byId<HTMLElement>("hotspotsSection"),
  hotspotsList: byId<HTMLUListElement>("hotspotsList"),
  issuesSection: byId<HTMLElement>("issuesSection"),
  issuesList: byId<HTMLUListElement>("issuesList"),
  recommendationsSection: byId<HTMLElement>("recommendationsSection"),
  recommendationsList: byId<HTMLUListElement>("recommendationsList"),
  rawResponseDetails: byId<HTMLDetailsElement>("rawResponseDetails"),
  rawResponse: byId<HTMLPreElement>("rawResponse"),
  resizeHandle: byId<HTMLButtonElement>("resizeHandle")
};

function init(): void {
  hydrateServerSelect();
  bindEvents();
  postToPlugin({ type: "REFRESH_SELECTION" });
}

function bindEvents(): void {
  elements.closeButton.addEventListener("click", closePlugin);
  elements.closeResultButton.addEventListener("click", closePlugin);
  elements.refreshButton.addEventListener("click", () => {
    postToPlugin({ type: "REFRESH_SELECTION" });
  });
  elements.runButton.addEventListener("click", requestAnalysis);
  elements.retryButton.addEventListener("click", requestAnalysis);
  elements.retryFromErrorButton.addEventListener("click", requestAnalysis);
  elements.copyButton.addEventListener("click", copyReport);
  elements.serverSelect.addEventListener("change", () => {
    apiBaseUrl = elements.serverSelect.value;
  });
  bindResizeHandle();

  document.querySelectorAll<HTMLButtonElement>("[data-scale]").forEach((button) => {
    button.addEventListener("click", () => {
      const scale = Number(button.dataset.scale) === 2 ? 2 : 1;
      exportScale = scale;
      document.querySelectorAll<HTMLButtonElement>("[data-scale]").forEach((item) => {
        item.classList.toggle("is-active", item === button);
      });
    });
  });
}

function hydrateServerSelect(): void {
  elements.serverSelect.innerHTML = "";

  API_BASE_OPTIONS.forEach((option) => {
    const optionElement = document.createElement("option");
    optionElement.value = option.value;
    optionElement.textContent = option.label;
    elements.serverSelect.append(optionElement);
  });

  if (!API_BASE_OPTIONS.some((option) => option.value === apiBaseUrl)) {
    apiBaseUrl = DEFAULT_API_BASE_URL;
  }

  elements.serverSelect.value = apiBaseUrl;
}

function handlePluginMessage(message: MainToUiMessage): void {
  if (message.type === "SELECTION_INFO") {
    selectedFrame = message.payload;
    renderSelection(message.payload);
    return;
  }

  if (message.type === "EXPORT_STARTED") {
    setRunning(true);
    showProgress("exporting");
    return;
  }

  if (message.type === "EXPORT_SUCCESS") {
    void runAnalysis(message.payload);
    return;
  }

  if (message.type === "EXPORT_FAILED") {
    setRunning(false);
    showError(message.payload.message);
    return;
  }

  if (message.type === "ERROR") {
    setRunning(false);
    showError(message.payload.message);
  }
}

function renderSelection(selection: SelectionInfo): void {
  elements.selectionMessages.innerHTML = "";

  if (!selection.frame) {
    elements.frameSummary.innerHTML =
      '<span class="muted">분석할 모바일 화면 프레임을 선택해주세요.</span>';
  } else {
    elements.frameSummary.innerHTML = "";
    const name = document.createElement("div");
    name.className = "frame-name";
    name.textContent = selection.frame.name;

    const size = document.createElement("div");
    size.className = "frame-size";
    size.textContent = `${selection.frame.width}px × ${selection.frame.height}px`;

    elements.frameSummary.append(name, size);
  }

  appendMessage(selection.message, selection.status === "invalid" ? "error" : undefined);
  selection.warnings.forEach((warning) => appendMessage(warning, "warning"));
  elements.runButton.disabled = isRunning || !selection.canAnalyze;
}

function requestAnalysis(): void {
  if (isRunning) {
    return;
  }

  if (!selectedFrame?.canAnalyze) {
    showError(selectedFrame?.message || "분석할 모바일 프레임을 1개 선택해주세요.");
    return;
  }

  hideError();
  hideResult();
  setRunning(true);
  postToPlugin({
    type: "RUN_ANALYSIS",
    payload: {
      exportScale
    }
  });
}

async function runAnalysis(payload: ExportedFramePayload): Promise<void> {
  lastExport = payload;
  showProgress("uploading");

  try {
    const createResponse = await createAnalysis({
      apiBaseUrl,
      fileBytes: new Uint8Array(payload.bytes),
      frame: payload.frame,
      exportScale: payload.exportScale,
      pluginVersion: PLUGIN_VERSION,
      modelName: "umsi++",
      options: {
        source: "figma-plugin",
        requested_at: new Date().toISOString()
      }
    });

    showProgress("queued");
    const result = await waitForAnalysis(createResponse, apiBaseUrl, showProgress);

    if (isFailed(result)) {
      showProgress(result.status === "timeout" ? "timeout" : "failed");
      showError(
        result.status === "timeout"
          ? STAGE_MESSAGES.timeout
          : "서버에서 분석을 완료하지 못했습니다."
      );
      return;
    }

    const normalized = normalizeAnalysisResponse(result.raw, apiBaseUrl);
    lastResult = {
      ...normalized,
      completedAt: normalized.completedAt || new Date().toISOString()
    };
    showProgress("completed");
    renderResult(lastResult, payload);
  } catch (error) {
    showError(friendlyErrorMessage(error));
  } finally {
    setRunning(false);
  }
}

function renderResult(result: AnalysisResult, payload: ExportedFramePayload): void {
  hideError();
  elements.progressPanel.classList.add("is-hidden");
  elements.resultPanel.classList.remove("is-hidden");
  elements.resultFrameName.textContent = payload.frame.name;
  elements.completedAt.textContent = result.completedAt
    ? formatDate(result.completedAt)
    : formatDate(new Date().toISOString());

  elements.frameImage.src = createFrameImageUrl(payload.bytes);
  elements.overlayShell.classList.remove("is-hidden");

  if (result.overlayUrl) {
    elements.overlayImage.src = result.overlayUrl;
    elements.overlayImage.classList.remove("is-hidden");
  } else {
    elements.overlayImage.removeAttribute("src");
    elements.overlayImage.classList.add("is-hidden");
  }

  renderTextSection(elements.summarySection, elements.summaryText, result.summary);
  renderListSection(elements.hotspotsSection, elements.hotspotsList, result.hotspots);
  renderListSection(elements.issuesSection, elements.issuesList, result.issues);
  renderListSection(
    elements.recommendationsSection,
    elements.recommendationsList,
    result.recommendations
  );

  const hasStructuredReport =
    Boolean(result.overlayUrl || result.summary) ||
    result.hotspots.length > 0 ||
    result.issues.length > 0 ||
    result.recommendations.length > 0;

  elements.rawResponse.textContent = JSON.stringify(result.raw, null, 2);
  elements.rawResponseDetails.classList.toggle("is-hidden", hasStructuredReport);
}

function renderTextSection(
  section: HTMLElement,
  target: HTMLElement,
  value: string | undefined
): void {
  section.classList.toggle("is-hidden", !value);
  target.textContent = value || "";
}

function renderListSection(
  section: HTMLElement,
  target: HTMLUListElement,
  items: ReportItem[]
): void {
  target.innerHTML = "";
  section.classList.toggle("is-hidden", items.length === 0);

  items.forEach((item) => {
    const listItem = document.createElement("li");

    if (item.title) {
      const title = document.createElement("div");
      title.className = "report-item-title";
      title.textContent = item.title;
      listItem.append(title);
    }

    const description = document.createElement("div");
    description.textContent = item.description;
    listItem.append(description);

    const metaParts = [item.location, item.score ? `score ${item.score}` : undefined].filter(
      Boolean
    );
    if (metaParts.length > 0) {
      const meta = document.createElement("div");
      meta.className = "report-item-meta";
      meta.textContent = metaParts.join(" · ");
      listItem.append(meta);
    }

    target.append(listItem);
  });
}

async function copyReport(): Promise<void> {
  if (!lastResult || !lastExport) {
    return;
  }

  const report = buildReportText(lastResult, lastExport);
  await navigator.clipboard.writeText(report);
  elements.copyButton.textContent = "Copied";
  window.setTimeout(() => {
    elements.copyButton.textContent = "Copy Report";
  }, 1400);
}

function buildReportText(
  result: AnalysisResult,
  payload: ExportedFramePayload
): string {
  return [
    "[Eye Tracking Heatmap Report]",
    `Frame: ${payload.frame.name}`,
    `Completed: ${result.completedAt ? formatDate(result.completedAt) : ""}`,
    "",
    `Summary: ${result.summary || "서버 응답에 요약 문장이 포함되지 않았습니다."}`,
    "",
    formatReportItems("Hotspots", result.hotspots),
    formatReportItems("Issues", result.issues),
    formatReportItems("Recommendations", result.recommendations),
    "",
    REPORT_NOTICE
  ]
    .filter(Boolean)
    .join("\n");
}

function formatReportItems(title: string, items: ReportItem[]): string {
  if (items.length === 0) {
    return `${title}: 없음`;
  }

  return [
    `${title}:`,
    ...items.map((item, index) => {
      const prefix = `${index + 1}.`;
      const titlePart = item.title ? `${item.title}: ` : "";
      return `${prefix} ${titlePart}${item.description}`;
    })
  ].join("\n");
}

function showProgress(stage: AnalysisStage): void {
  elements.progressPanel.classList.remove("is-hidden");
  elements.stageMessage.textContent = STAGE_MESSAGES[stage];
}

function showError(message: string): void {
  elements.progressPanel.classList.add("is-hidden");
  elements.resultPanel.classList.add("is-hidden");
  elements.errorPanel.classList.remove("is-hidden");
  elements.errorMessage.textContent = message;
  setRunning(false);
}

function hideError(): void {
  elements.errorPanel.classList.add("is-hidden");
}

function hideResult(): void {
  elements.resultPanel.classList.add("is-hidden");
}

function createFrameImageUrl(bytes: Uint8Array): string {
  if (frameImageUrl) {
    URL.revokeObjectURL(frameImageUrl);
  }

  const copiedBuffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copiedBuffer).set(bytes);
  frameImageUrl = URL.createObjectURL(
    new Blob([copiedBuffer], {
      type: "image/png"
    })
  );

  return frameImageUrl;
}

function bindResizeHandle(): void {
  elements.resizeHandle.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    elements.resizeHandle.setPointerCapture(event.pointerId);

    const startX = event.clientX;
    const startY = event.clientY;
    const startWidth = window.innerWidth;
    const startHeight = window.innerHeight;

    const onPointerMove = (moveEvent: PointerEvent): void => {
      const width = clamp(
        startWidth + moveEvent.clientX - startX,
        PLUGIN_WINDOW_LIMITS.minWidth,
        PLUGIN_WINDOW_LIMITS.maxWidth
      );
      const height = clamp(
        startHeight + moveEvent.clientY - startY,
        PLUGIN_WINDOW_LIMITS.minHeight,
        PLUGIN_WINDOW_LIMITS.maxHeight
      );

      postToPlugin({
        type: "RESIZE_PLUGIN",
        payload: {
          width,
          height
        }
      });
    };

    const stopResize = (upEvent: PointerEvent): void => {
      if (elements.resizeHandle.hasPointerCapture(upEvent.pointerId)) {
        elements.resizeHandle.releasePointerCapture(upEvent.pointerId);
      }
      elements.resizeHandle.removeEventListener("pointermove", onPointerMove);
      elements.resizeHandle.removeEventListener("pointerup", stopResize);
      elements.resizeHandle.removeEventListener("pointercancel", stopResize);
    };

    elements.resizeHandle.addEventListener("pointermove", onPointerMove);
    elements.resizeHandle.addEventListener("pointerup", stopResize);
    elements.resizeHandle.addEventListener("pointercancel", stopResize);
  });
}

function clamp(value: number, min: number, max: number): number {
  return Math.round(Math.min(Math.max(value, min), max));
}

function setRunning(value: boolean): void {
  isRunning = value;
  elements.runButton.disabled = value || !selectedFrame?.canAnalyze;
  elements.retryButton.disabled = value;
  elements.retryFromErrorButton.disabled = value;
  elements.refreshButton.disabled = value;
}

function appendMessage(message: string, kind?: "warning" | "error"): void {
  const item = document.createElement("li");
  if (kind) {
    item.className = kind;
  }
  item.textContent = message;
  elements.selectionMessages.append(item);
}

function postToPlugin(message: UiToMainMessage): void {
  parent.postMessage(
    {
      pluginMessage: message
    },
    "*"
  );
}

function closePlugin(): void {
  postToPlugin({ type: "CLOSE_PLUGIN" });
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat("ko-KR", {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(date);
}

function byId<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`Missing UI element: ${id}`);
  }

  return element as T;
}

window.onmessage = (event: MessageEvent<{ pluginMessage?: MainToUiMessage }>) => {
  const message = event.data.pluginMessage;
  if (message) {
    handlePluginMessage(message);
  }
};

init();
