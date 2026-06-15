import { analyzeFrames, artifactToDataUrl, evaluateFrameStream, friendlyErrorMessage } from "./api";
import "./styles.css";
import {
  AppStage,
  ChatEntry,
  DEFAULT_API_BASE_URL,
  ExportScale,
  ExportedFlowPayload,
  FrameAnalysisBundle,
  FrameAnalysisResult,
  LocalSession,
  MainToUiMessage,
  OverlayKey,
  PLUGIN_WINDOW_LIMITS,
  SelectionInfo,
  UiToMainMessage,
  UxStreamEvent,
  VisualArtifact
} from "./types";

const STAGE_MESSAGES: Record<AppStage, string> = {
  idle: "대기 중입니다.",
  exporting: "Figma Frame을 PNG로 export 중입니다.",
  uploading: "서버로 분석 요청을 전송 중입니다.",
  analyzing: "Heatmap과 Scanpath를 생성 중입니다.",
  saving_local: "로컬 세션을 저장 중입니다.",
  ready: "분석 결과를 표시합니다.",
  evaluating_ux: "프레임 질문을 평가 중입니다.",
  error: "오류가 발생했습니다."
};

let exportScale: ExportScale = 1;
let apiBaseUrl = DEFAULT_API_BASE_URL;
let isRunning = false;
let selectionCanAnalyze = false;
let session: LocalSession | null = null;
let selectedFrameId: string | null = null;
let activePage: "analysis" | "results" = "analysis";
let overlays = new Set<OverlayKey>();
let liveUxEvents: UxStreamEvent[] = [];
let liveThinkingText = "";
let liveAnswerText = "";
let framesPaneWidth = 220;
let botPaneWidth = 320;
let contextMenuFrameId: string | null = null;
let contextMenuOverlays = new Set<OverlayKey>();

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
  resultFrameList: byId<HTMLDivElement>("resultFrameList"),
  frameViewer: byId<HTMLDivElement>("frameViewer"),
  metricGrid: byId<HTMLDivElement>("metricGrid"),
  bundleMeta: byId<HTMLSpanElement>("bundleMeta"),
  chatScroll: byId<HTMLDivElement>("chatScroll"),
  chatHistory: byId<HTMLDivElement>("chatHistory"),
  chatLive: byId<HTMLDivElement>("chatLive"),
  chatMeta: byId<HTMLSpanElement>("chatMeta"),
  heatmapToggle: byId<HTMLInputElement>("heatmapToggle"),
  scanpathToggle: byId<HTMLInputElement>("scanpathToggle"),
  frameContextMenu: byId<HTMLDivElement>("frameContextMenu"),
  copyFrameImageButton: byId<HTMLButtonElement>("copyFrameImageButton"),
  leftPaneResizer: byId<HTMLDivElement>("leftPaneResizer"),
  rightPaneResizer: byId<HTMLDivElement>("rightPaneResizer"),
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
  elements.copyFrameImageButton.addEventListener("click", copyContextFrameImage);
  document.addEventListener("click", hideFrameContextMenu);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      hideFrameContextMenu();
    }
  });
  elements.heatmapToggle.addEventListener("change", () => toggleOverlay("heatmap", elements.heatmapToggle.checked));
  elements.scanpathToggle.addEventListener("change", () => toggleOverlay("scanpath", elements.scanpathToggle.checked));
  document.querySelectorAll<HTMLButtonElement>("[data-scale]").forEach((button) => {
    button.addEventListener("click", () => {
      exportScale = Number(button.dataset.scale) === 2 ? 2 : 1;
      setActiveButton("[data-scale]", button);
    });
  });
  bindPaneResizeHandles();
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
    session = normalizeSession(message.payload.session);
    selectedFrameId = session?.selected_frame_id || defaultFrameId(session?.analysis_bundle || null);
    if (session) {
      setActivePage("results");
    }
    renderWorkspace();
    return;
  }
  if (message.type === "STORAGE_SAVED") {
    session = message.payload.session;
    selectedFrameId = session.selected_frame_id || defaultFrameId(session.analysis_bundle);
    setActivePage("results");
    renderWorkspace();
    return;
  }
  if (message.type === "STORAGE_CLEARED") {
    session = null;
    selectedFrameId = null;
    setActivePage("analysis");
    renderWorkspace();
    return;
  }
  if (message.type === "ERROR") {
    showError(message.payload.message, message.payload.source || "plugin");
  }
}

