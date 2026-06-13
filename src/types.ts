export const PLUGIN_VERSION = "0.1.0";

export const DEFAULT_API_BASE_URL = "https://eyetrack.newlearn.ai.kr";

export const API_BASE_OPTIONS = [
  {
    label: "Production",
    value: DEFAULT_API_BASE_URL
  }
] as const;

export const MOBILE_FRAME_LIMITS = {
  minWidth: 320,
  maxWidth: 540,
  minHeight: 568,
  maxHeight: 1200
};

export const PLUGIN_WINDOW_LIMITS = {
  minWidth: 360,
  maxWidth: 900,
  minHeight: 520,
  maxHeight: 1000
};

export type ExportScale = 1 | 2;

export type SelectionStatus = "valid" | "warning" | "invalid";

export interface FrameInfo {
  id: string;
  name: string;
  width: number;
  height: number;
}

export interface SelectionInfo {
  status: SelectionStatus;
  canAnalyze: boolean;
  frame: FrameInfo | null;
  message: string;
  warnings: string[];
}

export interface ExportedFramePayload {
  frame: FrameInfo;
  exportScale: ExportScale;
  bytes: Uint8Array;
}

export type AnalysisStage =
  | "idle"
  | "exporting"
  | "uploading"
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "timeout";

export interface ReportItem {
  title?: string;
  description: string;
  score?: number | string;
  location?: string;
}

export interface AnalysisResult {
  status: AnalysisStage | string;
  jobId?: string;
  overlayUrl?: string;
  summary?: string;
  hotspots: ReportItem[];
  issues: ReportItem[];
  recommendations: ReportItem[];
  completedAt?: string;
  raw: unknown;
}

export interface CreateAnalysisInput {
  apiBaseUrl: string;
  fileBytes: Uint8Array;
  frame: FrameInfo;
  exportScale: ExportScale;
  pluginVersion: string;
  modelName?: string;
  options?: Record<string, unknown>;
}

export type MainToUiMessage =
  | {
      type: "SELECTION_INFO";
      payload: SelectionInfo;
    }
  | {
      type: "EXPORT_STARTED";
      payload: {
        exportScale: ExportScale;
      };
    }
  | {
      type: "EXPORT_SUCCESS";
      payload: ExportedFramePayload;
    }
  | {
      type: "EXPORT_FAILED";
      payload: {
        message: string;
      };
    }
  | {
      type: "ERROR";
      payload: {
        message: string;
      };
    };

export type UiToMainMessage =
  | {
      type: "RUN_ANALYSIS";
      payload: {
        exportScale: ExportScale;
      };
    }
  | {
      type: "REFRESH_SELECTION";
    }
  | {
      type: "RESIZE_PLUGIN";
      payload: {
        width: number;
        height: number;
      };
    }
  | {
      type: "CLOSE_PLUGIN";
    };
