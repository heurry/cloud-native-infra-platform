{{/* 名称与标签 helpers */}}
{{- define "cip.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "cip.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s" (include "cip.name" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{- define "cip.labels" -}}
app.kubernetes.io/name: {{ include "cip.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version }}
{{- end -}}

{{/* 某组件的 selector labels：component 由调用方以 dict 传入 */}}
{{- define "cip.selectorLabels" -}}
app.kubernetes.io/name: {{ include "cip.name" .root }}
app.kubernetes.io/instance: {{ .root.Release.Name }}
app.kubernetes.io/component: {{ .component }}
{{- end -}}

{{- define "cip.serviceAccountName" -}}
{{- printf "%s-go-server" (include "cip.fullname" .) -}}
{{- end -}}

{{/* go-server 的 DATABASE_URL：自带 postgres 时用其 service，否则用 external.url */}}
{{- define "cip.databaseURL" -}}
{{- if .Values.postgres.enabled -}}
{{- printf "postgres://%s:%s@%s-postgres:%d/%s?sslmode=disable" .Values.postgres.auth.user .Values.postgres.auth.password (include "cip.fullname" .) (int .Values.postgres.service.port) .Values.postgres.auth.database -}}
{{- else -}}
{{- required "postgres.enabled=false 时必须设置 postgres.external.url" .Values.postgres.external.url -}}
{{- end -}}
{{- end -}}