function normalizeSession(value: LocalSession | null): LocalSession | null {
  if (!value?.analysis_bundle?.frames) {
    return null;
  }
  return {
    local_session_id: value.local_session_id || `frames_${Date.now()}`,
    analysis_bundle: value.analysis_bundle,
    selected_frame_id: value.selected_frame_id || defaultFrameId(value.analysis_bundle),
    chat_history_by_frame: value.chat_history_by_frame || {},
    last_opened_at: value.last_opened_at || new Date().toISOString()
  };
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
    const bundle = await analyzeFrames(apiBaseUrl, payload);
    showProgress("saving_local");
    const nextSession = createSession(bundle);
    session = nextSession;
    selectedFrameId = nextSession.selected_frame_id;
    postToPlugin({ type: "SAVE_SESSION", payload: { session: nextSession } });
    showProgress("ready");
    setActivePage("results");
    renderWorkspace();
  } catch (error) {
    showError(friendlyErrorMessage(error), "server");
  } finally {
    setRunning(false);
  }
}

async function askQuestion(): Promise<void> {
  const frame = currentFrame();
  if (!session || !frame || isRunning) {
    return;
  }
  const question = elements.questionInput.value.trim();
  if (!question) {
    return;
  }

  setRunning(true);
  showProgress("evaluating_ux");
  try {
    const history = chatHistoryForFrame(frame.client_frame_id);
    liveUxEvents = [];
    liveThinkingText = "";
    liveAnswerText = "";
    renderChatLive();
    const response = await evaluateFrameStream(apiBaseUrl, frame, question, history, (event) => {
      if (event.event === "thinking_delta") {
        liveThinkingText += String(event.data.delta || "");
      } else if (event.event === "answer_delta") {
        liveAnswerText += String(event.data.delta || "");
      } else {
        liveUxEvents = [...liveUxEvents, event].slice(-8);
      }
      renderChatLive();
    });
    const chatEntry: ChatEntry = {
      question,
      answer: response.answer,
      provider: response.provider,
      model: response.model,
      created_at: new Date().toISOString()
    };
    const nextHistory = [...history, chatEntry];
    session = {
      ...session,
      chat_history_by_frame: {
        ...session.chat_history_by_frame,
        [frame.client_frame_id]: nextHistory
      },
      last_opened_at: new Date().toISOString()
    };
    elements.questionInput.value = "";
    liveUxEvents = [];
    liveThinkingText = "";
    liveAnswerText = "";
    postToPlugin({ type: "SAVE_SESSION", payload: { session } });
    renderWorkspace();
  } catch (error) {
    showError(friendlyErrorMessage(error), "server");
  } finally {
    setRunning(false);
  }
}

function createSession(bundle: FrameAnalysisBundle): LocalSession {
  return {
    local_session_id: `frames_${Date.now()}`,
    analysis_bundle: bundle,
    selected_frame_id: defaultFrameId(bundle),
    chat_history_by_frame: {},
    last_opened_at: new Date().toISOString()
  };
}

function renderWorkspace(): void {
  if (!session) {
    elements.workspacePanel.classList.add("is-hidden");
    elements.bundleMeta.textContent = "";
    elements.resultFrameList.innerHTML = "";
    elements.frameViewer.innerHTML = "";
    elements.metricGrid.innerHTML = "";
    renderChat();
    updateButtons();
    return;
  }

  elements.workspacePanel.classList.remove("is-hidden");
  elements.progressPanel.classList.add("is-hidden");
  elements.bundleMeta.textContent = `${session.analysis_bundle.frames.length} frames analyzed`;
  if (!selectedFrameId) {
    selectedFrameId = defaultFrameId(session.analysis_bundle);
  }
  renderFrameBrowser();
  renderFrameViewer();
  renderMetrics();
  renderChat();
  updateButtons();
}

