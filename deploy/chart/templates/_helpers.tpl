{{- define "service.labels" -}}
app.kubernetes.io/name: {{ .Values.name }}
app.kubernetes.io/part-of: tempered-lab
tempered-lab/stage: {{ required "stage is required" .Values.stage }}
{{- end }}
{{- define "service.selector" -}}
app.kubernetes.io/name: {{ .Values.name }}
{{- end }}
