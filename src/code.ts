import {
  ExportScale,
  FrameInfo,
  MainToUiMessage,
  MOBILE_FRAME_LIMITS,
  PLUGIN_WINDOW_LIMITS,
  SelectionInfo,
  UiToMainMessage
} from "./types";

figma.showUI(__html__, {
  width: 420,
  height: 680,
  themeColors: true
});

function postToUi(message: MainToUiMessage): void {
  figma.ui.postMessage(message);
}

function roundDimension(value: number): number {
  return Math.round(value * 100) / 100;
}

function frameToInfo(frame: FrameNode): FrameInfo {
  return {
    id: frame.id,
    name: frame.name,
    width: roundDimension(frame.width),
    height: roundDimension(frame.height)
  };
}

function validateSelection(): SelectionInfo {
  const selection = figma.currentPage.selection;

  if (selection.length === 0) {
    return {
      status: "invalid",
      canAnalyze: false,
      frame: null,
      message: "분석할 모바일 프레임을 1개 선택해주세요.",
      warnings: []
    };
  }

  if (selection.length > 1) {
    return {
      status: "invalid",
      canAnalyze: false,
      frame: null,
      message: "MVP에서는 한 번에 1개의 프레임만 분석할 수 있습니다.",
      warnings: []
    };
  }

  const node = selection[0];
  if (node.type !== "FRAME") {
    return {
      status: "invalid",
      canAnalyze: false,
      frame: null,
      message: "선택한 객체는 Frame이 아닙니다. Frame을 선택해주세요.",
      warnings: []
    };
  }

  const frame = node as FrameNode;
  const frameInfo = frameToInfo(frame);

  if (frameInfo.width <= 0 || frameInfo.height <= 0) {
    return {
      status: "invalid",
      canAnalyze: false,
      frame: frameInfo,
      message: "프레임의 너비와 높이는 0보다 커야 합니다.",
      warnings: []
    };
  }

  if (!frame.visible) {
    return {
      status: "invalid",
      canAnalyze: false,
      frame: frameInfo,
      message: "숨겨진 프레임은 분석할 수 없습니다.",
      warnings: []
    };
  }

  const warnings: string[] = [];
  if (
    frameInfo.width < MOBILE_FRAME_LIMITS.minWidth ||
    frameInfo.width > MOBILE_FRAME_LIMITS.maxWidth
  ) {
    warnings.push(
      `권장 모바일 너비는 ${MOBILE_FRAME_LIMITS.minWidth}-${MOBILE_FRAME_LIMITS.maxWidth}px입니다.`
    );
  }

  if (
    frameInfo.height < MOBILE_FRAME_LIMITS.minHeight ||
    frameInfo.height > MOBILE_FRAME_LIMITS.maxHeight
  ) {
    warnings.push(
      `권장 모바일 높이는 ${MOBILE_FRAME_LIMITS.minHeight}-${MOBILE_FRAME_LIMITS.maxHeight}px입니다.`
    );
  }

  return {
    status: warnings.length > 0 ? "warning" : "valid",
    canAnalyze: true,
    frame: frameInfo,
    message:
      warnings.length > 0
        ? "모바일 권장 크기를 벗어났지만 분석을 실행할 수 있습니다."
        : "선택된 프레임을 분석할 수 있습니다.",
    warnings
  };
}

function sendSelectionInfo(): void {
  postToUi({
    type: "SELECTION_INFO",
    payload: validateSelection()
  });
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

async function exportSelectedFrame(exportScale: ExportScale): Promise<void> {
  const selection = validateSelection();

  if (!selection.canAnalyze || !selection.frame) {
    postToUi({
      type: "ERROR",
      payload: {
        message: selection.message
      }
    });
    return;
  }

  const selectedNode = figma.currentPage.selection[0];
  if (!selectedNode || selectedNode.type !== "FRAME") {
    postToUi({
      type: "ERROR",
      payload: {
        message: "선택한 객체는 Frame이 아닙니다. Frame을 선택해주세요."
      }
    });
    return;
  }

  postToUi({
    type: "EXPORT_STARTED",
    payload: {
      exportScale
    }
  });

  try {
    const bytes = await selectedNode.exportAsync({
      format: "PNG",
      constraint: {
        type: "SCALE",
        value: exportScale
      }
    });

    postToUi({
      type: "EXPORT_SUCCESS",
      payload: {
        frame: selection.frame,
        exportScale,
        bytes
      }
    });
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "프레임 이미지를 변환하지 못했습니다.";

    postToUi({
      type: "EXPORT_FAILED",
      payload: {
        message: `프레임 이미지를 변환하지 못했습니다. ${message}`
      }
    });
  }
}

figma.ui.onmessage = (message: UiToMainMessage) => {
  if (message.type === "RUN_ANALYSIS") {
    void exportSelectedFrame(message.payload.exportScale);
    return;
  }

  if (message.type === "REFRESH_SELECTION") {
    sendSelectionInfo();
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