function renderFrameBrowser(): void {
  if (!session) {
    return;
  }
  elements.resultFrameList.innerHTML = "";
  session.analysis_bundle.frames.forEach((frame) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "result-frame-item";
    button.classList.toggle("is-active", frame.client_frame_id === selectedFrameId);
    const thumb = document.createElement("img");
    thumb.alt = frame.frame_name;
    thumb.src = artifactToDataUrl(frame.artifacts.original) || "";
    const label = document.createElement("span");
    label.textContent = frame.frame_name;
    button.append(thumb, label);
    button.addEventListener("click", () => {
      selectedFrameId = frame.client_frame_id;
      if (session) {
        session = { ...session, selected_frame_id: selectedFrameId };
        postToPlugin({ type: "SAVE_SESSION", payload: { session } });
      }
      liveUxEvents = [];
      liveThinkingText = "";
      liveAnswerText = "";
      renderWorkspace();
    });
    elements.resultFrameList.append(button);
  });
}

function renderFrameViewer(): void {
  const frame = currentFrame();
  elements.frameViewer.innerHTML = "";
  if (!frame) {
    return;
  }
  const shell = document.createElement("div");
  shell.className = "composite-shell";
  shell.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    showFrameContextMenu(event, frame);
  });
  const original = document.createElement("img");
  original.alt = `${frame.frame_name} original`;
  original.src = artifactToDataUrl(frame.artifacts.original) || "";
  original.className = "composite-layer";
  shell.append(original);

  if (overlays.has("heatmap")) {
    const heatmap = document.createElement("img");
    heatmap.alt = `${frame.frame_name} heatmap`;
    heatmap.src = artifactToDataUrl(frame.artifacts.heatmap_overlay) || "";
    heatmap.className = "composite-layer overlay-layer";
    shell.append(heatmap);
  }
  if (overlays.has("scanpath")) {
    const scanpath = document.createElement("img");
    scanpath.alt = `${frame.frame_name} scanpath`;
    scanpath.src = artifactToDataUrl(frame.artifacts.scanpath_overlay) || "";
    scanpath.className = "composite-layer overlay-layer";
    shell.append(scanpath);
  }
  elements.frameViewer.append(shell);
}

function showFrameContextMenu(event: MouseEvent, frame: FrameAnalysisResult): void {
  contextMenuFrameId = frame.client_frame_id;
  contextMenuOverlays = new Set(overlays);
  const menu = elements.frameContextMenu;
  menu.classList.remove("is-hidden");
  const menuWidth = menu.offsetWidth || 150;
  const menuHeight = menu.offsetHeight || 40;
  const left = Math.min(event.clientX, window.innerWidth - menuWidth - 8);
  const top = Math.min(event.clientY, window.innerHeight - menuHeight - 8);
  menu.style.left = `${Math.max(8, left)}px`;
  menu.style.top = `${Math.max(8, top)}px`;
}

function hideFrameContextMenu(): void {
  elements.frameContextMenu.classList.add("is-hidden");
}

async function copyContextFrameImage(event?: MouseEvent): Promise<void> {
  event?.stopPropagation();
  const frame = frameById(contextMenuFrameId) || currentFrame();
  const selectedOverlays = new Set(contextMenuOverlays);
  hideFrameContextMenu();
  if (!frame) {
    showError("복사할 프레임을 찾을 수 없습니다.", "plugin");
    return;
  }
  try {
    const blob = await renderCompositeBlob(frame, selectedOverlays);
    if (await copyBlobToClipboard(blob)) {
      notifyPlugin("이미지를 클립보드에 복사했습니다.");
      return;
    }
    const dataUrl = await blobToDataUrl(blob);
    if (await copyTextToClipboard(dataUrl)) {
      notifyPlugin("이 환경에서는 이미지 직접 복사가 제한되어 이미지 데이터 URL을 복사했습니다.");
      return;
    }
    downloadBlob(blob, `${frame.frame_name || "frame"}_view.png`);
    notifyPlugin("클립보드가 제한되어 PNG 파일로 내려받았습니다.", 3500);
  } catch (error) {
    const message = error instanceof Error ? error.message : "이미지를 클립보드에 복사하지 못했습니다.";
    showError(message, "plugin");
  }
}

async function copyBlobToClipboard(blob: Blob): Promise<boolean> {
  const ClipboardItemCtor = window.ClipboardItem;
  if (!navigator.clipboard?.write || !ClipboardItemCtor) {
    return false;
  }
  try {
    await navigator.clipboard.write([new ClipboardItemCtor({ "image/png": blob })]);
    return true;
  } catch {
    return false;
  }
}

