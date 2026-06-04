package auth

import (
	"crypto/subtle"
	"strings"
)

// Credential 是一个演示用户（明文口令来自环境变量）。
// 说明：这是 demo 级认证（口令在 env）；生产应换 OIDC / 真实用户库 + 口令哈希。
type Credential struct {
	Password string
	Role     string
}

// ParseUsers 解析 AUTH_USERS（"user:pass:role,user2:pass2:role2"）；空则给默认演示三件套。
func ParseUsers(raw string) map[string]Credential {
	out := map[string]Credential{}
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return map[string]Credential{
			"admin":    {Password: "admin", Role: RoleAdmin},
			"operator": {Password: "operator", Role: RoleOperator},
			"viewer":   {Password: "viewer", Role: RoleViewer},
		}
	}
	for _, item := range strings.Split(raw, ",") {
		p := strings.SplitN(strings.TrimSpace(item), ":", 3)
		if len(p) == 3 && p[0] != "" {
			out[p[0]] = Credential{Password: p[1], Role: normalizeRole(p[2])}
		}
	}
	return out
}

// Authenticate 校验用户名/口令；成功返回主体。常量时间比较口令。
func Authenticate(dir map[string]Credential, username, password string) (*User, bool) {
	c, ok := dir[username]
	if !ok {
		return nil, false
	}
	if subtle.ConstantTimeCompare([]byte(c.Password), []byte(password)) != 1 {
		return nil, false
	}
	return &User{Subject: username, Role: c.Role}, true
}
