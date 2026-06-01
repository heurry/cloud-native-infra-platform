# CloudNative Infra Platform AI service —— 独立可部署的 FastAPI。
FROM python:3.11-slim

WORKDIR /app

# 先装依赖以利用 Docker 层缓存。
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# 再拷源码。
COPY aiservice ./aiservice
COPY app.py ./

EXPOSE 8200
ENV AI_SERVICE_HOST=0.0.0.0 \
    AI_SERVICE_PORT=8200

CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8200"]