async function copyTextToClipboard(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fall through to execCommand for Figma plugin iframe variants.
    }
  }
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "true");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  textarea.style.top = "0";
  document.body.append(textarea);
  textarea.focus();
  textarea.select();
  try {
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    textarea.remove();
  }
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("이미지 데이터를 텍스트로 변환하지 못했습니다."));
    reader.readAsDataURL(blob);
  });
}

function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = sanitizeFileName(fileName);
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function sanitizeFileName(value: string): string {
  const cleaned = value.replace(/[\\/:*?"<>|]+/g, "_").trim();
  return cleaned || "frame_view.png";
}

async function renderCompositeBlob(frame: FrameAnalysisResult, selectedOverlays: Set<OverlayKey>): Promise<Blob> {
  const original = frame.artifacts.original;
  const width = original?.width || frame.width;
  const height = original?.height || frame.height;
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("이미지 복사용 캔버스를 만들 수 없습니다.");
  }
  await drawArtifact(context, original, canvas.width, canvas.height, 1, "source-over");
  if (selectedOverlays.has("heatmap")) {
    await drawArtifact(context, frame.artifacts.heatmap_overlay, canvas.width, canvas.height, 0.88, "multiply");
  }
  if (selectedOverlays.has("scanpath")) {
    await drawArtifact(context, frame.artifacts.scanpath_overlay, canvas.width, canvas.height, 0.88, "multiply");
  }
  const blob = await canvasToBlob(canvas);
  if (!blob) {
    throw new Error("이미지 복사 데이터를 생성하지 못했습니다.");
  }
  return blob;
}

async function drawArtifact(
  context: CanvasRenderingContext2D,
  artifact: VisualArtifact | undefined,
  width: number,
  height: number,
  alpha: number,
  operation: GlobalCompositeOperation
): Promise<void> {
  const dataUrl = artifactToDataUrl(artifact);
  if (!dataUrl) {
    return;
  }
  const image = await loadImage(dataUrl);
  context.save();
  context.globalAlpha = alpha;
  context.globalCompositeOperation = operation;
  context.drawImage(image, 0, 0, width, height);
  context.restore();
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("복사할 이미지를 불러오지 못했습니다."));
    image.src = src;
  });
}

function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
}

function renderMetrics(): void {
  const frame = currentFrame();
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
  const frame = currentFrame();
  const entries = frame ? chatHistoryForFrame(frame.client_frame_id) : [];
  elements.chatMeta.textContent = frame ? `${entries.length}` : "0";
  renderChatLive();
  entries.forEach((entry) => {
    elements.chatHistory.append(createUserBubble(entry.question), createAssistantMessage(entry));
  });
  scrollChatToBottom();
}

function renderChatLive(): void {
  elements.chatLive.innerHTML = "";
  const hasLiveText = Boolean(liveThinkingText || liveAnswerText);
  elements.chatLive.classList.toggle("is-hidden", liveUxEvents.length === 0 && !hasLiveText);
  if (hasLiveText) {
    const row = document.createElement("div");
    row.className = "bot-message-row live-response-row";
    const bubble = document.createElement("div");
    bubble.className = "chat-bubble assistant live-answer";
    if (liveThinkingText) {
      const thinking = document.createElement("div");
      thinking.className = "thinking-text";
      renderRichText(thinking, liveThinkingText);
      bubble.append(thinking);
    }
    if (liveAnswerText) {
      const answer = document.createElement("div");
      answer.className = "rich-answer";
      renderRichText(answer, liveAnswerText);
      bubble.append(answer);
    }
    row.append(createBotAvatar(), bubble);
    elements.chatLive.append(row);
  }
  liveUxEvents.forEach((event) => {
    const item = document.createElement("div");
    item.className = `live-item live-${event.event}`;
    const label = document.createElement("div");
    label.className = "live-label";
    label.textContent = event.event === "thinking" ? "Thinking" : String(event.data.stage || event.event);
    const message = document.createElement("div");
    message.className = "live-message";
    message.textContent = typeof event.data.message === "string" ? event.data.message : "진행 중입니다.";
    item.append(label, message);
    elements.chatLive.append(item);
  });
  scrollChatToBottom();
}

