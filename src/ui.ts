import {
  analyzeFlow,
  artifactToDataUrl,
  evaluateUx,
  evaluateUxStream,
  friendlyErrorMessage,
  prepareTarget
} from "./api";
import "./styles.css";
import {
  AnalysisBundle,
  AppStage,
  ChatEndpointMode,
  ChatEntry,
  DEFAULT_API_BASE_URL,
  ExportScale,
  ExportedFlowPayload,
  FlowFrameNode,
  FrameAnalysisResult,
  LocalSession,
  MainToUiMessage,
  PLUGIN_WINDOW_LIMITS,
  SelectionInfo,
  TargetResult,
  UiToMainMessage,
  UxStreamEvent,
  ViewMode
} from "./types";

const STAGE_MESSAGES: Record<AppStage, string> = {
  idle: "대기 중입니다.",
  exporting: "Figma Frame을 PNG로 export 중입니다.",
  uploading: "서버로 Flow 분석 요청을 전송 중입니다.",
  analyzing: "Heatmap과 Scanpath를 생성 중입니다.",
  saving_local: "로컬 세션을 저장 중입니다.",
  ready: "분석 결과를 표시합니다.",
  preparing_target: "Target 기준 Memory Blur를 준비 중입니다.",
  evaluating_ux: "UX 질문을 평가 중입니다.",
  error: "오류가 발생했습니다."
};

let exportScale: ExportScale = 1;
let apiBaseUrl = DEFAULT_API_BASE_URL;
let isRunning = false;
let selectionCanAnalyze = false;
let session: LocalSession | null = null;
let targetFrameId: string | null = null;
let viewMode: ViewMode = "original";
let chatEndpointMode: ChatEndpointMode = "vlm";
let activePage: "analysis" | "results" = "analysis";
let liveUxEvents: UxStreamEvent[] = [];

const elements = {
  analysisTab: byId<HTMLButtonElement>("analysisTab"),
  resultsTab: byId<HTMLButtonElement>("resultsTab"),
  analysisPage: byId<HTMLElement>("analysisPage"),
  resultsPage: byId<HTMLElement>("resultsPage"),
  closeButton: byId<HTMLButtonElement>("closeButton"),
  refreshButton: byId<HTMLButtonElement>("refreshButton"),
  runButton: byId<HTMLButtonElement>("runButton"),
  retryButton: byId<HTMLButtonElement>("retryButton"),
  clearButton: byId<HTMLButtonElement>("clearButton"),
  askButton: byId<HTMLButtonElement>("askButton"),
  targetSelect: byId<HTMLSelectElement>("targetSelect"),
  chatEndpointSelect: byId<HTMLSelectElement>("chatEndpointSelect"),
  questionInput: byId<HTMLTextAreaElement>("questionInput"),
  selectionStatus: byId<HTMLSpanElement>("selectionStatus"),
  stagePill: byId<HTMLSpanElement>("stagePill"),
  frameList: byId<HTMLDivElement>("frameList"),
  selectionMessages: byId<HTMLUListElement>("selectionMessages"),
  progressPanel: byId<HTMLElement>("progressPanel"),
  stageMessage: byId<HTMLParagraphElement>("stageMessage"),
  errorPanel: byId<HTMLElement>("errorPanel"),
  errorMessage: byId<HTMLParagraphElement>("errorMessage"),
  workspacePanel: byId<HTMLElement>("workspacePanel"),
  flowTree: byId<HTMLDivElement>("flowTree"),
  flowViewer: byId<HTMLDivElement>("flowViewer"),
  metricGrid: byId<HTMLDivElement>("metricGrid"),
  bundleMeta: byId<HTMLSpanElement>("bundleMeta"),
  chatHistory: byId<HTMLDivElement>("chatHistory"),
  chatLive: byId<HTMLDivElement>("chatLive"),
  chatMeta: byId<HTMLSpanElement>("chatMeta"),
  resizeHandle: byId<HTMLButtonElement>("resizeHandle")
};

function init(): void {
  bindEvents();
  postToPlugin({ type: "REFRESH_SELECTION" });
  postToPlugin({ type: "LOAD_SESSION" });
}

