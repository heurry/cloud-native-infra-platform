# 迁移期 legacy Python 单体（src/api，:8088）——Phase 5 / 5A.4 起容器化纳入 compose。
#
# 复用已构建缓存的 twf-ai-service:dev 作为基础镜像（含 fastapi/uvicorn/pydantic/requests/pyyaml），
# 在受限网络下避免拉取 python 基础镜像或 pip 安装。src/ 中未引用 transformers/sentencepiece/torch
# （requirements.txt 里那几项是离线训练遗留、API 不需要），故无需额外装包。
#
# 构建上下文 = 仓库根（需 src/ + configs/app/）；构建：
#   docker build -f deploy/compose/legacy-python.Dockerfile -t twf-legacy-python:dev .
FROM twf-ai-service:dev

WORKDIR /app

# 仅拷贝单体运行所需：src 包 + 它读取的两个 config。
COPY src/ ./src/
COPY configs/app/ ./configs/app/

ENV CUSTOMER_SUPPORT_API_CONFIG=configs/app/customer_support_api.yaml \
    SERVICE_INSTANCES_CONFIG=configs/app/service_instances.yaml \
    PYTHONUNBUFFERED=1

# SQLite 库（runs/app/customer_support.db）由 compose 以卷挂载到 /app/runs/app，
# 以便复用宿主既有数据并持久化。
EXPOSE 8088
CMD ["uvicorn", "src.api.main:app", "--host", "0.0.0.0", "--port", "8088"]
