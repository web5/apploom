# 端口约定

AppLoom 在本机会同时跑两类服务：**平台自己的服务**（Studio、API、Redis、Postgres）和**平台生成并部署的产物站点**（每条流水线一个 dev server）。端口按下表划分，互不重叠。

## 端口全景

| 端口 | 谁用 | 说明 |
| --- | --- | --- |
| 3000 | Studio（`apps/web`，Next dev） | 固定，`pnpm --filter web dev` |
| 3001 | API（`apps/api`） | `PORT` 环境变量可改 |
| 6379 | Redis | BullMQ 队列 / 可选的文档存储；`REDIS_PORT` |
| 5432 | Postgres | 文档与执行记录；端口取自 `DATABASE_URL` |
| **18000 – 18199** | **产物站点（预览）** | 平台分配，见下 |
| 5000 / 7000 | macOS「AirPlay 接收器」 | 系统占用，不要用（可在系统设置 → 通用 → 隔空播放与接力里关掉） |

## 产物站点端口怎么分配

- 起点：`DEPLOY_BASE_PORT`，默认 **18000**，向上扫描 200 个端口。
- **由平台分配，不由模型决定**：部署阶段从起点起找第一个空闲端口，通过环境变量 `PORT` 交给 dev server。部署 Agent 输出里的 `port` 字段只是占位，不会被采用。
- 生成的代码被要求读取 `PORT`、缺省 18000（codegen 提示词里的约束）。即使它没读 `PORT`，平台仍以 dev server 打印出来的真实 URL 为准，并把真实端口记入部署结果。
- **只终止「同一条流水线」自己上一次部署的 dev server**（进程 cwd 在 `/tmp/apploom-deploy/{docId}/` 下），并复用它的端口。别人的预览、系统服务、开发者自己的服务一律不碰，也不再弹「终止进程」的审批。
- 判定「被占用」：只看**监听者**（`lsof -sTCP:LISTEN`），连着该端口的浏览器等客户端不算；lsof 看不到的进程再用绑定探测兜底。
- 硬性跳过平台自己的端口（`reservedPorts()`：3000、3001、`PORT`、Redis、数据库、`SANDBOX_DENY_PORTS`），即使有人把 `DEPLOY_BASE_PORT` 配得很低也不会分到。
- 实现：`apps/api/src/deploy/local-deploy.service.ts` 的 `allocatePort` / `deployBasePort` / `reservedPorts`；测试 `allocate-port.spec.ts` 用真实监听进程覆盖（含对照实验）。

## 为什么选 18000

- **低于 32768**：Linux 临时端口区是 32768 起、macOS 是 49152 起，系统会把这些端口随机分给出站连接，预览可能撞上。
- **高于 10000、避开 3000–9999**：这一段是各种开发服务和常驻服务的聚集区（3000 系前端、5000 AirPlay / Flask、8000–9999 的 Nginx / 后台 / Elasticsearch 等），本机实测已有大量占用。
- **不在 Chrome 的禁用端口名单里**（如 6000、6665–6669、10080 等，浏览器会直接拒绝访问）。
- 2026-10-20 实测本机 18000–18199 无任何监听。
- 之前试过 5000 和 7000：都被 macOS 的 AirPlay（ControlCenter）占着，会触发「终止系统进程」的审批，所以放弃。

## 常见问题

- **想换起点**：设 `DEPLOY_BASE_PORT`（1024–65000）。换的时候留意别落在上面几类区间里。
- **预览端口被占满**：窗口只有 200 个；清理旧部署（它们是 detached 进程，API 停掉后仍在跑，目前没有 stop 接口）或加大窗口（`PORT_SCAN`）。
- **多用户 / 远程访问**：`localhost:端口` 对别人打不开，开 `PREVIEW_BASE_DOMAIN` 走反向代理，用 `http://<docId>.<域名>/` 访问；代理的上游仍是这里分配的端口。
- **容器沙箱模式**（`SANDBOX_MODE=container`）：容器内端口默认不对宿主开放，目前部署阶段会明确失败，待做「端口发布 + 反向代理」。
