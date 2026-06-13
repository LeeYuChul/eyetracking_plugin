# Eye Tracking Heatmap Figma Plugin

Figma에서 선택한 모바일 UI 프레임을 PNG로 export한 뒤 분석 서버로 전송하고, 예측 히트맵과 UX 리포트를 플러그인 팝업에서 확인하는 MVP 플러그인입니다.

## Development

```bash
npm install
npm run build
```

Figma Desktop에서 `manifest.json`을 import하면 됩니다. 개발 중에는 `npm run dev`로 `dist/`를 watch build할 수 있습니다.

## API

분석 서버는 Swagger 문서 기준 공개 API인 `https://eyetrack.newlearn.ai.kr`입니다.

- `GET /api/v1/health`
- `POST /api/v1/analyses`

Swagger에는 polling endpoint가 공개되어 있지 않으므로, 플러그인은 생성 응답에 `job_id`가 있고 완료 결과가 없을 때만 `GET /api/v1/analyses/{job_id}` polling을 시도합니다.