function scrollChatToBottom(): void {
  requestAnimationFrame(() => {
    elements.chatScroll.scrollTop = elements.chatScroll.scrollHeight;
  });
}

function createUserBubble(text: string): HTMLElement {
  const row = document.createElement("div");
  row.className = "user-message-row";
  const bubble = document.createElement("div");
  bubble.className = "chat-bubble user";
  bubble.textContent = text;
  row.append(bubble);
  return row;
}

function createAssistantMessage(entry: ChatEntry): HTMLElement {
  const row = document.createElement("div");
  row.className = "bot-message-row";
  const assistantBubble = document.createElement("div");
  assistantBubble.className = "chat-bubble assistant";
  const conclusion = document.createElement("div");
  conclusion.className = "rich-answer";
  renderRichText(conclusion, entry.answer.conclusion);
  const reasons = document.createElement("ul");
  reasons.className = "chat-list";
  entry.answer.reasoning_summary.forEach((reason) => {
    const li = document.createElement("li");
    li.textContent = reason;
    reasons.append(li);
  });
  const meta = document.createElement("div");
  meta.className = "card-meta";
  meta.textContent = `${entry.provider} · ${entry.model} · confidence ${entry.answer.confidence}`;
  assistantBubble.append(conclusion, reasons, meta);
  row.append(createBotAvatar(), assistantBubble);
  return row;
}

function createBotAvatar(): HTMLElement {
  const avatar = document.createElement("div");
  avatar.className = "bot-avatar";
  avatar.textContent = "U";
  return avatar;
}

function renderRichText(target: HTMLElement, source: string): void {
  target.innerHTML = markdownToHtml(source);
}

function markdownToHtml(source: string): string {
  const normalized = source.replace(/\r\n/g, "\n").trim();
  if (!normalized) {
    return "";
  }
  const lines = normalized.split("\n");
  const html: string[] = [];
  let paragraph: string[] = [];
  let unordered: string[] = [];
  let ordered: string[] = [];

  const flushParagraph = (): void => {
    if (paragraph.length === 0) {
      return;
    }
    html.push(`<p>${renderInline(paragraph.join(" "))}</p>`);
    paragraph = [];
  };
  const flushUnordered = (): void => {
    if (unordered.length === 0) {
      return;
    }
    html.push(`<ul>${unordered.map((item) => `<li>${renderInline(item)}</li>`).join("")}</ul>`);
    unordered = [];
  };
  const flushOrdered = (): void => {
    if (ordered.length === 0) {
      return;
    }
    html.push(`<ol>${ordered.map((item) => `<li>${renderInline(item)}</li>`).join("")}</ol>`);
    ordered = [];
  };
  const flushLists = (): void => {
    flushUnordered();
    flushOrdered();
  };
  const flushAll = (): void => {
    flushParagraph();
    flushLists();
  };

  lines.forEach((rawLine) => {
    const line = rawLine.trim();
    if (!line) {
      flushAll();
      return;
    }
    const heading = /^(#{1,3})\s+(.+)$/.exec(line);
    if (heading) {
      flushAll();
      const level = heading[1].length + 2;
      html.push(`<h${level}>${renderInline(heading[2])}</h${level}>`);
      return;
    }
    const unorderedItem = /^[-*+]\s+(.+)$/.exec(line);
    if (unorderedItem) {
      flushParagraph();
      flushOrdered();
      unordered.push(unorderedItem[1]);
      return;
    }
    const orderedItem = /^\d+[.)]\s+(.+)$/.exec(line);
    if (orderedItem) {
      flushParagraph();
      flushUnordered();
      ordered.push(orderedItem[1]);
      return;
    }
    if (/^\$\$.*\$\$$/.test(line)) {
      flushAll();
      html.push(`<div class="math-display">${escapeHtml(line.slice(2, -2).trim())}</div>`);
      return;
    }
    flushLists();
    paragraph.push(line);
  });
  flushAll();
  return `<div class="rich-text">${html.join("")}</div>`;
}

