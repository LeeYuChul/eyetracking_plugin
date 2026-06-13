export const PLUGIN_VERSION = "0.2.0";

export const DEFAULT_API_BASE_URL = "https://eyetrack.newlearn.ai.kr";

export const MOBILE_FRAME_LIMITS = {
  minWidth: 320,
  maxWidth: 540,
  minHeight: 568,
  maxHeight: 1200
};

export const PLUGIN_WINDOW_LIMITS = {
  minWidth: 520,
  minHeight: 640
};

export const MAX_FRAME_COUNT = 15;
export const STORAGE_KEY = "ai_ux_flow_validation_current_session";

export type ExportScale = 1 | 2;
export type SelectionStatus = "valid" | "warning" | "invalid";
export type AppStage =
  | "idle"
  | "exporting"
  | "uploading"
  | "analyzing"
  | "saving_local"
  | "ready"
  | "preparing_target"
  | "evaluating_ux"
  | "error";

export type ViewMode =
  | "original"
  | "heatmap"
  | "scanpath"
  | "memory_blur"
  | "heatmap_overlay"
  | "scanpath_overlay"
  | "full_overlay";

export type ChatEndpointMode = "vlm" | "heuristic";

export interface FrameInfo {
  id: string;
  clientFrameId: string;
  fileKey: string;
  name: string;
  width: number;
  height: number;
  orderIndex: number;
}

export interface SelectionInfo {
  status: SelectionStatus;
  canAnalyze: boolean;
  frames: FrameInfo[];
  message: string;
  warnings: string[];
}

export interface ExportedFramePayload {
  frame: FrameInfo;
  exportScale: ExportScale;
  bytes: Uint8Array;
}

export interface ExportedFlowPayload {
  frames: ExportedFramePayload[];
  exportScale: ExportScale;
}

export interface WarningItem {
  code: string;
  message: string;
  client_frame_ids: string[];
}

export interface ParsedFrame {
  client_frame_id: string;
  frame_name: string;
  flow_id: string | null;
  depth: number | null;
  state: number | null;
  screen_name: string | null;
  parse_status: "parsed" | "unparsed";
  order_index: number;
}

export interface FlowFrameNode {
  client_frame_id: string;
  frame_name: string;
  depth: number | null;
  state: number | null;
  screen_name: string | null;
  children: FlowFrameNode[];
}

export interface FlowGroup {
  flow_id: string;
  frames: FlowFrameNode[];
  ordered_frame_ids: string[];
}

export interface FlowTree {
  flows: FlowGroup[];
  unparsed_frame_ids: string[];
  ordered_frame_ids: string[];
}

export interface VisualArtifact {
  artifact_type: string;
  mime_type: string;
  base64: string;
  width: number;
  height: number;
  encoding: "base64" | "data_url";
}

export interface FixationPoint {
  index: number;
  x: number;
  y: number;
  score: number;
}

export interface FrameMetrics {
  scanpath_length: number;
  fixation_count: number;
  attention_entropy: number;
  visual_complexity: number;
  fixations: FixationPoint[];
}

export interface FrameAnalysisResult {
  client_frame_id: string;
  figma_node_id?: string;
  frame_name: string;
  parsed: ParsedFrame;
  width: number;
  height: number;
  order_index: number;
  metrics: FrameMetrics;
  artifacts: Record<string, VisualArtifact>;
}

export interface AnalysisBundle {
  analysis_bundle_id: string;
  created_at: string;
  storage_policy: string;
  flow_tree: FlowTree;
  frames: FrameAnalysisResult[];
  warnings: WarningItem[];
  model_info: {
    heatmap_model: string;
    heatmap_version: string;
    heatmap_backend: string;
    scanpath_model: string;
  };
}

export interface TargetFrameResult {
  client_frame_id: string;
  temporal_distance: number;
  memory_metrics: {
    estimated_retention: number;
    blur_strength_avg: number;
    temporal_distance: number;
    depth_blur_strength?: number | null;
    cumulative_blur_strength?: number | null;
  };
  artifacts: Record<string, VisualArtifact>;
}

export interface TargetResult {
  target_result_id: string;
  target_frame_id: string;
  path_frame_ids: string[];
  frames: TargetFrameResult[];
  memory_model_options: Record<string, unknown>;
  created_at: string;
}

export interface UxAnswer {
  conclusion: string;
  reasoning_summary: string[];
  evidence_frames: string[];
  risk_level: "low" | "medium" | "high";
  recommendations: string[];
  confidence: "low" | "medium" | "high";
  caveat: string;
}

export interface UxEvaluationResponse {
  answer: UxAnswer;
  storage_policy: string;
  provider: string;
  model: string;
}

export type UxStreamEventType = "progress" | "thinking" | "final" | "error";

export interface UxStreamEvent {
  event: UxStreamEventType;
  data: Record<string, unknown>;
}

export interface ChatEntry {
  question: string;
  answer: UxAnswer;
  provider: string;
  model: string;
  created_at: string;
}

export interface LocalSession {
  local_session_id: string;
  analysis_bundle: AnalysisBundle;
  target_results: Record<string, TargetResult>;
  chat_history: ChatEntry[];
  last_opened_at: string;
}

export type MainToUiMessage =
  | { type: "SELECTION_INFO"; payload: SelectionInfo }
  | { type: "EXPORT_STARTED"; payload: { exportScale: ExportScale; frameCount: number } }
  | { type: "EXPORT_SUCCESS"; payload: ExportedFlowPayload }
  | { type: "EXPORT_FAILED"; payload: { message: string } }
  | { type: "STORAGE_LOADED"; payload: { session: LocalSession | null } }
  | { type: "STORAGE_SAVED"; payload: { session: LocalSession } }
  | { type: "STORAGE_CLEARED" }
  | { type: "ERROR"; payload: { message: string; source?: "server" | "storage" | "plugin" } };

export type UiToMainMessage =
  | { type: "RUN_ANALYSIS"; payload: { exportScale: ExportScale } }
  | { type: "REFRESH_SELECTION" }
  | { type: "LOAD_SESSION" }
  | { type: "SAVE_SESSION"; payload: { session: LocalSession } }
  | { type: "CLEAR_CURRENT_SESSION" }
  | { type: "CLEAR_ALL_SESSIONS" }
  | { type: "RESIZE_PLUGIN"; payload: { width: number; height: number } }
  | { type: "CLOSE_PLUGIN" };
