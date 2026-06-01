kubectl apply -f https://github.com/vllm-project/aibrix/releases/download/v0.6.0/aibrix-dependency-v0.6.0.yaml --server-side

kubectl apply -f https://github.com/vllm-project/aibrix/releases/download/v0.6.0/aibrix-core-v0.6.0.yaml

kubectl get pods -n aibrix-system -w