function renderInline(source: string): string {
  const mathTokens: string[] = [];
  const withMath = source
    .replace(/\\\((.+?)\\\)/g, (_match, math: string) => stashMath(mathTokens, math))
    .replace(/\$([^$\n]+?)\$/g, (_match, math: string) => stashMath(mathTokens, math));
  let html = escapeHtml(withMath);
  html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/__([^_]+)__/g, "<strong>$1</strong>");
  html = html.replace(/\*([^*]+)\*/g, "<em>$1</em>");
  html = html.replace(/_([^_]+)_/g, "<em>$1</em>");
  mathTokens.forEach((math, index) => {
    html = html.replace(`@@MATH_${index}@@`, `<span class="math-inline">${escapeHtml(math)}</span>`);
  });
  return html;
}

function stashMath(tokens: string[], value: string): string {
  const token = `@@MATH_${tokens.length}@@`;
  tokens.push(value.trim());
  return token;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
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

function toggleOverlay(key: OverlayKey, enabled: boolean): void {
  if (enabled) {
    overlays.add(key);
  } else {
    overlays.delete(key);
  }
  renderFrameViewer();
}

function currentFrame(): FrameAnalysisResult | null {
  if (!session || !selectedFrameId) {
    return null;
  }
  return session.analysis_bundle.frames.find((frame) => frame.client_frame_id === selectedFrameId) || null;
}

function frameById(frameId: string | null): FrameAnalysisResult | null {
  if (!session || !frameId) {
    return null;
  }
  return session.analysis_bundle.frames.find((frame) => frame.client_frame_id === frameId) || null;
}

function chatHistoryForFrame(frameId: string): ChatEntry[] {
  return session?.chat_history_by_frame[frameId] || [];
}

function defaultFrameId(bundle: FrameAnalysisBundle | null): string | null {
  return bundle?.frames[0]?.client_frame_id || null;
}

function clearCurrentSession(): void {
  session = null;
  selectedFrameId = null;
  liveUxEvents = [];
  liveThinkingText = "";
  liveAnswerText = "";
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
  elements.askButton.disabled = isRunning || !session || !currentFrame();
  elements.clearButton.disabled = isRunning || !session;
  elements.refreshButton.disabled = isRunning;
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

function bindPaneResizeHandles(): void {
  bindPaneResizer(elements.leftPaneResizer, "left");
  bindPaneResizer(elements.rightPaneResizer, "right");
  applyPaneWidths();
}

function bindPaneResizer(handle: HTMLElement, side: "left" | "right"): void {
  handle.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    handle.setPointerCapture(event.pointerId);
    const startX = event.clientX;
    const startWidth = side === "left" ? framesPaneWidth : botPaneWidth;

    const onPointerMove = (moveEvent: PointerEvent): void => {
      const delta = moveEvent.clientX - startX;
      if (side === "left") {
        framesPaneWidth = clampBetween(startWidth + delta, 170, 420);
      } else {
        botPaneWidth = clampBetween(startWidth - delta, 260, 560);
      }
      applyPaneWidths();
    };

    const stopResize = (upEvent: PointerEvent): void => {
      if (handle.hasPointerCapture(upEvent.pointerId)) {
        handle.releasePointerCapture(upEvent.pointerId);
      }
      handle.removeEventListener("pointermove", onPointerMove);
      handle.removeEventListener("pointerup", stopResize);
      handle.removeEventListener("pointercancel", stopResize);
    };

    handle.addEventListener("pointermove", onPointerMove);
    handle.addEventListener("pointerup", stopResize);
    handle.addEventListener("pointercancel", stopResize);
  });
}

function applyPaneWidths(): void {
  elements.workspacePanel.style.setProperty("--frames-pane-width", `${framesPaneWidth}px`);
  elements.workspacePanel.style.setProperty("--bot-pane-width", `${botPaneWidth}px`);
}

function clampBetween(value: number, min: number, max: number): number {
  return Math.round(Math.min(max, Math.max(min, value)));
}

function postToPlugin(message: UiToMainMessage): void {
  parent.postMessage({ pluginMessage: message }, "*");
}

function notifyPlugin(message: string, timeout?: number): void {
  postToPlugin({ type: "NOTIFY", payload: { message, timeout } });
}

function closePlugin(): void {
  postToPlugin({ type: "CLOSE_PLUGIN" });
}

function byId<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`Missing element #${id}`);
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