function bindEvents(): void {
  elements.analysisTab.addEventListener("click", () => setActivePage("analysis"));
  elements.resultsTab.addEventListener("click", () => {
    if (session) {
      setActivePage("results");
    }
  });
  elements.closeButton.addEventListener("click", closePlugin);
  elements.refreshButton.addEventListener("click", () => postToPlugin({ type: "REFRESH_SELECTION" }));
  elements.runButton.addEventListener("click", requestAnalysis);
  elements.retryButton.addEventListener("click", requestAnalysis);
  elements.clearButton.addEventListener("click", clearCurrentSession);
  elements.askButton.addEventListener("click", askQuestion);
  elements.targetSelect.addEventListener("change", () => {
    void selectTarget(elements.targetSelect.value);
  });
  elements.chatEndpointSelect.addEventListener("change", () => {
    chatEndpointMode = elements.chatEndpointSelect.value === "heuristic" ? "heuristic" : "vlm";
  });
  document.querySelectorAll<HTMLButtonElement>("[data-scale]").forEach((button) => {
    button.addEventListener("click", () => {
      exportScale = Number(button.dataset.scale) === 2 ? 2 : 1;
      setActiveButton("[data-scale]", button);
    });
  });
  document.querySelectorAll<HTMLButtonElement>("[data-view]").forEach((button) => {
    button.addEventListener("click", () => {
      viewMode = (button.dataset.view || "original") as ViewMode;
      setActiveButton("[data-view]", button);
      renderWorkspace();
    });
  });
  bindResizeHandle();
}

function handlePluginMessage(message: MainToUiMessage): void {
  if (message.type === "SELECTION_INFO") {
    selectionCanAnalyze = message.payload.canAnalyze;
    renderSelection(message.payload);
    updateButtons();
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
    showError(message.payload.message, "plugin");
    return;
  }
  if (message.type === "STORAGE_LOADED") {
    session = message.payload.session;
    targetFrameId = defaultTargetFrameId(session?.analysis_bundle || null);
    if (session) {
      setActivePage("results");
    }
    renderWorkspace();
    return;
  }
  if (message.type === "STORAGE_SAVED") {
    session = message.payload.session;
    setActivePage("results");
    renderWorkspace();
    return;
  }
  if (message.type === "STORAGE_CLEARED") {
    session = null;
    targetFrameId = null;
    setActivePage("analysis");
    renderWorkspace();
    return;
  }
  if (message.type === "ERROR") {
    showError(message.payload.message, message.payload.source || "plugin");
  }
}

function renderSelection(info: SelectionInfo): void {
  elements.selectionStatus.textContent = info.status;
  elements.frameList.innerHTML = "";
  elements.selectionMessages.innerHTML = "";

  if (info.frames.length === 0) {
    const empty = document.createElement("div");
    empty.className = "frame-row";
    empty.textContent = "선택된 Frame 없음";
    elements.frameList.append(empty);
  }

  info.frames.forEach((frame) => {
    const row = document.createElement("div");
    row.className = "frame-row";
    const main = document.createElement("div");
    const name = document.createElement("div");
    name.className = "frame-name";
    name.textContent = frame.name;
    const size = document.createElement("div");
    size.className = "frame-size";
    size.textContent = `${frame.width}px x ${frame.height}px`;
    main.append(name, size);
    const order = document.createElement("span");
    order.className = "status-pill";
    order.textContent = String(frame.orderIndex + 1);
    row.append(main, order);
    elements.frameList.append(row);
  });

  appendMessage(info.message, info.status === "invalid" ? "error" : undefined);
  info.warnings.forEach((warning) => appendMessage(warning, "warning"));
}

function requestAnalysis(): void {
  if (isRunning || !selectionCanAnalyze) {
    return;
  }
  hideError();
  postToPlugin({ type: "RUN_ANALYSIS", payload: { exportScale } });
}

async function runAnalysis(payload: ExportedFlowPayload): Promise<void> {
  try {
    showProgress("uploading");
    const bundle = await analyzeFlow(apiBaseUrl, payload);
    showProgress("saving_local");
    const nextSession = createSession(bundle);
    session = nextSession;
    targetFrameId = defaultTargetFrameId(bundle);
    postToPlugin({ type: "SAVE_SESSION", payload: { session: nextSession } });
    if (targetFrameId) {
      await selectTarget(targetFrameId);
    }
    showProgress("ready");
    setActivePage("results");
    renderWorkspace();
  } catch (error) {
    showError(friendlyErrorMessage(error), "server");
  } finally {
    setRunning(false);
  }
}

