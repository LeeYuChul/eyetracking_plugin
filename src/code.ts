import {
  ExportScale,
  FrameInfo,
  MainToUiMessage,
  MAX_FRAME_COUNT,
  MOBILE_FRAME_LIMITS,
  PLUGIN_WINDOW_LIMITS,
  SelectionInfo,
  STORAGE_KEY,
  UiToMainMessage
} from "./types";

figma.showUI(__html__, {
  width: 1080,
  height: 840,
  themeColors: true
});

function postToUi(message: MainToUiMessage): void {
  figma.ui.postMessage(message);
}

function roundDimension(value: number): number {
  return Math.round(value * 100) / 100;
}

function sanitizeKey(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]/g, "_");
}

function frameToInfo(frame: FrameNode, orderIndex: number): FrameInfo {
  const clientFrameId = `local_${sanitizeKey(frame.id)}`;
  return {
    id: frame.id,
    clientFrameId,
    fileKey: `${clientFrameId}_${orderIndex}`,
    name: frame.name,
    width: roundDimension(frame.width),
    height: roundDimension(frame.height),
    orderIndex
  };
}

function validateSelection(): SelectionInfo {
  const selection = figma.currentPage.selection;

  if (selection.length === 0) {
    return {
      status: "invalid",
      canAnalyze: false,
      frames: [],
      message: "분석할 Frame을 선택해주세요.",
      warnings: []
    };
  }

  if (selection.length > MAX_FRAME_COUNT) {
    return {
      status: "invalid",
      canAnalyze: false,
      frames: [],
      message: `한 번에 최대 ${MAX_FRAME_COUNT}개 Frame까지 분석할 수 있습니다.`,
      warnings: []
    };
  }

  const frames: FrameInfo[] = [];
  const warnings: string[] = [];

  for (const [index, node] of selection.entries()) {
    if (node.type !== "FRAME") {
      return {
        status: "invalid",
        canAnalyze: false,
        frames,
        message: "선택 항목에는 Frame만 포함되어야 합니다.",
        warnings
      };
    }

    const frame = node as FrameNode;
    const info = frameToInfo(frame, index);
    frames.push(info);

    if (!frame.visible) {
      warnings.push(`${frame.name}: 숨겨진 Frame입니다.`);
    }
    if (info.width <= 0 || info.height <= 0) {
      return {
        status: "invalid",
        canAnalyze: false,
        frames,
        message: "Frame의 너비와 높이는 0보다 커야 합니다.",
        warnings
      };
    }
    if (info.width < MOBILE_FRAME_LIMITS.minWidth || info.width > MOBILE_FRAME_LIMITS.maxWidth) {
      warnings.push(`${frame.name}: 권장 모바일 너비를 벗어났습니다.`);
    }
    if (info.height < MOBILE_FRAME_LIMITS.minHeight || info.height > MOBILE_FRAME_LIMITS.maxHeight) {
      warnings.push(`${frame.name}: 권장 모바일 높이를 벗어났습니다.`);
    }
  }

  return {
    status: warnings.length > 0 ? "warning" : "valid",
    canAnalyze: frames.length > 0,
    frames,
    message: `${frames.length}개 Frame을 분석할 수 있습니다.`,
    warnings
  };
}

function sendSelectionInfo(): void {
  postToUi({ type: "SELECTION_INFO", payload: validateSelection() });
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function resizePlugin(width: number, height: number): void {
  figma.ui.resize(
    clamp(Math.round(width), PLUGIN_WINDOW_LIMITS.minWidth, PLUGIN_WINDOW_LIMITS.maxWidth),
    clamp(Math.round(height), PLUGIN_WINDOW_LIMITS.minHeight, PLUGIN_WINDOW_LIMITS.maxHeight)
  );
}

async function exportSelectedFrames(exportScale: ExportScale): Promise<void> {
  const selection = validateSelection();
  if (!selection.canAnalyze) {
    postToUi({ type: "ERROR", payload: { message: selection.message, source: "plugin" } });
    return;
  }

  postToUi({
    type: "EXPORT_STARTED",
    payload: { exportScale, frameCount: selection.frames.length }
  });

  try {
    const exported = [];
    for (const frameInfo of selection.frames) {
      const node = await figma.getNodeByIdAsync(frameInfo.id);
      if (!node || node.type !== "FRAME") {
        throw new Error(`${frameInfo.name} Frame을 찾을 수 없습니다.`);
      }
      const bytes = await node.exportAsync({
        format: "PNG",
        constraint: { type: "SCALE", value: exportScale }
      });
      exported.push({ frame: frameInfo, exportScale, bytes });
    }
    postToUi({ type: "EXPORT_SUCCESS", payload: { frames: exported, exportScale } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Frame export에 실패했습니다.";
    postToUi({ type: "EXPORT_FAILED", payload: { message } });
  }
}

async function loadSession(): Promise<void> {
  const session = await figma.clientStorage.getAsync(STORAGE_KEY);
  postToUi({ type: "STORAGE_LOADED", payload: { session: session || null } });
}

async function saveSession(message: Extract<UiToMainMessage, { type: "SAVE_SESSION" }>): Promise<void> {
  await figma.clientStorage.setAsync(STORAGE_KEY, message.payload.session);
  postToUi({ type: "STORAGE_SAVED", payload: { session: message.payload.session } });
}

async function clearSession(): Promise<void> {
  await figma.clientStorage.deleteAsync(STORAGE_KEY);
  postToUi({ type: "STORAGE_CLEARED" });
}

figma.ui.onmessage = (message: UiToMainMessage) => {
  if (message.type === "RUN_ANALYSIS") {
    void exportSelectedFrames(message.payload.exportScale);
    return;
  }
  if (message.type === "REFRESH_SELECTION") {
    sendSelectionInfo();
    return;
  }
  if (message.type === "LOAD_SESSION") {
    void loadSession().catch((error) => {
      postToUi({ type: "ERROR", payload: { message: String(error), source: "storage" } });
    });
    return;
  }
  if (message.type === "SAVE_SESSION") {
    void saveSession(message).catch((error) => {
      postToUi({ type: "ERROR", payload: { message: String(error), source: "storage" } });
    });
    return;
  }
  if (message.type === "CLEAR_CURRENT_SESSION" || message.type === "CLEAR_ALL_SESSIONS") {
    void clearSession().catch((error) => {
      postToUi({ type: "ERROR", payload: { message: String(error), source: "storage" } });
    });
    return;
  }
  if (message.type === "RESIZE_PLUGIN") {
    resizePlugin(message.payload.width, message.payload.height);
    return;
  }
  if (message.type === "CLOSE_PLUGIN") {
    figma.closePlugin();
  }
};

figma.on("selectionchange", sendSelectionInfo);
sendSelectionInfo();
void loadSession();
