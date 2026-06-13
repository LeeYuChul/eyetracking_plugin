# AI UX Flow Validation Figma Plugin

Figma에서 선택한 모바일 UI Flow 프레임을 PNG로 export한 뒤 stateless FastAPI 서버로 전송하고, Flow Tree, Heatmap, Scanpath, Memory Blur, UX 평가 답변을 플러그인에서 확인하는 MVP 플러그인입니다.

## Development

```bash
npm install
npm run build
```

Figma Desktop에서 `manifest.json`을 import하면 됩니다. 개발 중에는 `npm run dev`로 `dist/`를 watch build할 수 있습니다.

## API

분석 서버 기본 URL은 `https://eyetrack.teamnewlarn.ai.kr`입니다.

- `GET /api/v1/health`
- `POST /api/v1/flow/analyze`
- `POST /api/v1/flow/prepare-target`
- `POST /api/v1/ux/chat`
- `POST /api/v1/ux/chat/heuristic`

서버는 분석 결과를 저장하지 않으며, 플러그인이 `analysis_bundle`, target별 `target_result`, UX chat history를 `figma.clientStorage`에 저장합니다.
