package httpx

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/heurry/cloudnative-infra-platform/server/internal/auth"
)

// router 装上 Authn+Authz，挂一个读 + 写测试路由 + 放行的 /auth/me。
func authTestRouter(a *API) *chi.Mux {
	r := chi.NewRouter()
	r.Use(a.Authn)
	r.Use(a.Authz)
	r.Get("/api/x", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) })
	r.Post("/api/x", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) })
	r.Get("/api/auth/me", a.me)
	return r
}

func code(r *chi.Mux, method, path, token string) int {
	req := httptest.NewRequest(method, path, nil)
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	rr := httptest.NewRecorder()
	r.ServeHTTP(rr, req)
	return rr.Code
}

func TestAuthzEnabledGatesByRole(t *testing.T) {
	iss := auth.NewIssuer("secret", time.Hour)
	r := authTestRouter(&API{AuthEnabled: true, Auth: iss})
	viewer, _ := iss.Issue("v", auth.RoleViewer)
	operator, _ := iss.Issue("o", auth.RoleOperator)

	if c := code(r, http.MethodGet, "/api/x", ""); c != http.StatusUnauthorized {
		t.Fatalf("no-token read: want 401, got %d", c)
	}
	if c := code(r, http.MethodGet, "/api/x", viewer); c != http.StatusOK {
		t.Fatalf("viewer read: want 200, got %d", c)
	}
	if c := code(r, http.MethodPost, "/api/x", viewer); c != http.StatusForbidden {
		t.Fatalf("viewer write: want 403, got %d", c)
	}
	if c := code(r, http.MethodPost, "/api/x", operator); c != http.StatusOK {
		t.Fatalf("operator write: want 200, got %d", c)
	}
	// /auth/me 始终放行（便于前端引导），无 token 也 200。
	if c := code(r, http.MethodGet, "/api/auth/me", ""); c != http.StatusOK {
		t.Fatalf("auth/me allowlisted: want 200, got %d", c)
	}
	// 无效 token → 视为未认证。
	if c := code(r, http.MethodGet, "/api/x", "garbage.token.here"); c != http.StatusUnauthorized {
		t.Fatalf("bad token read: want 401, got %d", c)
	}
}

func TestAuthzDisabledIsOpen(t *testing.T) {
	r := authTestRouter(&API{AuthEnabled: false, Auth: auth.NewIssuer("secret", time.Hour)})
	if c := code(r, http.MethodPost, "/api/x", ""); c != http.StatusOK {
		t.Fatalf("auth disabled write without token: want 200, got %d", c)
	}
}