async function selectTarget(frameId: string): Promise<void> {
  if (!session || !frameId) {
    return;
  }
  targetFrameId = frameId;
  if (!session.target_results[frameId]) {
    setRunning(true);
    showProgress("preparing_target");
    try {
      const targetResult = await prepareTarget(apiBaseUrl, session.analysis_bundle, frameId);
      session = {
        ...session,
        target_results: { ...session.target_results, [frameId]: targetResult },
        last_opened_at: new Date().toISOString()
      };
      postToPlugin({ type: "SAVE_SESSION", payload: { session } });
    } catch (error) {
      showError(friendlyErrorMessage(error), "server");
    } finally {
      setRunning(false);
    }
  }
  renderWorkspace();
}

async function askQuestion(): Promise<void> {
  if (!session || isRunning) {
    return;
  }
  const question = elements.questionInput.value.trim();
  if (!question) {
    return;
  }

  setRunning(true);
  showProgress("evaluating_ux");
  try {
    const targetResult = await ensureTargetResultForChat();
    const previousMessages = session.chat_history.flatMap((entry) => [
      { role: "user" as const, content: entry.question },
      { role: "assistant" as const, content: entry.answer.conclusion }
    ]);
    liveUxEvents = [];
    renderChatLive();
    const response =
      chatEndpointMode === "vlm"
        ? await evaluateUxStream(apiBaseUrl, session.analysis_bundle, targetResult, question, previousMessages, (event) => {
            liveUxEvents = [...liveUxEvents, event].slice(-12);
            renderChatLive();
          })
        : await evaluateUx(apiBaseUrl, session.analysis_bundle, targetResult, question, previousMessages, chatEndpointMode);
    const chatEntry: ChatEntry = {
      question,
      answer: response.answer,
      provider: response.provider,
      model: response.model,
      created_at: new Date().toISOString()
    };
    session = {
      ...session,
      chat_history: [...session.chat_history, chatEntry],
      last_opened_at: new Date().toISOString()
    };
    elements.questionInput.value = "";
    liveUxEvents = [];
    postToPlugin({ type: "SAVE_SESSION", payload: { session } });
    renderWorkspace();
  } catch (error) {
    showError(friendlyErrorMessage(error), "server");
  } finally {
    setRunning(false);
  }
}

async function ensureTargetResultForChat(): Promise<TargetResult | null> {
  if (!session || !targetFrameId) {
    return null;
  }
  const existing = session.target_results[targetFrameId];
  if (existing) {
    return existing;
  }
  showProgress("preparing_target");
  const targetResult = await prepareTarget(apiBaseUrl, session.analysis_bundle, targetFrameId);
  session = {
    ...session,
    target_results: { ...session.target_results, [targetFrameId]: targetResult },
    last_opened_at: new Date().toISOString()
  };
  postToPlugin({ type: "SAVE_SESSION", payload: { session } });
  showProgress("evaluating_ux");
  return targetResult;
}

function createSession(bundle: AnalysisBundle): LocalSession {
  return {
    local_session_id: `uxflow_${Date.now()}`,
    analysis_bundle: bundle,
    target_results: {},
    chat_history: [],
    last_opened_at: new Date().toISOString()
  };
}

function renderWorkspace(): void {
  if (!session) {
    elements.workspacePanel.classList.add("is-hidden");
    elements.bundleMeta.textContent = "";
    elements.flowTree.innerHTML = "";
    elements.flowViewer.innerHTML = "";
    elements.metricGrid.innerHTML = "";
    renderChat();
    updateButtons();
    return;
  }

  elements.workspacePanel.classList.remove("is-hidden");
  elements.progressPanel.classList.add("is-hidden");
  elements.bundleMeta.textContent = `${session.analysis_bundle.frames.length} frames analyzed`;
  if (!targetFrameId) {
    targetFrameId = defaultTargetFrameId(session.analysis_bundle);
  }
  renderTargetSelect();
  renderFlowTree();
  renderFlowViewer();
  renderMetrics();
  renderChat();
  updateButtons();
}

