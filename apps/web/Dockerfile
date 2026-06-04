# D3：web 镜像。多阶段——Node 构建 SPA → nginx 提供静态资源 + 反代 /api 到 go-server。
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM nginx:1.27-alpine
# /api 反代上游由 helm 经 GO_SERVER_UPSTREAM 注入；NGINX_ENVSUBST_FILTER 限定只替换该变量，
# 不动 nginx 自身的 $host/$uri 等。
ENV GO_SERVER_UPSTREAM="localhost:8081" \
    NGINX_ENVSUBST_FILTER="GO_SERVER_UPSTREAM"
COPY nginx.conf /etc/nginx/templates/default.conf.template
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
