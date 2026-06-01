// Kubernetes 实集群采集（client-go）。
//
// 支持两种连接方式：
//   - in-cluster：Agent 以 Pod 形式运行时自动用 ServiceAccount
//   - kubeconfig：本地/容器挂载 kubeconfig（KUBECONFIG 或 ~/.kube/config）
//
// 采集 Pod / Deployment / Service / Event，映射为与后端 k8s_resources、
// 前端 KubernetesPage 字段对齐的快照结构。
package main

import (
	"context"
	"fmt"
	"sort"
	"strings"
	"time"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
	"k8s.io/client-go/tools/clientcmd"
)

type kubeCollector struct {
	clientset *kubernetes.Clientset
}

// newKubeCollector 按 in-cluster → kubeconfig 顺序尝试建立连接。
func newKubeCollector(kubeconfigPath string) (*kubeCollector, error) {
	cfg, err := rest.InClusterConfig()
	if err != nil {
		// 非集群内：回退 kubeconfig。
		loadingRules := clientcmd.NewDefaultClientConfigLoadingRules()
		if kubeconfigPath != "" {
			loadingRules.ExplicitPath = kubeconfigPath
		}
		cfg, err = clientcmd.NewNonInteractiveDeferredLoadingClientConfig(
			loadingRules, &clientcmd.ConfigOverrides{}).ClientConfig()
		if err != nil {
			return nil, fmt.Errorf("load kubeconfig: %w", err)
		}
	}
	cfg.Timeout = 8 * time.Second
	clientset, err := kubernetes.NewForConfig(cfg)
	if err != nil {
		return nil, fmt.Errorf("build clientset: %w", err)
	}
	return &kubeCollector{clientset: clientset}, nil
}

// collectPods 列举全 namespace 的 Pod，映射为快照。
func (k *kubeCollector) collectPods(ctx context.Context) ([]podSnapshot, error) {
	list, err := k.clientset.CoreV1().Pods("").List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, err
	}
	pods := make([]podSnapshot, 0, len(list.Items))
	for i := range list.Items {
		p := &list.Items[i]
		pods = append(pods, podSnapshot{
			Namespace: p.Namespace,
			Name:      p.Name,
			Phase:     string(p.Status.Phase),
			Ready:     readyString(p),
			Restarts:  totalRestarts(p),
			PodIP:     p.Status.PodIP,
			Node:      p.Spec.NodeName,
			Component: guessComponent(p),
		})
	}
	sort.Slice(pods, func(i, j int) bool {
		if pods[i].Namespace != pods[j].Namespace {
			return pods[i].Namespace < pods[j].Namespace
		}
		return pods[i].Name < pods[j].Name
	})
	return pods, nil
}

// collectDeployments 列举 Deployment 摘要。
func (k *kubeCollector) collectDeployments(ctx context.Context) ([]deploymentSnapshot, error) {
	list, err := k.clientset.AppsV1().Deployments("").List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, err
	}
	out := make([]deploymentSnapshot, 0, len(list.Items))
	for i := range list.Items {
		d := &list.Items[i]
		out = append(out, deploymentSnapshot{
			Namespace: d.Namespace,
			Name:      d.Name,
			Ready:     fmt.Sprintf("%d/%d", d.Status.ReadyReplicas, d.Status.Replicas),
			Available: int(d.Status.AvailableReplicas),
			Desired:   int(d.Status.Replicas),
			Image:     primaryImage(d.Spec.Template.Spec.Containers),
		})
	}
	return out, nil
}

// collectEvents 列举最近的 Warning/Normal 事件。
func (k *kubeCollector) collectEvents(ctx context.Context, limit int) ([]eventSnapshot, error) {
	list, err := k.clientset.CoreV1().Events("").List(ctx, metav1.ListOptions{Limit: int64(limit)})
	if err != nil {
		return nil, err
	}
	out := make([]eventSnapshot, 0, len(list.Items))
	for i := range list.Items {
		e := &list.Items[i]
		out = append(out, eventSnapshot{
			Namespace:    e.Namespace,
			ResourceKind: e.InvolvedObject.Kind,
			ResourceName: e.InvolvedObject.Name,
			Reason:       e.Reason,
			Message:      e.Message,
			Type:         e.Type,
			EventTime:    eventTimestamp(e),
		})
	}
	// 最新在前。
	sort.Slice(out, func(i, j int) bool { return out[i].EventTime > out[j].EventTime })
	return out, nil
}

// ---- 辅助 ----

func readyString(p *corev1.Pod) string {
	ready := 0
	for _, cs := range p.Status.ContainerStatuses {
		if cs.Ready {
			ready++
		}
	}
	return fmt.Sprintf("%d/%d", ready, len(p.Status.ContainerStatuses))
}

func totalRestarts(p *corev1.Pod) int {
	total := 0
	for _, cs := range p.Status.ContainerStatuses {
		total += int(cs.RestartCount)
	}
	return total
}

// guessComponent 从 namespace / label / 名称推断组件类别，方便前端归类。
func guessComponent(p *corev1.Pod) string {
	name := strings.ToLower(p.Name)
	switch {
	case strings.Contains(name, "vllm") || strings.Contains(name, "qwen"):
		return "vllm"
	case strings.Contains(p.Namespace, "aibrix"):
		return "aibrix"
	case strings.Contains(p.Namespace, "envoy"):
		return "gateway"
	case strings.Contains(name, "redis"):
		return "redis"
	case strings.Contains(name, "prometheus") || strings.Contains(name, "cadvisor"):
		return "observability"
	case p.Namespace == "kube-system":
		return "system"
	default:
		return p.Namespace
	}
}

func primaryImage(containers []corev1.Container) string {
	if len(containers) == 0 {
		return ""
	}
	return containers[0].Image
}

func eventTimestamp(e *corev1.Event) string {
	if !e.LastTimestamp.IsZero() {
		return e.LastTimestamp.UTC().Format(time.RFC3339)
	}
	if !e.EventTime.IsZero() {
		return e.EventTime.UTC().Format(time.RFC3339)
	}
	return e.CreationTimestamp.UTC().Format(time.RFC3339)
}
