// D4 负载基线（真实栈）：对 go-server 控制面关键只读路径压测，固化 p95 / 错误率门槛。
// 进程内的回归护栏见 server/internal/httpx/load_test.go；本脚本面向真实编排（compose/helm）的端到端负载。
//
// 用法（需本机装 k6：https://k6.io/docs/get-started/installation/）：
//   先起栈：docker compose -f deploy/compose/docker-compose.yml up -d
//   再压测：BASE_URL=http://localhost:8081 k6 run deploy/load/k6-baseline.js
//   阈值未达标时 k6 以非零码退出，可直接接入流水线。
import http from "k6/http";
import { check, sleep } from "k6";

const BASE = __ENV.BASE_URL || "http://localhost:8081";

export const options = {
  scenarios: {
    baseline: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: [
        { duration: "15s", target: 20 }, // 爬坡
        { duration: "30s", target: 20 }, // 稳态
        { duration: "10s", target: 0 },  // 收尾
      ],
    },
  },
  thresholds: {
    http_req_failed: ["rate<0.01"],     // 错误率 < 1%
    http_req_duration: ["p(95)<800"],   // p95 < 800ms（控制面只读路径）
  },
};

// 关键只读路径（无副作用，安全反复压测）。
const PATHS = [
  "/api/health",
  "/api/platform/overview", // cache-aside（命中 Redis 时极快）
  "/api/service-instances",
  "/api/metrics/current",
];

export default function () {
  const path = PATHS[Math.floor(Math.random() * PATHS.length)];
  const res = http.get(`${BASE}${path}`);
  check(res, { "status is 200": (r) => r.status === 200 });
  sleep(0.2);
}