function renderTargetSelect(): void {
  if (!session) {
    return;
  }
  elements.targetSelect.innerHTML = "";
  session.analysis_bundle.flow_tree.ordered_frame_ids.forEach((frameId) => {
    const frame = frameById(frameId);
    const option = document.createElement("option");
    option.value = frameId;
    option.textContent = frame?.frame_name || frameId;
    elements.targetSelect.append(option);
  });
  if (targetFrameId) {
    elements.targetSelect.value = targetFrameId;
  }
}

function renderFlowTree(): void {
  if (!session) {
    return;
  }
  elements.flowTree.innerHTML = "";
  session.analysis_bundle.flow_tree.flows.forEach((flow) => {
    const group = document.createElement("div");
    group.className = "ia-flow";
    const title = document.createElement("h3");
    title.textContent = `Flow ${flow.flow_id}`;
    title.className = "ia-flow-title";
    group.append(title);
    const tree = document.createElement("div");
    tree.className = "ia-tree";
    flow.frames.forEach((node) => tree.append(renderFlowNode(node)));
    group.append(tree);
    elements.flowTree.append(group);
  });
  session.analysis_bundle.warnings.forEach((warning) => {
    const item = document.createElement("div");
    item.className = "ia-warning";
    item.textContent = `${warning.code}: ${warning.message}`;
    elements.flowTree.append(item);
  });
}

function renderFlowNode(node: FlowFrameNode): HTMLElement {
  const wrapper = document.createElement("div");
  wrapper.className = "ia-branch";
  const button = document.createElement("button");
  button.type = "button";
  button.className = "ia-node";
  button.classList.toggle("is-active", node.client_frame_id === targetFrameId);

  const name = document.createElement("span");
  name.className = "ia-node-name";
  name.textContent = node.frame_name;
  const meta = document.createElement("span");
  meta.className = "ia-node-meta";
  meta.textContent = frameNodeMeta(node);
  button.append(name, meta);

  button.addEventListener("click", () => {
    void selectTarget(node.client_frame_id);
  });
  wrapper.append(button);
  if (node.children.length > 0) {
    const children = document.createElement("div");
    children.className = "ia-children";
    node.children.forEach((child) => children.append(renderFlowNode(child)));
    wrapper.append(children);
  }
  return wrapper;
}

function frameNodeMeta(node: FlowFrameNode): string {
  const parts = [];
  if (node.screen_name) {
    parts.push(node.screen_name);
  }
  if (node.depth !== null) {
    parts.push(`D${node.depth}`);
  }
  if (node.state !== null) {
    parts.push(`S${node.state}`);
  }
  return parts.join(" · ") || "Unparsed";
}

function renderFlowViewer(): void {
  if (!session) {
    return;
  }
  elements.flowViewer.innerHTML = "";
  const targetResult = currentTargetResult();
  const path = targetResult?.path_frame_ids || pathToTarget();
  path.forEach((frameId) => {
    const frame = frameById(frameId);
    if (!frame) {
      return;
    }
    const card = document.createElement("article");
    card.className = "frame-card";
    const title = document.createElement("div");
    title.className = "card-title";
    title.textContent = frame.frame_name;
    const meta = document.createElement("div");
    meta.className = "card-meta";
    meta.textContent = metricText(frame, targetResult);
    const shell = document.createElement("div");
    shell.className = "image-shell";
    const image = document.createElement("img");
    image.alt = frame.frame_name;
    image.src = artifactToDataUrl(resolveArtifact(frame, targetResult)) || "";
    shell.append(image);
    card.append(title, meta, shell);
    elements.flowViewer.append(card);
  });
}

function renderMetrics(): void {
  const frame = targetFrameId ? frameById(targetFrameId) : null;
  elements.metricGrid.innerHTML = "";
  if (!frame) {
    return;
  }
  addMetric("Fixations", String(frame.metrics.fixation_count));
  addMetric("Path", frame.metrics.scanpath_length.toFixed(1));
  addMetric("Entropy", frame.metrics.attention_entropy.toFixed(2));
  addMetric("Complexity", frame.metrics.visual_complexity.toFixed(2));
}

function renderChat(): void {
  elements.chatHistory.innerHTML = "";
  const entries = session?.chat_history || [];
  elements.chatMeta.textContent = `${chatEndpointMode} · ${entries.length}`;
  renderChatLive();
  entries.forEach((entry) => {
    const item = document.createElement("div");
    item.className = "chat-item";
    const question = document.createElement("div");
    question.className = "chat-question";
    question.textContent = entry.question;
    const conclusion = document.createElement("p");
    conclusion.textContent = entry.answer.conclusion;
    const reasons = document.createElement("ul");
    reasons.className = "chat-list";
    entry.answer.reasoning_summary.forEach((reason) => {
      const li = document.createElement("li");
      li.textContent = reason;
      reasons.append(li);
    });
    const recs = document.createElement("ul");
    recs.className = "chat-list";
    entry.answer.recommendations.forEach((recommendation) => {
      const li = document.createElement("li");
      li.textContent = recommendation;
      recs.append(li);
    });
    const meta = document.createElement("div");
    meta.className = "card-meta";
    meta.textContent = `${entry.provider} · ${entry.model} · confidence ${entry.answer.confidence}`;
    item.append(question, conclusion, reasons, recs, meta);
    elements.chatHistory.append(item);
  });
}

function renderChatLive(): void {
  elements.chatLive.innerHTML = "";
  elements.chatLive.classList.toggle("is-hidden", liveUxEvents.length === 0);
  liveUxEvents.forEach((event) => {
    const item = document.createElement("div");
    item.className = `live-item live-${event.event}`;
    const label = document.createElement("div");
    label.className = "live-label";
    label.textContent = eventLabel(event);
    const message = document.createElement("div");
    message.className = "live-message";
    message.textContent = eventMessage(event);
    item.append(label, message);

    const details = eventDetails(event);
    if (details.length > 0) {
      const list = document.createElement("ul");
      list.className = "chat-list live-details";
      details.forEach((detail) => {
        const li = document.createElement("li");
        li.textContent = detail;
        list.append(li);
      });
      item.append(list);
    }
    elements.chatLive.append(item);
  });
  elements.chatLive.scrollTop = elements.chatLive.scrollHeight;
}

function eventLabel(event: UxStreamEvent): string {
  if (event.event === "thinking") {
    return "Thinking";
  }
  if (event.event === "final") {
    return "Answer";
  }
  if (event.event === "error") {
    return "Error";
  }
  return String(event.data.stage || "Progress");
}

function eventMessage(event: UxStreamEvent): string {
  if (typeof event.data.message === "string") {
    return event.data.message;
  }
  if (event.event === "final") {
    return "최종 답변을 정리했습니다.";
  }
  return "진행 중입니다.";
}

function eventDetails(event: UxStreamEvent): string[] {
  const notes = Array.isArray(event.data.reasoning_notes) ? event.data.reasoning_notes : [];
  const candidates = Array.isArray(event.data.visible_cta_candidates) ? event.data.visible_cta_candidates : [];
  return [...candidates.map((item) => `CTA: ${String(item)}`), ...notes.map((item) => String(item))].slice(0, 5);
}

function resolveArtifact(frame: FrameAnalysisResult, targetResult: TargetResult | null) {
  const memoryFrame = targetResult?.frames.find((item) => item.client_frame_id === frame.client_frame_id);
  if (viewMode === "memory_blur") {
    return memoryFrame?.artifacts.memory_blur || frame.artifacts.original;
  }
  if (viewMode === "full_overlay") {
    return memoryFrame?.artifacts.full_overlay || frame.artifacts.heatmap_overlay || frame.artifacts.original;
  }
  return frame.artifacts[viewMode] || frame.artifacts.original;
}

function metricText(frame: FrameAnalysisResult, targetResult: TargetResult | null): string {
  const memoryFrame = targetResult?.frames.find((item) => item.client_frame_id === frame.client_frame_id);
  if (memoryFrame) {
    return `retention ${memoryFrame.memory_metrics.estimated_retention.toFixed(2)} · distance ${memoryFrame.temporal_distance}`;
  }
  return `fixations ${frame.metrics.fixation_count} · path ${frame.metrics.scanpath_length.toFixed(0)}`;
}

function addMetric(label: string, value: string): void {
  const item = document.createElement("div");
  item.className = "metric-item";
  const labelElement = document.createElement("div");
  labelElement.className = "metric-label";
  labelElement.textContent = label;
  const valueElement = document.createElement("div");
  valueElement.className = "metric-value";
  valueElement.textContent = value;
  item.append(labelElement, valueElement);
  elements.metricGrid.append(item);
}

function currentTargetResult(): TargetResult | null {
  return targetFrameId && session ? session.target_results[targetFrameId] || null : null;
}

function frameById(frameId: string): FrameAnalysisResult | undefined {
  return session?.analysis_bundle.frames.find((frame) => frame.client_frame_id === frameId);
}

function pathToTarget(): string[] {
  if (!session || !targetFrameId) {
    return [];
  }
  for (const flow of session.analysis_bundle.flow_tree.flows) {
    const index = flow.ordered_frame_ids.indexOf(targetFrameId);
    if (index >= 0) {
      return flow.ordered_frame_ids.slice(0, index + 1);
    }
  }
  const fallbackIndex = session.analysis_bundle.flow_tree.ordered_frame_ids.indexOf(targetFrameId);
  return fallbackIndex >= 0
    ? session.analysis_bundle.flow_tree.ordered_frame_ids.slice(0, fallbackIndex + 1)
    : [];
}

function defaultTargetFrameId(bundle: AnalysisBundle | null): string | null {
  if (!bundle || bundle.flow_tree.ordered_frame_ids.length === 0) {
    return null;
  }
  return bundle.flow_tree.ordered_frame_ids[bundle.flow_tree.ordered_frame_ids.length - 1];
}

function clearCurrentSession(): void {
  session = null;
  targetFrameId = null;
  postToPlugin({ type: "CLEAR_CURRENT_SESSION" });
  setActivePage("analysis");
  renderWorkspace();
}

function showProgress(stage: AppStage): void {
  elements.progressPanel.classList.remove("is-hidden");
  elements.stagePill.textContent = stage;
  elements.stageMessage.textContent = STAGE_MESSAGES[stage];
}

function showError(message: string, source: "server" | "storage" | "plugin"): void {
  elements.progressPanel.classList.add("is-hidden");
  elements.errorPanel.classList.remove("is-hidden");
  elements.errorMessage.textContent = `${source}: ${message}`;
  setRunning(false);
}

function hideError(): void {
  elements.errorPanel.classList.add("is-hidden");
}

function setRunning(value: boolean): void {
  isRunning = value;
  updateButtons();
}

function updateButtons(): void {
  elements.runButton.disabled = isRunning || !selectionCanAnalyze;
  elements.retryButton.disabled = isRunning || !selectionCanAnalyze;
  elements.askButton.disabled = isRunning || !session;
  elements.clearButton.disabled = isRunning || !session;
  elements.refreshButton.disabled = isRunning;
  elements.targetSelect.disabled = isRunning || !session;
  elements.resultsTab.disabled = !session;
}

function setActivePage(page: "analysis" | "results"): void {
  activePage = page === "results" && !session ? "analysis" : page;
  elements.analysisPage.classList.toggle("is-hidden", activePage !== "analysis");
  elements.resultsPage.classList.toggle("is-hidden", activePage !== "results");
  elements.analysisTab.classList.toggle("is-active", activePage === "analysis");
  elements.resultsTab.classList.toggle("is-active", activePage === "results");
  updateButtons();
}

function appendMessage(message: string, kind?: "warning" | "error"): void {
  const item = document.createElement("li");
  if (kind) {
    item.className = kind;
  }
  item.textContent = message;
  elements.selectionMessages.append(item);
}

function setActiveButton(selector: string, active: HTMLButtonElement): void {
  document.querySelectorAll<HTMLButtonElement>(selector).forEach((button) => {
    button.classList.toggle("is-active", button === active);
  });
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
      postToPlugin({
        type: "RESIZE_PLUGIN",
        payload: {
          width: clamp(startWidth + moveEvent.clientX - startX, PLUGIN_WINDOW_LIMITS.minWidth),
          height: clamp(startHeight + moveEvent.clientY - startY, PLUGIN_WINDOW_LIMITS.minHeight)
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

function clamp(value: number, min: number): number {
  return Math.round(Math.max(value, min));
}

function postToPlugin(message: UiToMainMessage): void {
  parent.postMessage({ pluginMessage: message }, "*");
}

function closePlugin(): void {
  postToPlugin({ type: "CLOSE_PLUGIN" });
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
